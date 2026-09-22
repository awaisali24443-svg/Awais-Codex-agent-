/**
 * The reminders API and the run retry endpoint, over HTTP.
 *
 * These prove the routes are actually mounted and wired: creating a reminder
 * validates, and retrying a failed run starts a fresh run with the same prompt
 * in the same conversation — while anything that is not a failed run is
 * refused.
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
import { getRun } from '../runs.js';
import { EngineError, type Engine, type EngineContext, type EngineResult } from '../engine/types.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'scheduled-access-key-for-tests';

/** Fails every mission, so there is a failed run to retry. */
class FailingEngine implements Engine {
  readonly name = 'failing';
  async run(_prompt: string, _ctx: EngineContext): Promise<EngineResult> {
    throw new EngineError('simulated failure', 'upstream_error');
  }
}

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
  const executor = new RunExecutor({ db, bus: new EventBus(), engine: new FailingEngine() });
  const app = createApp({
    config,
    db,
    bus: new EventBus(),
    executor,
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 3, orphanedRuns: 0 },
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
  await db.query('DELETE FROM reminders');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
});

describe('reminders API', () => {
  test('create, list and delete a reminder', async () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await post('/api/reminders', { text: 'call the bank', runAt });
    assert.equal(created.status, 201);
    assert.equal(created.body.reminder.text, 'call the bank');

    const listed = await get('/api/reminders');
    assert.ok(listed.body.reminders.some((r: { id: string }) => r.id === created.body.reminder.id));

    const deleted = await del(`/api/reminders/${created.body.reminder.id}`);
    assert.equal(deleted.status, 200);

    const again = await get('/api/reminders');
    assert.ok(!again.body.reminders.some((r: { id: string }) => r.id === created.body.reminder.id));
  });

  test('invalid reminders are refused', async () => {
    const past = await post('/api/reminders', {
      text: 'too late',
      runAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(past.status, 400);

    const empty = await post('/api/reminders', {
      text: '   ',
      runAt: new Date(Date.now() + 1_000).toISOString(),
    });
    assert.equal(empty.status, 400);
  });
});

describe('run retry', () => {
  test('a failed run can be retried into a fresh run', async () => {
    const created = await post('/api/runs', { prompt: 'doomed mission' });
    assert.equal(created.status, 201);
    await settle(created.body.run.id);
    assert.equal((await getRun(db, created.body.run.id))?.status, 'failed');

    const retried = await post(`/api/runs/${created.body.run.id}/retry`, {});
    assert.equal(retried.status, 201);
    assert.notEqual(retried.body.run.id, created.body.run.id);
    assert.equal(retried.body.run.prompt, 'doomed mission');
    assert.equal(retried.body.run.conversationId, created.body.run.conversationId);
    await settle(retried.body.run.id); // the retry fails too, with this engine
  });

  test('only failed runs can be retried', async () => {
    const missing = await post('/api/runs/run_nope/retry', {});
    assert.equal(missing.status, 404);

    // A queued run is not failed. Inserted directly so it cannot settle in a
    // race the way a real engine's fast failure would.
    await db.query(
      `INSERT INTO runs (id, kind, prompt, status, engine)
        VALUES ('run_queued_stub', 'chat', 'stub', 'queued', 'test')`,
    );
    const early = await post('/api/runs/run_queued_stub/retry', {});
    assert.equal(early.status, 400);
    assert.equal(early.body.error, 'not_failed');
  });
});
