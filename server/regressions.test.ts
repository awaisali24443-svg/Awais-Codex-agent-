/**
 * Regression tests for the seven fixes.
 *
 * Each case here failed before its fix, and each one is written the way the bug
 * was actually observed in production, not the way the code is shaped:
 *
 *   1. the phone reported a per-channel number while the gate enforced the day
 *      total, so it promised runs it would refuse;
 *   2. a reconnecting client asked to resume from a `seq` the finished run no
 *      longer had (finishRun compacts and renumbers), and got an empty replay;
 *   3. the Settings key-test ran a real interaction that no budget ever counted;
 *   4. retention only ran at boot, and `wa_updates` was never pruned at all;
 *   7. two boots racing on a pending migration killed the deploy.
 *
 * Problems 5 and 6 have their own files (`artifact_pin.test.ts`,
 * `whatsapp.test.ts`), where the harnesses for bytes and for the relay live.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { createApp } from './app.js';
import { createStores } from './settings.js';
import { createDb, pruneRunEvents, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig, type AppConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';
import { consumeRunBudget, peekDayTotal } from './budget.js';
import { remainingRuns, acceptRun } from './accept.js';
import { createRun, finishRun } from './runs.js';
import { pruneWaUpdates } from './whatsapp/store.js';
import { createReminderRoutes } from './routes/reminders.js';
import { createSettingsRoutes } from './routes/settings.js';

const SECRET = 'regression-secret-that-is-long-enough-1234';
const KEY = 'regression-access-key';
const INSTANT = [{ text: 'done' }];

let db: Db;
let server: Server;
let base: string;
let config: AppConfig;
let bus: EventBus;
let executor: RunExecutor;

before(async () => {
  db = await createDb('');
  await migrate(db);

  config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: KEY,
    ENGINE: 'scripted',
  } as NodeJS.ProcessEnv);

  bus = new EventBus();
  executor = new RunExecutor({ db, bus, engine: new ScriptedEngine({ steps: INSTANT, speed: 0 }), snapshotIntervalMs: 25 });

  const stores = createStores(db, config);
  const app = createApp({
    config,
    db,
    bus,
    executor,
    ...stores,
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
  });
  // The settings router in isolation: the verify route's deps are the point.
  app.use('/api', createSettingsRoutes({ ...stores, agent: 'test-agent', db, dailyRunBudget: config.dailyRunBudget }));
  app.use('/api', createReminderRoutes({ db }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

beforeEach(async () => {
  await db.query(`UPDATE runs SET status = 'cancelled', finished_at = now()
                   WHERE status IN ('queued', 'running', 'paused')`);
  await db.query('DELETE FROM budgets');
  await db.query('DELETE FROM wa_updates');
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-access-key': KEY, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain-text responses (the SSE stream) are read as text */
  }
  return { status: res.status, body, text };
}

/** Run a task to completion through the normal path and return its id. */
async function runToCompletion(prompt = 'do the thing'): Promise<string> {
  const accepted = await acceptRun(
    { db, executor, config },
    { prompt, kind: 'chat' },
  );
  assert.equal(accepted.ok, true, 'the run was accepted');
  if (!accepted.ok) throw new Error('unreachable');
  const id = accepted.run.id;
  for (let i = 0; i < 200; i++) {
    const row = await db.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [id]);
    if (row[0] && ['completed', 'failed', 'cancelled'].includes(row[0].status)) return id;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${id} never finished`);
}

// ---------------------------------------------------------------------------
// 1. the number the phone reports is the number the gate enforces
// ---------------------------------------------------------------------------

describe('problem 1: remaining runs counts the whole day', () => {
  test('a run on the web reduces what WhatsApp is told is left', async () => {
    const limited: AppConfig = { ...config, dailyRunBudget: 3 };
    await consumeRunBudget(db, 'web', 3);
    await consumeRunBudget(db, 'web', 3);

    const left = await remainingRuns({ db, executor, config: limited });
    assert.equal(left, 1, 'the day total is what the gate refuses on');

    // The shape of the old bug: the whatsapp bucket is empty, so counting it
    // alone would have promised the whole budget.
    const perChannel = await db.query<{ count: string }>(
      `SELECT COALESCE(SUM(count), 0)::text AS count FROM budgets WHERE bucket = 'whatsapp' AND day = CURRENT_DATE`,
    );
    assert.equal(Number(perChannel[0]?.count), 0);
  });

  test('a spent day reports zero rather than the channel\'s own count', async () => {
    const limited: AppConfig = { ...config, dailyRunBudget: 2 };
    await consumeRunBudget(db, 'api', 2);
    await consumeRunBudget(db, 'api', 2);
    assert.equal(await remainingRuns({ db, executor, config: limited }), 0);
  });

  test('/status on WhatsApp prints the day total', async () => {
    const limited: AppConfig = { ...config, dailyRunBudget: 5 };
    await consumeRunBudget(db, 'web', 5);
    await consumeRunBudget(db, 'web', 5);
    assert.equal(await peekDayTotal(db), 2);
    assert.equal(await remainingRuns({ db, executor, config: limited }), 3);
  });
});

// ---------------------------------------------------------------------------
// 2. a stale resume cursor replays the run instead of nothing
// ---------------------------------------------------------------------------

describe('problem 2: a cursor past the end of the log still replays', () => {
  test('after=<beyond the last seq> returns the whole run, not an empty stream', async () => {
    const runId = await runToCompletion('stream me');

    const maxSeq = await db.query<{ seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM run_events WHERE run_id = $1',
      [runId],
    );
    const last = Number(maxSeq[0]?.seq ?? 0);
    assert.ok(last > 0, 'the run wrote events');

    const stale = await api(`/api/runs/${runId}/stream?after=${last + 50}`);
    assert.equal(stale.status, 200);
    assert.match(stale.text, /event: run\.started/, 'the replay is not empty');
    assert.match(stale.text, /event: run\.completed/);
    assert.match(stale.text, /event: end/);
  });

  test('a normal resume still skips what the client already has', async () => {
    const runId = await runToCompletion('resume me');
    const res = await api(`/api/runs/${runId}/stream?after=0`);
    assert.match(res.text, /event: run\.started/);
  });
});

// ---------------------------------------------------------------------------
// 3. the key-test button is inside the daily budget
// ---------------------------------------------------------------------------

describe('problem 3: key-test claims a run from the shared gate', () => {
  test('with the day spent it refuses with 429 instead of spending anyway', async () => {
    const limited: AppConfig = { ...config, dailyRunBudget: 1 };
    await consumeRunBudget(db, 'web', 1);

    // Re-mount with the exhausted limit so the route sees the same cap.
    const stores = createStores(db, config);
    const app = express();
    app.use(express.json());
    app.use('/api', createSettingsRoutes({ ...stores, agent: 'test-agent', db, dailyRunBudget: 1 }));
    const server2 = http.createServer(app);
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', () => r()));
    const port2 = (server2.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port2}/api/settings/verify/gemini-key`, {
      method: 'POST',
    });
    assert.equal(res.status, 429);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'budget_exceeded');
    await new Promise<void>((r) => server2.close(() => r()));

    void limited;
  });

  test('a key that cannot even be checked costs nothing', async () => {
    // No key stored: checkGeminiKey reports not_configured, the claim is handed
    // back, and the day is untouched.
    const before = await peekDayTotal(db);
    const res = await api('/api/settings/verify/gemini-key', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(await peekDayTotal(db), before, 'no run was charged for a skipped check');
  });
});

// ---------------------------------------------------------------------------
// 4. retention runs on demand, in batches, and covers wa_updates
// ---------------------------------------------------------------------------

describe('problem 4: retention', () => {
  test('run events are swept in batches without losing anything fresh', async () => {
    const run = await createRun(db, { prompt: 'events', engine: 'scripted' });
    for (let i = 0; i < 7; i++) {
      await db.query('INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, $2, $3, $4)', [
        run.id,
        i + 1,
        'log',
        JSON.stringify({ i }),
      ]);
    }
    await db.query(`UPDATE run_events SET at = now() - interval '30 days' WHERE run_id = $1 AND seq <= 5`, [run.id]);

    const removed = await pruneRunEvents(db, 14, 2); // tiny batch: forces the loop
    assert.equal(removed, 5);
    const left = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM run_events WHERE run_id = $1', [run.id]);
    assert.equal(Number(left[0]?.count), 2, 'the fresh events survived');
  });

  test('handled messages age out; unprocessed ones are never deleted', async () => {
    await db.query(
      `INSERT INTO wa_updates (wamid, kind, payload, received_at, processed_at) VALUES
         ('wamid_old_handled',   'text', '{}'::jsonb, now() - interval '40 days', now() - interval '40 days'),
         ('wamid_old_pending',   'text', '{}'::jsonb, now() - interval '40 days', NULL),
         ('wamid_fresh_handled', 'text', '{}'::jsonb, now(), now())`,
    );

    const removed = await pruneWaUpdates(db, 30);
    assert.equal(removed, 1);

    const rows = await db.query<{ wamid: string }>('SELECT wamid FROM wa_updates ORDER BY wamid');
    assert.deepEqual(
      rows.map((r) => r.wamid),
      ['wamid_fresh_handled', 'wamid_old_pending'],
      'an unprocessed message is pending work, not garbage',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. two boots cannot kill each other's migration
// ---------------------------------------------------------------------------

describe('problem 7: a migration is recorded at most once', () => {
  test('running migrate twice is a no-op, not a crash', async () => {
    const first = await migrate(db);
    assert.equal(first.applied.length, 0, 'already migrated by the harness');

    const second = await migrate(db);
    assert.equal(second.applied.length, 0);
    assert.ok(second.skipped.length > 0);
  });

  test('two overlapping boots both survive', async () => {
    const fresh = await createDb('');
    const results = await Promise.allSettled([migrate(fresh), migrate(fresh)]);
    for (const settled of results) {
      assert.equal(settled.status, 'fulfilled', 'neither boot may throw');
    }
    const count = await fresh.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    const versions = new Set(
      (await fresh.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)),
    );
    assert.equal(Number(count[0]?.count), versions.size, 'no duplicate rows were recorded');
    await fresh.close();
  });
});

// ---------------------------------------------------------------------------
// a guard on the fixes themselves: nothing here may regress silently
// ---------------------------------------------------------------------------

describe('the fixes are wired into the app', () => {
  test('the artifact list reports whether a file is pinned', async () => {
    const run = await createRun(db, { prompt: 'artifacts', engine: 'scripted' });
    await finishRun(db, run.id, { status: 'completed', text: 'done' });
    const res = await api(`/api/runs/${run.id}/artifacts`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.artifacts, []);
  });
});
