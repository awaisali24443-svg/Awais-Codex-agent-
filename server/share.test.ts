/**
 * Shareable replay tests.
 *
 * The promise under test: a finished run can be shared as a public read-only
 * page via an unguessable link, revocable by the operator — and the public
 * page can never leak anything sensitive. Covers token shape/entropy, the
 * finished-only gate, enable/revoke routes, the public page rendering +
 * redaction, and the 404s for unknown/malformed/revoked tokens.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import {
  createRun,
  getRun,
  getRunByShareToken,
  setRunStatus,
  setShareToken,
  saveRunPlan,
  type Run,
} from './runs.js';
import { finishRun } from './runs.js';
import {
  buildShareData,
  canShareRun,
  newShareToken,
  renderSharePage,
} from './share.js';
import { createApp } from './app.js';
import { createStores } from './settings.js';
import { loadConfig, type AppConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';

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
  await db.query('DELETE FROM messages');
});

describe('share tokens', () => {
  test('newShareToken is URL-safe, long, and unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = newShareToken();
      assert.match(token, /^[A-Za-z0-9_-]+$/);
      assert.ok(token.length >= 32, `token too short: ${token.length}`);
      assert.ok(!seen.has(token), 'duplicate token generated');
      seen.add(token);
    }
  });

  test('canShareRun allows only finished runs', () => {
    const base = { status: 'completed' } as Run;
    for (const status of ['completed', 'failed', 'cancelled', 'paused']) {
      assert.equal(canShareRun({ ...base, status: status as Run['status'] }), true, status);
    }
    for (const status of ['queued', 'running', 'awaiting_plan']) {
      assert.equal(canShareRun({ ...base, status: status as Run['status'] }), false, status);
    }
  });

  test('setShareToken / getRunByShareToken round-trip; null revokes', async () => {
    const run = await createRun(db, { prompt: 'share me', engine: 'scripted' });
    await finishRun(db, run.id, { status: 'completed', text: 'done' });
    assert.equal(await getRunByShareToken(db, 'nope'), null);
    const token = newShareToken();
    await setShareToken(db, run.id, token);
    assert.equal((await getRunByShareToken(db, token))?.id, run.id);
    assert.equal((await getRun(db, run.id))?.shareToken, token);
    await setShareToken(db, run.id, null);
    assert.equal(await getRunByShareToken(db, token), null);
  });
});

describe('share data redaction', () => {
  test('the public page never contains engine handles or secrets', async () => {
    const run = await createRun(db, { prompt: 'redact <script>alert(1)</script>', engine: 'scripted' });
    // Plant the sensitive values a real run carries.
    await db.query(
      `UPDATE runs SET interaction_id = 'iant_secret_123', environment_id = 'env_secret_456',
                       verification_json = $2 WHERE id = $1`,
      [run.id, JSON.stringify([{ name: 'answer', passed: true, evidence: 'ok' }])],
    );
    await saveRunPlan(db, run.id, [{ index: 1, total: 1, label: 'do it' }]);
    await finishRun(db, run.id, { status: 'completed', text: 'the answer' });
    const reloaded = (await getRun(db, run.id)) as Run;

    const data = await buildShareData(db, reloaded);
    const dataJson = JSON.stringify(data);
    assert.ok(!dataJson.includes('iant_secret_123'), 'interaction id leaked into share data');
    assert.ok(!dataJson.includes('env_secret_456'), 'environment id leaked into share data');

    const html = renderSharePage(data);
    assert.ok(!html.includes('iant_secret_123'), 'interaction id leaked into HTML');
    assert.ok(!html.includes('env_secret_456'), 'environment id leaked into HTML');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'prompt not escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'prompt escaping missing');
    assert.ok(html.includes('the answer'), 'final answer missing from page');
    assert.ok(html.includes('do it'), 'plan step missing from page');
  });
});

const ACCESS_KEY = 'share-replay-access-key-for-tests';

function makeConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'key',
    ACCESS_KEY,
    SESSION_SECRET: 'test-session-secret-that-is-definitely-long-enough',
    ENGINE: 'scripted',
    DAILY_RUN_BUDGET: '50',
    APP_URL: 'https://replay-test.example',
  } as NodeJS.ProcessEnv);
}

describe('share routes', () => {
  let agent: Server;
  let base: string;
  let executor: RunExecutor;
  const auth = { 'x-access-key': ACCESS_KEY };

  before(async () => {
    const config = makeConfig();
    executor = new RunExecutor({
      db,
      bus: new EventBus(),
      engine: new ScriptedEngine({ steps: [], speed: 0 }),
    });
    const app = createApp({
      config,
      db,
      bus: new EventBus(),
      executor,
      ...createStores(db, config),
      status: { startedAt: Date.now(), migrationsApplied: 13, orphanedRuns: 0 },
    });
    agent = http.createServer(app);
    await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => agent.close(() => resolve()));
    await executor.shutdown();
  });

  async function api(pathname: string, method: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${base}${pathname}`, { method, headers: auth });
    return { status: res.status, body: await res.text() };
  }

  test('full lifecycle: share → public page → revoke → 404', async () => {
    const run = await createRun(db, { prompt: 'lifecycle mission', engine: 'scripted' });
    await finishRun(db, run.id, { status: 'completed', text: 'final words' });

    const enabled = await api(`/api/runs/${run.id}/share`, 'POST');
    assert.equal(enabled.status, 200);
    const { url, token } = JSON.parse(enabled.body);
    assert.equal(url, `https://replay-test.example/share/${token}`);

    // Enabling twice returns the same link.
    const again = await api(`/api/runs/${run.id}/share`, 'POST');
    assert.equal(JSON.parse(again.body).token, token);

    // The public page needs no auth and renders the timeline.
    const page = await fetch(`${base}/share/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('lifecycle mission'), 'prompt missing from public page');
    assert.ok(html.includes('final words'), 'answer missing from public page');

    // Revoke: the URL dies immediately.
    const revoked = await api(`/api/runs/${run.id}/share`, 'DELETE');
    assert.equal(revoked.status, 200);
    const gone = await fetch(`${base}/share/${token}`);
    assert.equal(gone.status, 404);
  });

  test('in-flight runs cannot be shared', async () => {
    const run = await createRun(db, { prompt: 'not finished', engine: 'scripted' });
    const res = await api(`/api/runs/${run.id}/share`, 'POST');
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'not_finished');
  });

  test('unknown and malformed tokens 404 without hints', async () => {
    const unknown = await fetch(`${base}/share/${newShareToken()}`);
    assert.equal(unknown.status, 404);
    const malformed = await fetch(`${base}/share/not-a-token!!`);
    assert.equal(malformed.status, 404);
    // Note: /share/ with no token at all falls through to the SPA shell like
    // every other unknown path — no data, just the app. Out of scope here.
  });

  test('a shared run that is resumed stops being public', async () => {
    const run = await createRun(db, { prompt: 'resumed mission', engine: 'scripted' });
    await setRunStatus(db, run.id, 'paused');
    const token = newShareToken();
    await setShareToken(db, run.id, token);
    assert.equal((await fetch(`${base}/share/${token}`)).status, 200);
    // Resume flips it back to queued — the link must stop working.
    await setRunStatus(db, run.id, 'queued');
    assert.equal((await fetch(`${base}/share/${token}`)).status, 404);
  });
});
