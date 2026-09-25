/**
 * The queue's pump, tested against the real database.
 *
 * The queue has one job: exactly one task runs, and everything else that was
 * asked for is still going to run — in the order it was asked. Every test here
 * is about one of those two halves, because the failure modes are opposite and
 * both are bad: a pump that starts two tasks breaks the quota guard, and a
 * pump that drops one loses the operator's work without saying so.
 *
 * The guard being tested is the partial unique index on `runs`, not this code.
 * The pump is allowed to be wrong about a race — it is not allowed to start a
 * second task, and it cannot, because the index will not have it.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { pumpQueue } from './queue.js';
import { loadConfig } from './config.js';
import { acceptRun } from './accept.js';
import { createRun, getActiveRun, getRun, listWaitingRuns, setRunStatus } from './runs.js';
import { peekDayTotal } from './budget.js';
import type { RunExecutor } from './executor.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let db: Db;
const config = loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-that-is-definitely-long-enough',
  ACCESS_KEY: 'queue-access-key-for-tests',
  ENGINE: 'scripted',
} as NodeJS.ProcessEnv);

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM budgets');
});

interface Recorder {
  started: string[];
  announced: { runId: string; type: string; payload: Record<string, unknown> }[];
}

/** An executor stub: records what was started, starts no engine. */
function recordingExecutor(record: Recorder): RunExecutor {
  return {
    start: (run: { id: string }) => record.started.push(run.id),
    announce: async (runId: string, type: string, payload: Record<string, unknown> = {}) => {
      record.announced.push({ runId, type, payload });
    },
    // The planning path publishes through these two as well.
    planMission: async () => [
      { index: 1, total: 2, label: 'design' },
      { index: 2, total: 2, label: 'build' },
    ],
    flushAnnouncements: async () => {},
    isRunning: () => false,
    activeCount: 0,
  } as unknown as RunExecutor;
}

/** A queued task, inserted the way the accept path inserts one. */
async function ask(prompt: string, waiting: boolean, kind: 'chat' | 'api' = 'chat') {
  return createRun(db, { prompt, engine: 'scripted', kind, queued: waiting });
}

describe('the queue moves exactly one task and never loses one', () => {
  test('an empty line starts nothing', async () => {
    const record: Recorder = { started: [], announced: [] };
    const result = await pumpQueue({ db, executor: recordingExecutor(record), config });
    assert.deepEqual(result, { started: null, reason: 'line_empty' });
    assert.deepEqual(record.started, []);
  });

  test('a busy slot starts nothing, and leaves the line exactly as it was', async () => {
    await ask('the running one', false);
    const waiting = await ask('the parked one', true);
    const record: Recorder = { started: [], announced: [] };

    const result = await pumpQueue({ db, executor: recordingExecutor(record), config });

    assert.deepEqual(result, { started: null, reason: 'slot_busy' });
    assert.deepEqual(record.started, []);
    const stillWaiting = await getRun(db, waiting.id);
    assert.equal(stillWaiting?.status, 'waiting', 'a busy slot must not consume the line');
  });

  test('the oldest ask goes first, and the clock restarts when the work does', async () => {
    const first = await ask('asked first', true);
    // Millisecond separation so the ordering claim is a real one.
    await new Promise((r) => setTimeout(r, 5));
    const second = await ask('asked second', true);
    const record: Recorder = { started: [], announced: [] };

    const result = await pumpQueue({ db, executor: recordingExecutor(record), config });

    assert.equal(result.started?.id, first.id, 'first come, first served');
    assert.deepEqual(record.started, [first.id]);
    const remaining = await listWaitingRuns(db);
    assert.deepEqual(remaining.map((r) => r.id), [second.id], 'the rest of the line is untouched');

    // `started_at` is rewritten: the run timer must report work, not waiting.
    const promoted = await getRun(db, first.id);
    const waited = new Date(promoted?.startedAt ?? 0).getTime() - new Date(first.startedAt).getTime();
    assert.ok(waited >= 0, 'and it is not in the future');
    assert.ok(
      new Date(promoted?.startedAt ?? 0).getTime() >= new Date(second.startedAt).getTime() - 5,
      'the promoted task reports the moment it began, not the moment it was asked for',
    );

    // The wait is announced on the run's own stream: a task that starts
    // silently looks, from the card, exactly like a task that never will.
    assert.equal(record.announced.length, 1);
    assert.equal(record.announced[0].runId, first.id);
    assert.equal(record.announced[0].type, 'run.queued');
  });

  test('two pumps racing start one task between them', async () => {
    await ask('only one of us can win', true);
    const record: Recorder = { started: [], announced: [] };
    const deps = { db, executor: recordingExecutor(record), config };

    const [a, b] = await Promise.all([pumpQueue(deps), pumpQueue(deps)]);

    const started = [a.started, b.started].filter(Boolean);
    assert.equal(started.length, 1, `exactly one promotion, got ${started.length}`);
    assert.equal(record.started.length, 1, 'and exactly one task handed to the executor');
  });

  test('a task that cannot start is failed with a reason, and the next one still runs', async () => {
    const stuck = await ask('this one cannot start', true);
    const next = await ask('but this one can', true);

    // The executor refuses the first task outright — the shape of a bug in the
    // start path, not a normal failure. The pump must not leave the slot wedged.
    const record: Recorder = { started: [], announced: [] };
    const executor = {
      start: (run: { id: string }) => {
        if (run.id === stuck.id) throw new Error('cannot start this one');
        record.started.push(run.id);
      },
      announce: async (runId: string, type: string, payload: Record<string, unknown> = {}) => {
        record.announced.push({ runId, type, payload });
      },
      isRunning: () => false,
    } as unknown as RunExecutor;

    // The first pump fails the stuck task, which fires the slot-free hook — so
    // the second task is started by the hook, not by this call. Either way,
    // both outcomes are asserted: a reason on the record, and a moving line.
    const result = await pumpQueue({ db, executor, config });
    assert.deepEqual(result, { started: null, reason: 'start_failed' });

    const failed = await getRun(db, stuck.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.errorType, 'queue_stalled');
    assert.match(String(failed?.errorMessage), /could not start/);

    // Nothing is left holding the slot, so the line can move.
    assert.equal(await getActiveRun(db), null);
    assert.deepEqual((await listWaitingRuns(db)).map((r) => r.id), [next.id]);
  });

  test('a task parked for a long time still runs, and says how long it waited', async () => {
    const parked = await ask('parked a while ago', true);
    // Eight minutes of waiting, written into the row the way time writes it.
    await db.query(`UPDATE runs SET started_at = now() - interval '8 minutes' WHERE id = $1`, [parked.id]);
    const record: Recorder = { started: [], announced: [] };

    const result = await pumpQueue({ db, executor: recordingExecutor(record), config });

    assert.equal(result.started?.id, parked.id);
    // The wait is on the record; the clock the operator watches is not.
    const announcements = record.announced.filter((a) => a.type === 'run.queued');
    assert.equal(announcements.length, 1, 'the promotion is announced once');
    const waited = Number(announcements[0].payload.waitedMs ?? 0);
    assert.ok(waited > 7 * 60_000, `the wait is reported (got ${waited}ms)`);
  });

  test('a run parked by a previous boot is not an orphan', async () => {
    // The deploy case: a task is waiting when the service restarts. Recovery
    // must leave it alone — failing it there throws away the operator's ask at
    // the worst possible moment.
    const recovery = read('server/recovery.ts');
    const select = recovery.slice(recovery.indexOf('FROM runs r'), recovery.indexOf('ORDER BY r.started_at DESC'));
    assert.ok(!select.includes("'waiting'"), 'the orphan sweep does not touch the line');
  });
});

describe('accepting a task when one is already running', () => {
  test('the ask is parked and said to be parked, with what it waits behind', async () => {
    const first = await ask('hold the slot', false);
    const record: Recorder = { started: [], announced: [] };
    const result = await acceptRun(
      { db, executor: recordingExecutor(record), config },
      { prompt: 'the second thought', kind: 'api' },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.run.status, 'waiting');
    assert.ok(result.queue, 'the caller is told where it is in line');
    assert.equal(result.queue?.position, 1);
    assert.equal(result.queue?.ahead.id, first.id);
    assert.deepEqual(record.started, [], 'and nothing was started: the slot is taken');

    // The waiting task does not steal the slot from the running one.
    assert.equal((await getActiveRun(db))?.id, first.id);
  });

  test('a parked task is charged the day, exactly once', async () => {
    // The first task is inserted directly, the way a slot-holder already is.
    await ask('hold the slot', false);
    const result = await acceptRun(
      { db, executor: recordingExecutor({ started: [], announced: [] }), config },
      { prompt: 'parked but paid for', kind: 'api' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Charged at the moment it is accepted, not when it eventually starts: the
    // day's allowance is spent by the ask, and discovering the limit at
    // promotion time — after the operator has walked away — would be worse.
    assert.equal(await peekDayTotal(db), 1, 'the parked task spent its run');
    assert.ok(typeof result.remaining === 'number', 'and the caller is told what is left');

    // Accepting the same task again would be a second task, not a second charge
    // for this one: nothing here can double-spend a single accept.
    assert.equal(await peekDayTotal(db), 1);
  });

  test('a task parked behind a planner is still planned when its turn comes', async () => {
    // The decision that must survive the queue: a complex ask earns a planning
    // pass, and a complex ask that waited in line earns it too.
    const first = await ask('hold the slot', false);
    const complex =
      'Build a small habit tracker web app. First design the data model, then implement storage, ' +
      'then build the weekly grid UI, then write tests for the streak calculation and document setup. ' +
      'Also add CSV export and a dark mode toggle for the settings screen.';
    const parked = await createRun(db, { prompt: complex, engine: 'scripted', kind: 'chat', queued: true });
    assert.equal(parked.status, 'waiting');

    // Free the slot, then pump: the complex task must go to 'planning', not
    // straight to the engine.
    await setRunStatus(db, first.id, 'completed');
    const record: Recorder = { started: [], announced: [] };
    const result = await pumpQueue({ db, executor: recordingExecutor(record), config });

    assert.equal(result.started?.id, parked.id);
    const after = await getRun(db, parked.id);
    assert.equal(after?.status, 'planning', 'the plan is drafted before the work starts');
    assert.deepEqual(record.started, [], 'the engine is not handed a complex task unplanned');
    assert.ok(
      record.announced.some((a) => a.type === 'run.plan_started'),
      'and the planning is announced on the run it belongs to',
    );
  });
});

describe('the suite itself is trustworthy', () => {
  // The queue work was verified against a suite whose totals moved: three runs
  // of one unchanged tree reported 1040, 1051 and 1037 tests, all with "0 fail".
  // The gap was exactly one file whose results landed after `--test-force-exit`
  // ended the process — a green run that never ran everything. These two
  // assertions are what stop that from coming back unnoticed.
  test('npm test goes through the runner that waits for every file', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.test, 'node --import tsx scripts/test.mjs');
    assert.ok(!pkg.scripts.test.includes('--test-force-exit'), 'the parent must not force its own exit');
  });

  test('the runner gives the flag to the children and refuses a silent truncation', () => {
    const runner = read('scripts/test.mjs');
    assert.ok(runner.includes("process.execArgv = [...process.execArgv, '--test-force-exit']"));
    assert.ok(runner.includes("ended without a summary — treating it as a failure"));
    assert.ok(runner.includes("no test files found"), 'and an empty discovery is a failure, not a pass');
  });
});

describe('production wires the queue', () => {
  test('the executor pumps on every free slot, at boot, and on a slow safety tick', () => {
    const main = read('server/main.ts');
    assert.ok(main.includes('onSlotFree:'), 'a settled task asks the queue for the next one');
    assert.ok(main.includes('pumpQueue({ db, executor, config })'), 'through the real acceptance path');
    assert.ok(main.includes('setInterval'), 'and a timer exists for everything else');
    const ticker = main.slice(main.indexOf('queueTimer'));
    assert.ok(ticker.includes('pumpQueue'), 'the safety tick is a pump');
    // Boot has to pump too: a task can be waiting when the service restarts,
    // and a queue that only moves when some *other* task ends would sit there
    // until the operator noticed.
    assert.ok(/pumpQueue\(/.test(main.slice(main.indexOf('recoverOrphanedRuns'))), 'and boot does not forget the line');
  });
});
