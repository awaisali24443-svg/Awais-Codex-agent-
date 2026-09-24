/**
 * Breakage alerts.
 *
 * The claim being tested is the anti-spam contract: each incident fires
 * exactly once per day, a transient poller blip is not breakage, nothing
 * goes out without a token, and a send failure never throws — while a real
 * poller death, a rejected engine key, and a spent budget each produce a
 * message.
 */
import test, { after, afterEach, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from '../db.js';
import { migrate } from '../migrate.js';
import { createRun, setRunStatus } from '../runs.js';
import type { SecretName } from '../settings.js';
import { saveCreatorId } from './store.js';
import { DISABLED_HEALTH, type PollerHealth } from './poller.js';
import {
  composeAlertMessage,
  maybeSendBreakageAlerts,
  POLLER_STALE_MS,
  type AlertDeps,
  type AlertIncident,
} from './alerts.js';

const TOKEN = 'wa-agent-api-key-from-the-phone';
const CREATOR = 'user:creator-01';
const NOW = new Date('2026-09-23T12:00:00+05:00');

let db: Db;

interface CapturedSend {
  body: Record<string, unknown>;
}

/** A stand-in for the agent API that only records outbound sends. */
async function fakePlatform(opts: { failSends?: boolean } = {}): Promise<{
  url: string;
  sends: CapturedSend[];
  close(): Promise<void>;
}> {
  const sends: CapturedSend[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/messages') {
        sends.push({ body: JSON.parse(raw) as Record<string, unknown> });
        if (opts.failSends) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'platform is down' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: 'wamid.1' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const secrets = (token: string | null) => ({
  get: (name: SecretName) => (token && name === 'whatsapp_token' ? token : ''),
});

const healthyPoller = () => ({
  running: true,
  health: (): PollerHealth => ({ ...DISABLED_HEALTH, state: 'running' as const }),
});

const deadPoller = (lastPollAt: string | null, lastError: string | null = 'connection refused') => ({
  running: true,
  health: (): PollerHealth => ({
    ...DISABLED_HEALTH,
    state: 'error' as const,
    lastPollAt,
    lastError,
  }),
});

function staleIso(): string {
  return new Date(NOW.getTime() - POLLER_STALE_MS - 60_000).toISOString();
}

const baseDeps = (overrides: Partial<AlertDeps> = {}): AlertDeps => ({
  db,
  config: { breakageAlertsEnabled: true, dailyRunBudget: 100, pollerMode: 'auto' },
  secrets: secrets(TOKEN),
  whatsapp: healthyPoller(),
  now: () => NOW,
  ...overrides,
});

/** Spend the whole day's budget through the bookkeeping row. */
async function spendBudget(): Promise<void> {
  await db.query(`INSERT INTO budgets (day, bucket, count) VALUES (CURRENT_DATE, 'web', 100)`);
}

/** A run that died on the engine's auth-failure code, just now. */
async function authFailedRun(): Promise<void> {
  const run = await createRun(db, { prompt: 'Do research', kind: 'chat', engine: 'scripted' });
  await setRunStatus(db, run.id, 'failed', {
    errorType: 'auth_failed',
    errorMessage: 'API key rejected: invalid',
  });
}

before(async () => {
  db = await createDb('');
  await migrate(db);
  await saveCreatorId(db, 'agent-test', CREATOR);
});

after(async () => {
  await db.close();
});

afterEach(async () => {
  await db.query(`DELETE FROM runs`);
  await db.query(`DELETE FROM budgets`);
  await db.query(`DELETE FROM breakage_alert_log`);
});

describe('composeAlertMessage', () => {
  test('one short message naming every incident', () => {
    const incidents: AlertIncident[] = [
      { type: 'poller_down', detail: 'the poller stopped unexpectedly' },
      { type: 'engine_auth', detail: 'the engine API key was rejected' },
      { type: 'budget_spent', detail: "today's task budget is used up (100/100)" },
    ];
    const message = composeAlertMessage(incidents);
    assert.ok(message.startsWith('⚠️ WAIS needs you'));
    assert.ok(message.includes('WhatsApp poller down'));
    assert.ok(message.includes('Engine API key rejected'));
    assert.ok(message.includes('Daily budget spent'));
    assert.doesNotMatch(message, /\|/);
  });
});

describe('maybeSendBreakageAlerts', () => {
  test('each incident fires exactly once per day', async () => {
    const platform = await fakePlatform();
    try {
      await spendBudget();
      await authFailedRun();
      const deps = baseDeps({
        baseUrl: platform.url,
        fetchImpl: fetch,
        whatsapp: deadPoller(staleIso()),
      });
      const fired = await maybeSendBreakageAlerts(deps);
      assert.deepEqual(fired.sort(), ['budget_spent', 'engine_auth', 'poller_down']);
      assert.equal(platform.sends.length, 1); // one combined message, not three
      const sentBody = platform.sends[0].body as { text?: { body?: string } };
      const text = sentBody.text?.body ?? '';
      assert.ok(text.includes('WhatsApp poller down'));
      assert.ok(text.includes('Engine API key rejected'));
      assert.ok(text.includes('Daily budget spent'));

      const firedAgain = await maybeSendBreakageAlerts(deps);
      assert.deepEqual(firedAgain, []); // the day is claimed — no second message
      assert.equal(platform.sends.length, 1);
    } finally {
      await platform.close();
    }
  });

  test('a quiet system sends nothing', async () => {
    const platform = await fakePlatform();
    try {
      const fired = await maybeSendBreakageAlerts(baseDeps({ baseUrl: platform.url, fetchImpl: fetch }));
      assert.deepEqual(fired, []);
      assert.equal(platform.sends.length, 0);
    } finally {
      await platform.close();
    }
  });

  test('a transient poller blip is not breakage', async () => {
    const platform = await fakePlatform();
    try {
      const fired = await maybeSendBreakageAlerts(
        baseDeps({
          baseUrl: platform.url,
          fetchImpl: fetch,
          // In 'error' but polled successfully a minute ago: backoff, not breakage.
          whatsapp: deadPoller(new Date(NOW.getTime() - 60_000).toISOString()),
        }),
      );
      assert.deepEqual(fired, []);
      assert.equal(platform.sends.length, 0);
    } finally {
      await platform.close();
    }
  });

  test('a poller that vanished entirely is breakage', async () => {
    const platform = await fakePlatform();
    try {
      const fired = await maybeSendBreakageAlerts(
        baseDeps({
          baseUrl: platform.url,
          fetchImpl: fetch,
          whatsapp: { running: false, health: () => DISABLED_HEALTH },
        }),
      );
      assert.deepEqual(fired, ['poller_down']);
      assert.equal(platform.sends.length, 1);
    } finally {
      await platform.close();
    }
  });

  test('no token means silence, not an error', async () => {
    const platform = await fakePlatform();
    try {
      await spendBudget();
      const fired = await maybeSendBreakageAlerts(
        baseDeps({ secrets: secrets(null), baseUrl: platform.url, fetchImpl: fetch }),
      );
      assert.deepEqual(fired, []);
      assert.equal(platform.sends.length, 0);
    } finally {
      await platform.close();
    }
  });

  test('disabled toggle means silence', async () => {
    const platform = await fakePlatform();
    try {
      await spendBudget();
      const deps = baseDeps({ baseUrl: platform.url, fetchImpl: fetch });
      deps.config.breakageAlertsEnabled = false;
      const fired = await maybeSendBreakageAlerts(deps);
      assert.deepEqual(fired, []);
      assert.equal(platform.sends.length, 0);
    } finally {
      await platform.close();
    }
  });

  test('a failed send never throws', async () => {
    const platform = await fakePlatform({ failSends: true });
    try {
      await spendBudget();
      const fired = await maybeSendBreakageAlerts(
        baseDeps({ baseUrl: platform.url, fetchImpl: fetch }),
      );
      assert.deepEqual(fired, []);
      assert.equal(platform.sends.length, 1); // attempted, then swallowed
    } finally {
      await platform.close();
    }
  });

  test('auth failures older than the window do not alert', async () => {
    const platform = await fakePlatform();
    try {
      const run = await createRun(db, { prompt: 'Old research', kind: 'chat', engine: 'scripted' });
      await setRunStatus(db, run.id, 'failed', { errorType: 'auth_failed' });
      await db.query(`UPDATE runs SET finished_at = $2 WHERE id = $1`, [
        run.id,
        new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
      ]);
      const fired = await maybeSendBreakageAlerts(baseDeps({ baseUrl: platform.url, fetchImpl: fetch }));
      assert.deepEqual(fired, []);
      assert.equal(platform.sends.length, 0);
    } finally {
      await platform.close();
    }
  });
});
