/**
 * The scheduled-task API over HTTP: validation, CRUD, and the /tick endpoint
 * that fires whatever is due through the normal acceptance path.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../app.js';
import { createStores } from '../settings.js';
import { createDb, type Db } from '../db.js';
import { migrate } from '../migrate.js';
import { loadConfig, type AppConfig } from '../config.js';
import { EventBus } from '../events.js';
import { RunExecutor } from '../executor.js';
import { ScriptedEngine } from '../engine/scripted.js';
import { getRun, createRun } from '../runs.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'sched-access-key-for-tests';

let db: Db;
let agent: Server;
let base: string;

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

const auth = { 'x-access-key': ACCESS_KEY };

async function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, { headers: auth });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patch(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function del(pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, { method: 'DELETE', headers: auth });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function settle(runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await getRun(db, runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

before(async () => {
  db = await createDb('');
  await migrate(db);
  const config = makeConfig();
  const executor = new RunExecutor({ db, bus: new EventBus(), engine: new ScriptedEngine() });
  const app = createApp({
    config,
    db,
    bus: new EventBus(),
    executor,
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 6, orphanedRuns: 0 },
  });
  agent = http.createServer(app);
  await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => agent.close(() => resolve()));
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM scheduled_tasks');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM messages');
});

const dailyTask = {
  name: 'Morning news',
  prompt: 'Summarise the tech news',
  cadence: 'daily',
  timeOfDay: '09:00',
};

describe('validation', () => {
  test('rejects an empty prompt', async () => {
    const { status, body } = await post('/api/scheduled-tasks', { ...dailyTask, prompt: '  ' });
    assert.equal(status, 400);
    assert.match(body.message, /prompt is empty/);
  });

  test('rejects a bad interval', async () => {
    const { status } = await post('/api/scheduled-tasks', {
      name: 'x',
      prompt: 'y',
      cadence: 'interval',
      intervalMinutes: 2,
    });
    assert.equal(status, 400);
  });

  test('rejects a bad time', async () => {
    const { status } = await post('/api/scheduled-tasks', { ...dailyTask, timeOfDay: '25:00' });
    assert.equal(status, 400);
  });
});

describe('crud', () => {
  test('create, list, pause, resume, delete', async () => {
    const created = await post('/api/scheduled-tasks', dailyTask);
    assert.equal(created.status, 201);
    const id = created.body.task.id;
    assert.match(id, /^sch_/);
    assert.ok(new Date(created.body.task.nextRunAt).getTime() > Date.now());

    const listed = await get('/api/scheduled-tasks');
    assert.equal(listed.body.tasks.length, 1);

    const paused = await patch(`/api/scheduled-tasks/${id}`, { enabled: false });
    assert.equal(paused.body.task.enabled, false);

    const resumed = await patch(`/api/scheduled-tasks/${id}`, { enabled: true });
    assert.equal(resumed.body.task.enabled, true);

    const gone = await del(`/api/scheduled-tasks/${id}`);
    assert.equal(gone.body.ok, true);
    assert.equal((await get('/api/scheduled-tasks')).body.tasks.length, 0);
  });

  test('unknown ids 404', async () => {
    assert.equal((await patch('/api/scheduled-tasks/sch_nope', { enabled: false })).status, 404);
    assert.equal((await del('/api/scheduled-tasks/sch_nope')).status, 404);
  });
});

describe('message-only kind', () => {
  test('creates a message-only reminder', async () => {
    const created = await post('/api/scheduled-tasks', {
      name: 'Drink water',
      prompt: 'Drink a glass of water',
      cadence: 'interval',
      intervalMinutes: 120,
      kind: 'message',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.task.kind, 'message');
  });

  test('rejects an unknown kind', async () => {
    const created = await post('/api/scheduled-tasks', { ...dailyTask, kind: 'carrier-pigeon' });
    assert.equal(created.status, 400);
    assert.match(created.body.message, /kind must be task or message/);
  });

  test('tick fires a message-only task silently with no token: no run, no budget', async () => {
    const runsBefore = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM runs`))[0].n);
    const created = await post('/api/scheduled-tasks', {
      name: 'Quiet reminder',
      prompt: 'this needs no agent',
      cadence: 'interval',
      intervalMinutes: 60,
      kind: 'message',
    });
    const id = created.body.task.id;
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    // No whatsapp_token is configured in this test app, so the fire must be
    // silent: consumed, but no send, no run, no throw.
    const ticked = await post('/api/scheduled-tasks/tick', {});
    assert.equal(ticked.body.fired.length, 1);
    assert.equal(ticked.body.fired[0].kind, 'message');
    assert.equal(ticked.body.fired[0].runId, '');

    const runsAfter = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM runs`))[0].n);
    assert.equal(runsAfter, runsBefore, 'no run created by a message-only fire');
    const rows = await db.query<{ next_run_at: Date }>(
      `SELECT next_run_at FROM scheduled_tasks WHERE id = $1`,
      [id],
    );
    assert.ok(new Date(rows[0].next_run_at).getTime() > Date.now(), 'fire consumed');
  });
});

describe('tick', () => {
  test('fires a due task and advances its next run', async () => {
    const created = await post('/api/scheduled-tasks', {
      name: 'Heartbeat',
      prompt: 'say ok',
      cadence: 'interval',
      intervalMinutes: 60,
    });
    const id = created.body.task.id;
    const before = new Date(created.body.task.nextRunAt).getTime();

    // Make it due now.
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    const ticked = await post('/api/scheduled-tasks/tick', {});
    assert.equal(ticked.body.fired.length, 1);
    assert.equal(ticked.body.fired[0].taskId, id);

    const runId = ticked.body.fired[0].runId;
    await settle(runId);
    const run = await getRun(db, runId);
    assert.equal(run?.status, 'completed');

    const rows = await db.query<{ next_run_at: Date; last_run_id: string }>(
      `SELECT next_run_at, last_run_id FROM scheduled_tasks WHERE id = $1`,
      [id],
    );
    assert.equal(rows[0].last_run_id, runId);
    assert.ok(new Date(rows[0].next_run_at).getTime() > before - 60_000);
  });

  test('a disabled task never fires', async () => {
    const created = await post('/api/scheduled-tasks', dailyTask);
    const id = created.body.task.id;
    await db.query(
      `UPDATE scheduled_tasks SET enabled = false, next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    const ticked = await post('/api/scheduled-tasks/tick', {});
    assert.equal(ticked.body.fired.length, 0);
  });

  test('a busy agent defers the task instead of dropping it', async () => {
    // Park an active run so acceptRun refuses with in_progress.
    await createRun(db, { prompt: 'blocking', kind: 'api', engine: 'scripted' });

    const created = await post('/api/scheduled-tasks', {
      name: 'Deferred',
      prompt: 'say ok',
      cadence: 'interval',
      intervalMinutes: 60,
    });
    const id = created.body.task.id;
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    const ticked = await post('/api/scheduled-tasks/tick', {});
    assert.equal(ticked.body.fired.length, 0);
    assert.equal(ticked.body.deferred.length, 1);
    assert.equal(ticked.body.deferred[0].taskId, id);

    // Retries in minutes, not in a full hour.
    const rows = await db.query<{ next_run_at: Date }>(
      `SELECT next_run_at FROM scheduled_tasks WHERE id = $1`,
      [id],
    );
    const retryIn = new Date(rows[0].next_run_at).getTime() - Date.now();
    assert.ok(retryIn > 0 && retryIn < 10 * 60_000, `retry in ${retryIn}ms`);
  });
});
