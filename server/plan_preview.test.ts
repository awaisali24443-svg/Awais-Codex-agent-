/**
 * Plan-preview tests.
 *
 * The promise under test: creating a complex web run produces a step-by-step
 * plan that waits in 'awaiting_plan' — the mission does NOT execute until the
 * operator approves (or edits then approves). Covers plan persistence, the
 * approve/edit transitions, the double-approve guard, and the graceful
 * fallback when the planning pass comes back empty.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import {
  approveRunPlan,
  createRun,
  getRun,
  saveRunPlan,
  setRunStatus,
  updateRunPlan,
} from './runs.js';
import { buildPlanPreamble, planOnlyPrompt } from './planning.js';
import { acceptRun } from './accept.js';
import { createApp } from './app.js';
import { createStores } from './settings.js';
import { loadConfig, type AppConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine, type ScriptStep } from './engine/scripted.js';

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
});

// Long enough to trip looksComplex, so the planning gate engages.
const COMPLEX_PROMPT =
  'Build a small habit tracker web app. First, design the data model for habits and check-ins. ' +
  'Then implement the storage layer with SQLite. Then build the UI with a weekly grid view. ' +
  'Finally, write tests for the streak calculation and document the setup steps.';

const PLAN_SCRIPT: ScriptStep[] = [
  { log: 'Step 1/3: design the data model' },
  { log: 'Step 2/3: implement storage' },
  { log: 'Step 3/3: build the UI and test' },
];

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'plan-preview-access-key-for-tests';

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

function makeExecutor(steps = PLAN_SCRIPT): RunExecutor {
  return new RunExecutor({
    db,
    bus: new EventBus(),
    engine: new ScriptedEngine({ steps, speed: 0 }),
  });
}

describe('plan storage', () => {
  test('saveRunPlan persists steps; getRun returns them', async () => {
    const run = await createRun(db, { prompt: 'x', engine: 'scripted' });
    await saveRunPlan(db, run.id, [
      { index: 1, total: 3, label: 'design' },
      { index: 2, total: 3, label: 'build' },
      { index: 3, total: 3, label: 'test' },
    ]);
    const reloaded = await getRun(db, run.id);
    assert.deepEqual(reloaded?.plan, [
      { index: 1, total: 3, label: 'design' },
      { index: 2, total: 3, label: 'build' },
      { index: 3, total: 3, label: 'test' },
    ]);
  });

  test('a run without a plan reads back null', async () => {
    const run = await createRun(db, { prompt: 'x', engine: 'scripted' });
    assert.equal((await getRun(db, run.id))?.plan, null);
  });

  test('approveRunPlan moves awaiting_plan to queued, exactly once', async () => {
    const run = await createRun(db, { prompt: 'x', engine: 'scripted' });
    await setRunStatus(db, run.id, 'awaiting_plan');
    assert.equal(await approveRunPlan(db, run.id), true);
    assert.equal((await getRun(db, run.id))?.status, 'queued');
    // A double-tap approves once: the second call is a no-op.
    assert.equal(await approveRunPlan(db, run.id), false);
  });

  test('approveRunPlan refuses a run that is not waiting', async () => {
    const run = await createRun(db, { prompt: 'x', engine: 'scripted' });
    assert.equal(await approveRunPlan(db, run.id), false);
    assert.equal((await getRun(db, run.id))?.status, 'queued');
  });

  test('updateRunPlan reindexes edited labels', async () => {
    const run = await createRun(db, { prompt: 'x', engine: 'scripted' });
    await setRunStatus(db, run.id, 'awaiting_plan');
    const steps = await updateRunPlan(db, run.id, ['second idea', 'first idea']);
    assert.deepEqual(steps, [
      { index: 1, total: 2, label: 'second idea' },
      { index: 2, total: 2, label: 'first idea' },
    ]);
    assert.equal((await getRun(db, run.id))?.status, 'awaiting_plan');
  });

  test('updateRunPlan refuses a run that is not waiting', async () => {
    const run = await createRun(db, { prompt: 'x', engine: 'scripted' });
    assert.equal(await updateRunPlan(db, run.id, ['x']), null);
  });
});

describe('planning gate', () => {
  test('a complex chat run waits in awaiting_plan without executing', async () => {
    const config = makeConfig();
    const executor = makeExecutor();
    const result = await acceptRun(
      { db, executor, config },
      { prompt: COMPLEX_PROMPT, kind: 'chat' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const run = result.run;
    assert.equal(run.status, 'awaiting_plan');
    assert.equal(run.plan?.length, 3);
    assert.equal(run.plan?.[0].label, 'design the data model');
    // The mission did not start: no executor attached, no run.started event.
    assert.equal(executor.isRunning(run.id), false);
    const events = await db.query<{ type: string }>(
      `SELECT type FROM run_events WHERE run_id = $1`,
      [run.id],
    );
    assert.ok(events.some((e) => e.type === 'run.plan_ready'));
    assert.ok(!events.some((e) => e.type === 'run.started'));
  });

  test('a simple prompt executes directly, with no plan', async () => {
    const config = makeConfig();
    const executor = makeExecutor();
    const result = await acceptRun(
      { db, executor, config },
      { prompt: 'what time is it', kind: 'chat' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.run.status, 'awaiting_plan');
    assert.equal(result.run.plan, null);
    await executor.shutdown();
  });

  test('an empty planning pass falls back to execution instead of stranding the run', async () => {
    const config = makeConfig();
    // The script emits no "Step k/N" lines, so no plan is found.
    const executor = makeExecutor([{ text: 'no plan here' }]);
    const result = await acceptRun(
      { db, executor, config },
      { prompt: COMPLEX_PROMPT, kind: 'chat' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.run.status, 'awaiting_plan');
    assert.equal(result.run.plan, null);
    await executor.shutdown();
  });

  test('whatsapp runs skip planning — there is no approval UI there', async () => {
    const config = makeConfig();
    const executor = makeExecutor();
    const result = await acceptRun(
      { db, executor, config },
      { prompt: COMPLEX_PROMPT, kind: 'whatsapp' },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.run.status, 'awaiting_plan');
    await executor.shutdown();
  });

  test('planOnlyPrompt asks for the plan and nothing else', () => {
    const wire = planOnlyPrompt('do the thing');
    assert.ok(wire.includes('do NOT start the task'));
    assert.ok(wire.includes('Step 1/N'));
    assert.ok(wire.endsWith('do the thing'));
  });

  test('buildPlanPreamble lists the approved steps for the wire', () => {
    const preamble = buildPlanPreamble([
      { index: 1, total: 2, label: 'design' },
      { index: 2, total: 2, label: 'build' },
    ]);
    assert.ok(preamble.includes('Step 1/2: design'));
    assert.ok(preamble.includes('Step 2/2: build'));
    assert.equal(buildPlanPreamble([]), '');
  });
});

// ---------------------------------------------------------------------------
// HTTP: approve and plan-edit endpoints, mounted and wired.
// ---------------------------------------------------------------------------

let agent: Server;
let base: string;
const auth = { 'x-access-key': ACCESS_KEY };

async function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('plan routes', () => {
  let executor: RunExecutor;
  let bus: EventBus;

  before(async () => {
    const config = makeConfig();
    executor = makeExecutor();
    bus = new EventBus();
    const app = createApp({
      config,
      db,
      bus,
      executor,
      ...createStores(db, config),
      status: { startedAt: Date.now(), migrationsApplied: 10, orphanedRuns: 0 },
    });
    agent = http.createServer(app);
    await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => agent.close(() => resolve()));
    await executor.shutdown();
  });

  test('POST /runs with a complex prompt waits for approval', async () => {
    const res = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    assert.equal(res.status, 201);
    assert.equal(res.body.run.status, 'awaiting_plan');
    assert.equal(res.body.run.plan.length, 3);
  });

  test('POST /runs/:id/plan edits the waiting plan', async () => {
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const id = created.body.run.id as string;
    const res = await post(`/api/runs/${id}/plan`, { steps: ['edited one', 'edited two'] });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.plan.map((s: { label: string }) => s.label),
      ['edited one', 'edited two'],
    );
    const reloaded = await getRun(db, id);
    assert.equal(reloaded?.status, 'awaiting_plan');
    assert.equal(reloaded?.plan?.[1].index, 2);
  });

  test('a step can be dropped, added or moved, and the plan is reindexed', async () => {
    // The plan editor sends the whole list back: what the operator left is the
    // plan, in the order they left it, numbered 1..N. The numbering is the
    // server's job precisely so the client never has to be trusted with it.
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const id = created.body.run.id as string;
    const res = await post(`/api/runs/${id}/plan`, {
      steps: ['the step I moved to the top', 'the first step, now second', 'a step I added'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.plan.map((s: { index: number; total: number; label: string }) => [s.index, s.total, s.label]),
      [
        [1, 3, 'the step I moved to the top'],
        [2, 3, 'the first step, now second'],
        [3, 3, 'a step I added'],
      ],
    );
    // And the stored run is what was returned, not a copy that drifted.
    const run = await getRun(db, id);
    assert.deepEqual(run?.plan?.map((s) => s.label), res.body.plan.map((s: { label: string }) => s.label));
  });

  test('blank rows are dropped rather than becoming empty steps', async () => {
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const res = await post(`/api/runs/${created.body.run.id}/plan`, {
      steps: ['  keep me  ', '   ', '', 'keep me too'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plan.map((s: { label: string }) => s.label), ['keep me', 'keep me too']);
    assert.deepEqual(res.body.plan.map((s: { total: number }) => s.total), [2, 2]);
  });

  test('the edited plan is broadcast, so every open view shows the same list', async () => {
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const id = created.body.run.id as string;
    const seen: Array<{ type: string; payload: any }> = [];
    const unsubscribe = bus.subscribe(id, (event) => seen.push(event));
    await post(`/api/runs/${id}/plan`, { steps: ['one', 'two'] });
    unsubscribe();
    const updated = seen.find((e) => e.type === 'run.plan_updated');
    assert.ok(updated, 'the edit is announced on the run stream');
    assert.deepEqual((updated.payload.plan as Array<{ label: string }>).map((s) => s.label), ['one', 'two']);
  });

  test('POST /runs/:id/plan rejects an empty plan', async () => {
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const res = await post(`/api/runs/${created.body.run.id}/plan`, { steps: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'plan_required');
  });

  test('POST /runs/:id/approve starts the mission; a second approve is refused', async () => {
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const id = created.body.run.id as string;
    const res = await post(`/api/runs/${id}/approve`, {});
    assert.equal(res.status, 200);
    assert.ok(['queued', 'running', 'completed'].includes(res.body.run.status));
    const again = await post(`/api/runs/${id}/approve`, {});
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'not_awaiting_plan');
  });

  test('approve and plan-edit refuse a run that is not waiting', async () => {
    const created = await post('/api/runs', { prompt: 'what time is it' });
    const id = created.body.run.id as string;
    // The simple prompt executed directly — wait for the scripted engine to
    // settle it so the status is terminal, not queued/running.
    for (let i = 0; i < 50; i++) {
      const run = await getRun(db, id);
      if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const approve = await post(`/api/runs/${id}/approve`, {});
    assert.equal(approve.status, 400);
    assert.equal(approve.body.error, 'not_awaiting_plan');
    const edit = await post(`/api/runs/${id}/plan`, { steps: ['x'] });
    assert.equal(edit.status, 400);
    assert.equal(edit.body.error, 'not_awaiting_plan');
  });

  test('a plan edited while the run is open reaches the stream that is watching it', async () => {
    // The bug this pins: the edit was written to the database and never
    // published, so the phone that made the edit saw the new plan (it
    // re-rendered the response) and a second phone saw the old one until it
    // reconnected. Persisting is half the job.
    const created = await post('/api/runs', { prompt: COMPLEX_PROMPT });
    const id = created.body.run.id as string;
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/runs/${id}/stream`, { headers: auth, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return seen;
          seen += decoder.decode(value, { stream: true });
          if (seen.includes('event: run.plan_updated')) return seen;
        }
      } catch {
        return seen; // aborted once the frame is in
      }
    })();
    // Let the stream subscribe before the edit, or the thing under test would
    // not be exercised at all.
    await new Promise((r) => setTimeout(r, 200));
    await post(`/api/runs/${id}/plan`, { steps: ['live one', 'live two'] });
    const text = await Promise.race([
      reading,
      new Promise<string>((resolve) => setTimeout(() => resolve(seen), 4_000)),
    ]);
    controller.abort();
    assert.ok(text.includes('event: run.plan_updated'), 'the edit arrives on the open stream');
    assert.ok(text.includes('live two'), 'carrying the steps that were saved');
    // `id:` rides above the event line; that is the cursor a reconnect resumes from.
    assert.ok(
      /id: \d+\nevent: run\.plan_updated/.test(text),
      'and the frame is durable, so a reconnect can resume from it',
    );
  });

  test('approve on a missing run is a 404', async () => {
    const res = await post('/api/runs/run_nope/approve', {});
    assert.equal(res.status, 404);
  });
});
