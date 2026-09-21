/**
 * Auth tests — the regression guard for deny-by-default.
 *
 * The first version of `requireSession` read `req.path` inside a middleware
 * mounted at `/api`, where Express makes it relative ("/status"), so every
 * request fell through unauthenticated. These tests exist so that can never
 * happen again silently.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from './app.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig } from './config.js';
import { createSession, verifySession, readCookie, isPublicRoute, checkPassword } from './auth.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const PASSWORD = 'operator-password-for-tests';

let db: Db;
let server: Server;
let base: string;

before(async () => {
  db = await createDb('');
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    OPERATOR_PASSWORD: PASSWORD,
  } as NodeJS.ProcessEnv);

  const app = createApp({
    config,
    db,
    bus: new EventBus(),
    executor: new RunExecutor({ db, bus: new EventBus(), engine: new ScriptedEngine() }),
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0, poller: 'disabled' },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

describe('session tokens', () => {
  test('round-trip', () => {
    const token = createSession(SECRET);
    assert.equal(verifySession(token, SECRET), true);
  });

  test('reject a token signed with a different secret', () => {
    assert.equal(verifySession(createSession(SECRET), 'a-different-secret'), false);
  });

  test('reject a tampered payload', () => {
    const token = createSession(SECRET);
    const [, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9 })).toString('base64url');
    assert.equal(verifySession(`${forged}.${mac}`, SECRET), false);
  });

  test('reject an expired token', () => {
    const token = createSession(SECRET, Date.now() - 1000 * 60 * 60 * 24 * 31);
    assert.equal(verifySession(token, SECRET), false);
  });

  test('reject malformed input', () => {
    for (const bad of [undefined, '', 'no-dot', '.', 'a.b.c']) {
      assert.equal(verifySession(bad, SECRET), false);
    }
  });
});

describe('cookie parsing', () => {
  test('find a cookie among many', () => {
    const req = { headers: { cookie: 'a=1; ac_session=abc.def; b=2' } } as never;
    assert.equal(readCookie(req, 'ac_session'), 'abc.def');
  });

  test('return undefined when absent', () => {
    assert.equal(readCookie({ headers: {} } as never, 'ac_session'), undefined);
  });
});

describe('public route list', () => {
  test('only health and login are public', () => {
    assert.equal(isPublicRoute('GET', '/healthz'), true);
    assert.equal(isPublicRoute('GET', '/readyz'), true);
    assert.equal(isPublicRoute('POST', '/api/auth/login'), true);
    // Health is GET-only.
    assert.equal(isPublicRoute('POST', '/healthz'), false);
    // Everything else is denied.
    assert.equal(isPublicRoute('GET', '/api/status'), false);
    assert.equal(isPublicRoute('GET', '/api/memory'), false);
    assert.equal(isPublicRoute('GET', '/api/runs'), false);
    assert.equal(isPublicRoute('POST', '/api/runs'), false);
  });
});

describe('password check', () => {
  test('accepts the exact password only', () => {
    assert.equal(checkPassword(PASSWORD, PASSWORD), true);
    assert.equal(checkPassword('wrong', PASSWORD), false);
    assert.equal(checkPassword(undefined, PASSWORD), false);
    assert.equal(checkPassword(123, PASSWORD), false);
    assert.equal(checkPassword(PASSWORD, ''), false);
  });
});

describe('http surface (deny by default)', () => {
  test('public endpoints answer without a session', async () => {
    for (const path of ['/healthz', '/readyz']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} should be public`);
    }
  });

  test('every /api route is 401 without a session', async () => {
    const paths = ['/api/status', '/api/memory', '/api/runs', '/api/whatsapp/status'];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} must not be reachable unauthenticated`);
    }
  });

  test('a wrong bearer token is rejected', async () => {
    const res = await fetch(`${base}/api/status`, {
      headers: { Authorization: 'Bearer not-the-secret' },
    });
    assert.equal(res.status, 401);
  });

  test('login rejects a bad password and accepts the real one', async () => {
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(good.status, 200);

    const cookie = good.headers.get('set-cookie') ?? '';
    assert.match(cookie, /ac_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const authed = await fetch(`${base}/api/status`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(authed.status, 200, 'a valid session must be accepted');

    const body = (await authed.json()) as { version: number; dailyRunBudget: number };
    assert.equal(body.version, 2);
    assert.equal(body.dailyRunBudget, 100);
  });

  test('a bearer token equal to the session secret is accepted (for scripts)', async () => {
    const res = await fetch(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 200);
  });

  test('unknown /api routes return JSON 404, not HTML', async () => {
    const res = await fetch(`${base}/api/does-not-exist`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});
