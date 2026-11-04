/**
 * Per-conversation message queue tests.
 *
 * The promise under test (Awais's request, 2026-09-22): a message sent to a
 * conversation that already has a run in flight is QUEUED, and when that run
 * completes the queued message executes automatically as a follow-up in the
 * SAME conversation. Messages to other conversations are unaffected — they
 * still get the one-at-a-time refusal while anything runs.
 *
 * The hard constraint: `runs_single_active_idx` allows ONE active run
 * globally, and its predicate includes 'queued'. A waiting message therefore
 * cannot be a 'queued' run row — it waits in the separate 'waiting' status,
 * outside the index, and is promoted only when the slot is provably free.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { acceptRun, drainQueue, type AcceptDeps } from './accept.js';
import { createConversation, finishRun, getActiveRun, getRun } from './runs.js';
import { peekDayTotal } from './budget.js';
import { loadConfig, type AppConfig } from './config.js';
import type { RunExecutor } from './executor.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM mission_steps');
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM budgets');
});

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'queue-access-key-for-tests';

function makeConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'key',
    ACCESS_KEY,
    SESSION_SECRET: SECRET,
    ENGINE: 'scripted',
    DAILY_RUN_BUDGET: '50',
  } as NodeJS.ProcessEnv);
}

/** Executor stub that records every run it was asked to start. */
function stubExecutor(started: string[]): RunExecutor {
  return {
    planMission: async () => [],
    start: (run: { id: string }) => {
      started.push(run.id);
    },
    announce: async () => {},
    flushAnnouncements: async () => {},
  } as unknown as RunExecutor;
}

function deps(started: string[]): AcceptDeps {
  return { db, executor: stubExecutor(started), config: makeConfig() };
}

describe('per-conversation message queue', () => {
  test('a message to a busy conversation is queued, not refused', async () => {
    const started: string[] = [];
    const d = deps(started);

    const first = await acceptRun(d, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    const conversationId = first.ok ? first.run.conversationId : null;
    assert.ok(conversationId);

    const second = await acceptRun(d, {
      prompt: 'follow-up while busy',
      kind: 'chat',
      conversationId,
    });
    assert.ok(second.ok, 'a same-conversation message must be accepted, not refused');
    if (second.ok) {
      assert.equal(second.queued, true);
      assert.equal(second.run.status, 'waiting');
      assert.equal(second.run.conversationId, conversationId);
    }
    // The queued message has NOT started and holds no active slot.
    assert.deepEqual(started, [first.ok ? first.run.id : '']);
    const active = await getActiveRun(db);
    assert.equal(active?.id, first.ok ? first.run.id : '');
  });

  test('a message to a DIFFERENT conversation is still refused while busy', async () => {
    const started: string[] = [];
    const d = deps(started);

    const first = await acceptRun(d, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    const otherConversation = await createConversation(db, 'a different chat');

    const refused = await acceptRun(d, {
      prompt: 'unrelated task',
      kind: 'chat',
      conversationId: otherConversation,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'in_progress');
  });

  test('when the active run finishes, the drain starts the queued message in the same conversation, continuing its sandbox', async () => {
    const started: string[] = [];
    const d = deps(started);

    const first = await acceptRun(d, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    if (!first.ok) return;
    const conversationId = first.run.conversationId;

    const second = await acceptRun(d, {
      prompt: 'queued follow-up',
      kind: 'chat',
      conversationId,
    });
    assert.ok(second.ok);
    if (!second.ok) return;

    await finishRun(db, first.run.id, {
      status: 'completed',
      text: 'done',
      interactionId: 'int_first',
      environmentId: 'env_first',
    });

    const drained = await drainQueue(d);
    assert.ok(drained?.ok, 'drain must launch the queued run once the slot is free');
    if (drained?.ok) {
      assert.equal(drained.run.id, second.run.id);
      // Continuation resolved at promotion time: the follow-up inherits the
      // sandbox of the run that just finished, not the stale one from when
      // the message was sent.
      assert.equal(drained.run.previousInteractionId, 'int_first');
    }
    assert.deepEqual(started, [first.run.id, second.run.id]);
    const active = await getActiveRun(db);
    assert.equal(active?.id, second.run.id);
  });

  test('two queued messages drain in FIFO order, one at a time', async () => {
    const started: string[] = [];
    const d = deps(started);

    const first = await acceptRun(d, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    if (!first.ok) return;
    const conversationId = first.run.conversationId;

    const second = await acceptRun(d, { prompt: 'queued one', kind: 'chat', conversationId });
    const third = await acceptRun(d, { prompt: 'queued two', kind: 'chat', conversationId });
    assert.ok(second.ok && third.ok);
    if (!second.ok || !third.ok) return;

    await finishRun(db, first.run.id, { status: 'completed', text: 'done' });
    const drain1 = await drainQueue(d);
    assert.ok(drain1?.ok);
    if (drain1?.ok) assert.equal(drain1.run.id, second.run.id);

    // The slot is busy again: a second drain must not start the third.
    const drainBusy = await drainQueue(d);
    assert.equal(drainBusy, null);
    assert.deepEqual(started, [first.run.id, second.run.id]);

    const secondRow = await getRun(db, second.run.id);
    assert.ok(secondRow);
    await finishRun(db, second.run.id, { status: 'completed', text: 'done too' });
    const drain2 = await drainQueue(d);
    assert.ok(drain2?.ok);
    if (drain2?.ok) assert.equal(drain2.run.id, third.run.id);
    assert.deepEqual(started, [first.run.id, second.run.id, third.run.id]);
    void secondRow;
  });

  test('a queued message spends its budget only when it actually starts', async () => {
    const started: string[] = [];
    const d = deps(started);

    const first = await acceptRun(d, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    if (!first.ok) return;

    const second = await acceptRun(d, {
      prompt: 'queued follow-up',
      kind: 'chat',
      conversationId: first.run.conversationId,
    });
    assert.ok(second.ok);
    assert.equal(await peekDayTotal(db), 1, 'queueing must not spend a run');

    await finishRun(db, first.run.id, { status: 'completed', text: 'done' });
    await drainQueue(d);
    assert.equal(await peekDayTotal(db), 2, 'starting the queued run spends exactly one run');
  });

  test('a spent budget leaves the queued message waiting instead of failing it', async () => {
    const started: string[] = [];
    const tight = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'key',
      ACCESS_KEY,
      SESSION_SECRET: SECRET,
      ENGINE: 'scripted',
      DAILY_RUN_BUDGET: '1',
    } as NodeJS.ProcessEnv);
    const d: AcceptDeps = { db, executor: stubExecutor(started), config: tight };

    const first = await acceptRun(d, { prompt: 'only run today', kind: 'chat' });
    assert.ok(first.ok);
    if (!first.ok) return;
    const second = await acceptRun(d, {
      prompt: 'queued for tomorrow',
      kind: 'chat',
      conversationId: first.run.conversationId,
    });
    assert.ok(second.ok);
    if (!second.ok) return;

    await finishRun(db, first.run.id, { status: 'completed', text: 'done' });
    const drained = await drainQueue(d);
    assert.equal(drained, null, 'no budget: the drain must not promote');
    const row = await getRun(db, second.run.id);
    assert.equal(row?.status, 'waiting', 'the message survives to a later drain, not failed');
    assert.deepEqual(started, [first.run.id]);
  });

  test('a complex queued message goes through plan approval when drained', async () => {
    const started: string[] = [];
    const d = deps(started);
    // The shared stub's planMission returns no steps; this case needs a
    // planner that finds steps, so build deps with one.
    const planningExecutor = {
      planMission: async () => [
        { index: 1, total: 2, label: 'design' },
        { index: 2, total: 2, label: 'build' },
      ],
      start: (run: { id: string }) => {
        started.push(run.id);
      },
      announce: async () => {},
      flushAnnouncements: async () => {},
    } as unknown as RunExecutor;
    const pd: AcceptDeps = { db, executor: planningExecutor, config: makeConfig() };
    void d;

    const first = await acceptRun(pd, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    if (!first.ok) return;
    const complex =
      'Build a small habit tracker web app. First, design the data model for habits and check-ins. ' +
      'Then implement the storage layer with SQLite. Then build the UI with a weekly grid view. ' +
      'Finally, write tests for the streak calculation and document the setup steps.';
    const second = await acceptRun(pd, {
      prompt: complex,
      kind: 'chat',
      conversationId: first.run.conversationId,
    });
    assert.ok(second.ok);
    if (!second.ok) return;
    assert.equal(second.run.status, 'waiting');

    await finishRun(db, first.run.id, { status: 'completed', text: 'done' });
    const drained = await drainQueue(pd);
    assert.ok(drained?.ok);
    if (drained?.ok && drained.planning) await drained.planning;
    const row = await getRun(db, second.run.id);
    assert.equal(row?.status, 'awaiting_plan', 'a promoted complex mission pauses for plan approval, exactly like a fresh one');
    assert.deepEqual(started, [first.run.id], 'the executor must not start it before approval');
  });

  test('two drains at once promote a queued message exactly once', async () => {
    const started: string[] = [];
    const d = deps(started);

    const first = await acceptRun(d, { prompt: 'first task', kind: 'chat' });
    assert.ok(first.ok);
    if (!first.ok) return;
    const second = await acceptRun(d, {
      prompt: 'queued follow-up',
      kind: 'chat',
      conversationId: first.run.conversationId,
    });
    assert.ok(second.ok);
    if (!second.ok) return;

    await finishRun(db, first.run.id, { status: 'completed', text: 'done' });
    const [r1, r2] = await Promise.all([drainQueue(d), drainQueue(d)]);
    const launched = [r1, r2].filter((r) => r?.ok && r.run.id === second.run.id);
    assert.equal(launched.length, 1, 'exactly one drain may launch the queued run');
    assert.deepEqual(started, [first.run.id, second.run.id]);
    assert.equal(await peekDayTotal(db), 2, 'and its budget is spent exactly once');
  });
});
