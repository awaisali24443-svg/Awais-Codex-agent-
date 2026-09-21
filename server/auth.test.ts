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
import {
  SESSION_TTL_MS,
  checkAccessKey,
  createSession,
  isPublicRoute,
  readCookie,
  verifySession,
} from './auth.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'access-key-for-tests-123456';

let db: Db;
let server: Server;
let base: string;

before(async () => {
  db = await createDb('');
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: ACCESS_KEY,
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
    // Derived from the real TTL: a hardcoded 31 days silently stopped testing
    // expiry the moment the session lifetime changed.
    const token = createSession(SECRET, Date.now() - SESSION_TTL_MS - 60_000);
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
  test('only the health checks are public', () => {
    assert.equal(isPublicRoute('GET', '/healthz'), true);
    assert.equal(isPublicRoute('GET', '/readyz'), true);
    // The sign-in screen posts here; it is how a session is obtained.
    assert.equal(isPublicRoute('POST', '/api/auth/login'), true);
    // A GET on it is not public — only the exact method that is needed.
    assert.equal(isPublicRoute('GET', '/api/auth/login'), false);
    // Health is GET-only.
    assert.equal(isPublicRoute('POST', '/healthz'), false);
    // Everything else is denied.
    assert.equal(isPublicRoute('GET', '/api/status'), false);
    assert.equal(isPublicRoute('GET', '/api/memory'), false);
    assert.equal(isPublicRoute('GET', '/api/runs'), false);
    assert.equal(isPublicRoute('POST', '/api/runs'), false);
  });
});

describe('access key check', () => {
  test('accepts the exact key only', () => {
    assert.equal(checkAccessKey(ACCESS_KEY, ACCESS_KEY), true);
    assert.equal(checkAccessKey('wrong', ACCESS_KEY), false);
    assert.equal(checkAccessKey(undefined, ACCESS_KEY), false);
    assert.equal(checkAccessKey(123, ACCESS_KEY), false);
    assert.equal(checkAccessKey(ACCESS_KEY, ''), false);
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

  test('the ?k= link hands back a session and strips the key', async () => {
    const claimed = await fetch(`${base}/api/status?k=${ACCESS_KEY}`, {
      // A browser navigation: the key must not stay in the address bar.
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    });
    assert.equal(claimed.status, 302);
    assert.equal(claimed.headers.get('location'), '/api/status');

    const cookie = claimed.headers.get('set-cookie') ?? '';
    assert.match(cookie, /ac_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const authed = await fetch(`${base}/api/status`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(authed.status, 200, 'the session from the link must be accepted');

    const body = (await authed.json()) as { version: number; dailyRunBudget: number };
    assert.equal(body.version, 2);
    assert.equal(body.dailyRunBudget, 100);
  });

  test('a wrong key is refused and sets no session', async () => {
    const res = await fetch(`${base}/api/status?k=not-the-key`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null, 'a bad key must never mint a session');
  });

  test('curl-style requests are served directly instead of redirected', async () => {
    // No text/html in Accept: a script asking with ?k= wants an answer, not a
    // redirect it has to follow.
    const res = await fetch(`${base}/api/status?k=${ACCESS_KEY}`, {
      headers: { accept: '*/*' },
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
  });

  test('the sign-in form accepts the key and refuses a wrong one', async () => {
    const good = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: ACCESS_KEY }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie') ?? '';
    assert.match(cookie, /ac_session=/);

    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'guessing' }),
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
  });

  test('the x-access-key header works without a session', async () => {
    const ok = await fetch(`${base}/api/status`, { headers: { 'x-access-key': ACCESS_KEY } });
    assert.equal(ok.status, 200);

    const bad = await fetch(`${base}/api/status`, { headers: { 'x-access-key': 'nope' } });
    assert.equal(bad.status, 401);
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
