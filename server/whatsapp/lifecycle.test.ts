/**
 * The WhatsApp connection's lifetime.
 *
 * The claim being tested is the one the setup instructions make: the agent API
 * key WhatsApp generates is the *only* thing needed. That is only true if
 * storing it starts the poll and removing it stops the poll, on the running
 * process — so these tests drive the real HTTP surface (`PUT`/`DELETE` on
 * `/api/settings/secrets/whatsapp_token`) against a fake platform and watch what
 * the service does.
 *
 * The fake platform is deliberately hostile in one place: a second poller for
 * the same agent is a 409. If `sync()` ever started two loops, or left a stopped
 * one polling, this would show up here rather than in production as a
 * connection nobody can take over.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from '../db.js';
import { migrate } from '../migrate.js';
import { loadConfig, type AppConfig } from '../config.js';
import { createApp } from '../app.js';
import { createStores } from '../settings.js';
import { EventBus } from '../events.js';
import { RunExecutor } from '../executor.js';
import { ScriptedEngine } from '../engine/scripted.js';
import { acceptRun } from '../accept.js';
import { WhatsAppService } from './lifecycle.js';
import { WhatsAppPoller } from './poller.js';

const MASTER_KEY = 'd4e5f6a7'.repeat(8);
const ACCESS_KEY = 'whatsapp-lifecycle-test-key';
const SESSION_SECRET = 'lifecycle-session-secret-long-enough-to-pass';
const TOKEN = 'wa-agent-api-key-from-the-phone';

let db: Db;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'key',
      ACCESS_KEY,
      SESSION_SECRET,
      MASTER_KEY,
      ENGINE: 'scripted',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

/**
 * A stand-in for `https://api.whatsapp.com/agent/v1`.
 *
 * It answers the long poll with an empty batch immediately, so the loop spins
 * far faster than the real 25-second poll and the assertions do not have to wait
 * for a real timeout.
 */
interface FakePlatform {
  base: string;
  close: () => Promise<void>;
  polls: () => number;
  unauthorised: () => number;
  lastAuthHeader: () => string | null;
}

async function fakePlatform(): Promise<FakePlatform> {
  let polls = 0;
  let unauthorised = 0;
  let lastAuthHeader: string | null = null;

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    lastAuthHeader = auth;

    if (auth !== `Bearer ${TOKEN}`) {
      unauthorised += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad token', code: 190 } }));
      return;
    }

    if (req.url?.startsWith('/updates')) {
      polls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ updates: [], next_offset: polls * 10 }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    polls: () => polls,
    unauthorised: () => unauthorised,
    lastAuthHeader: () => lastAuthHeader,
  };
}

/** Wait for a condition instead of sleeping a fixed amount. */
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never became true');
}

interface Harness {
  config: AppConfig;
  service: WhatsAppService;
  base: string;
  close: () => Promise<void>;
  secrets: ReturnType<typeof createStores>['secrets'];
}

async function harness(options: {
  platform: string;
  config?: Partial<AppConfig>;
  token?: string;
}): Promise<Harness> {
  const config = makeConfig({
    whatsappApiBase: options.platform,
    ...(options.token ? { whatsappToken: options.token } : {}),
    ...(options.config ?? {}),
  });

  const bus = new EventBus();
  const executor = new RunExecutor({ db, bus, engine: new ScriptedEngine() });
  const stores = createStores(db, config);

  const service = new WhatsAppService({
    db,
    bus,
    executor,
    config,
    secrets: stores.secrets,
    accept: (input) => acceptRun({ db, executor, config }, input),
    log: () => {},
    // The loop's real 4-second floor between polls exists to stay under the
    // platform's rate limit; here it would just make every assertion wait.
    createPoller: (deps) =>
      new WhatsAppPoller({ ...deps, pollTimeoutSeconds: 1, minPollIntervalMs: 5, minBackoffMs: 5 }),
  });

  const app = createApp({
    config,
    db,
    bus,
    executor,
    settings: stores.settings,
    secrets: stores.secrets,
    onCredentialChanged: async () => {
      await service.sync('credential changed');
    },
    status: {
      startedAt: Date.now(),
      migrationsApplied: 1,
      orphanedRuns: 0,
      poller: () => service.health(),
    },
  });

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  return {
    config,
    service,
    secrets: stores.secrets,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await service.shutdown();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}

const auth = { 'x-access-key': ACCESS_KEY, 'content-type': 'application/json' };

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("DELETE FROM secrets WHERE name = 'whatsapp_token'");
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

describe('POLLER_ENABLED', () => {
  test('defaults to auto: no token, nothing polling, no complaint at boot', () => {
    const config = makeConfig();
    assert.equal(config.pollerMode, 'auto');
    assert.equal(config.pollerEnabled, false, 'nothing to poll with yet');
  });

  test('a token in the environment means polling, with no second variable to set', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ENGINE: 'scripted',
      WHATSAPP_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv);
    assert.equal(config.pollerMode, 'auto');
    assert.equal(config.pollerEnabled, true);
  });

  test('false is a hard stop — this is how a second host stays quiet', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ENGINE: 'scripted',
      POLLER_ENABLED: 'false',
      WHATSAPP_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv);
    assert.equal(config.pollerMode, 'off');
    assert.equal(config.pollerEnabled, false, 'a token must not override an explicit false');
  });

  test('true with no token anywhere is still the silent-spin trap it always was', () => {
    assert.throws(
      () => loadConfig({ POLLER_ENABLED: 'true' } as NodeJS.ProcessEnv),
      /WHATSAPP_TOKEN is empty/,
    );
  });

  test('true with a MASTER_KEY is not an error: the key can still arrive from Settings', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ENGINE: 'scripted',
      POLLER_ENABLED: 'true',
      MASTER_KEY,
    } as NodeJS.ProcessEnv);
    assert.equal(config.pollerMode, 'on');
    assert.equal(config.pollerEnabled, false);
  });

  test('a nonsense value is refused rather than guessed', () => {
    assert.throws(
      () => loadConfig({ POLLER_ENABLED: 'maybe' } as NodeJS.ProcessEnv),
      /POLLER_ENABLED must be true\/false/,
    );
  });
});

// ---------------------------------------------------------------------------
// the connection
// ---------------------------------------------------------------------------

describe('storing the agent API key connects WhatsApp', () => {
  test('PUT starts the poll, and it is really talking to the platform', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base });

    try {
      assert.equal(h.service.running, false);

      const res = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      assert.equal(res.status, 200);

      const body = (await res.json()) as { whatsapp: { state: string; detail: string | null } };
      assert.equal(body.whatsapp.state, 'running', 'the response should say it connected');
      assert.equal(body.whatsapp.detail, null);

      assert.equal(h.service.running, true);
      assert.equal(h.config.pollerEnabled, true, 'the resolved flag must say so too');

      // Not just "an object exists": real requests, with the token in the header.
      await until(() => platform.polls() > 0);
      assert.equal(platform.unauthorised(), 0);
      assert.equal(platform.lastAuthHeader(), `Bearer ${TOKEN}`);

      // And the health an operator reads reports the connection.
      const ready = await fetch(`${h.base}/readyz`);
      const readyBody = (await ready.json()) as { checks: Record<string, string> };
      assert.equal(readyBody.checks.poller, 'running');
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('removing the key stops the poll instead of leaving it running on a dead token', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base });

    try {
      await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      assert.equal(h.service.running, true);
      await until(() => platform.polls() > 0);

      const res = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'DELETE',
        headers: auth,
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        whatsapp: { state: string; mode: string; detail: string | null };
      };
      assert.equal(body.whatsapp.state, 'disabled');
      assert.equal(body.whatsapp.mode, 'disconnected', '"connected" must mean polling, not "had a poller"');
      assert.match(body.whatsapp.detail ?? '', /agent API key/);
      assert.equal(h.service.running, false);

      // Nothing was refused: the loop is gone, not merely failing.
      assert.equal(platform.unauthorised(), 0);

      // A poll already in flight when the key was removed can still land on the
      // fake platform, so settle first and then require the count to be stable
      // rather than comparing against a number sampled before that request
      // arrived — that comparison is a race, and it failed exactly once in CI.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const settled = platform.polls();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(platform.polls(), settled, 'the stopped poller kept polling');
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('replacing the key keeps exactly one poller, and it uses the new value', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base });

    try {
      const first = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      assert.equal(first.status, 200);
      await until(() => platform.polls() > 0);

      // Same value again: the loop must not be torn down and rebuilt, because a
      // second poller on the same agent is what the platform answers with 409.
      const again = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      assert.equal(again.status, 200);
      const body = (await again.json()) as { whatsapp: { state: string; agentId: string | null } };
      assert.equal(body.whatsapp.state, 'running');

      await until(() => platform.polls() > 1);
      assert.equal(platform.unauthorised(), 0, 'the poller should be using the stored token');
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('POLLER_ENABLED=false means the key is stored and the poll stays off', async () => {
    const platform = await fakePlatform();
    const h = await harness({
      platform: platform.base,
      config: { pollerMode: 'off', pollerEnabled: false },
    });

    try {
      const res = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      assert.equal(res.status, 200, 'the key is still stored — it is this host that stays quiet');

      const body = (await res.json()) as { whatsapp: { state: string; detail: string | null } };
      assert.equal(body.whatsapp.state, 'disabled');
      assert.match(body.whatsapp.detail ?? '', /POLLER_ENABLED=false/);
      assert.equal(h.service.running, false);
      assert.equal(platform.polls(), 0);
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('a wrong key does not fail the save — it connects and reports the platform error', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base });

    try {
      const res = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: 'not-the-right-key' }),
      });
      // The value is stored, and the reason it does not work is visible rather
      // than lost in a 500.
      assert.equal(res.status, 200);

      await until(() => platform.unauthorised() > 0);
      await until(() => h.service.health().state === 'error');
      assert.match(h.service.health().lastError ?? '', /401|token|auth/i);
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('the panel reports the connection state and never the key', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base });

    try {
      await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      const res = await fetch(`${h.base}/api/settings`, { headers: auth });
      const raw = await res.text();
      assert.equal(raw.includes(TOKEN), false, 'the API leaked the token');

      const body = JSON.parse(raw) as {
        whatsapp: { state: string; mode: string };
        secrets: Array<{ name: string; source: string }>;
      };
      assert.equal(body.whatsapp.state, 'running');
      assert.equal(body.whatsapp.mode, 'connected');
      assert.equal(body.secrets.find((s) => s.name === 'whatsapp_token')?.source, 'stored');
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('an environment token takes over again when the stored one is removed', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base, token: TOKEN });

    try {
      // Stored copy on top of an environment value: same string here, but the
      // point is which one the store reports and what survives the delete.
      await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ value: TOKEN }),
      });
      assert.equal(h.secrets.source('whatsapp_token'), 'stored');

      const res = await fetch(`${h.base}/api/settings/secrets/whatsapp_token`, {
        method: 'DELETE',
        headers: auth,
      });
      const body = (await res.json()) as { whatsapp: { state: string }; source: string };
      assert.equal(body.source, 'environment');
      assert.equal(body.whatsapp.state, 'running', 'WHATSAPP_TOKEN is still set — polling continues');
      assert.equal(h.service.running, true);
    } finally {
      await h.close();
      await platform.close();
    }
  });

  test('sync is safe to call repeatedly, and shutdown leaves nothing polling', async () => {
    const platform = await fakePlatform();
    const h = await harness({ platform: platform.base, token: TOKEN });

    try {
      assert.equal(await h.service.sync('one'), 'started');
      assert.equal(await h.service.sync('two'), 'unchanged');
      assert.equal(h.service.running, true);

      await h.service.shutdown();
      assert.equal(h.service.running, false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const settled = platform.polls();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(platform.polls(), settled);
    } finally {
      await h.close();
      await platform.close();
    }
  });
});
