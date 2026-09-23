/**
 * Google connector tests (Gmail + Calendar, read-only).
 *
 * Cover the risky seams: the OAuth exchange shape (Google rejects malformed
 * exchanges), the refresh-token lifecycle (this is what keeps the connection
 * alive past the 1-hour access token), the Gmail/Calendar response parsing,
 * the fenced read-request extraction, and the executor's read-round loop
 * (requests run, results fed back, every access logged as a google.read
 * event, loop always terminates).
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun, getRun, type Run } from './runs.js';
import { EventBus } from './events.js';
import { loadConfig, type AppConfig } from './config.js';
import { createStores } from './settings.js';
import { RunExecutor } from './executor.js';
import type { Engine, EngineContext, EngineResult } from './engine/types.js';
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  executeGoogleRead,
  extractGoogleReadRequests,
  fetchGoogleUserInfo,
  getValidAccessToken,
  listCalendarEvents,
  loadGoogleToken,
  readGmailMessage,
  refreshGoogleAccessToken,
  saveGoogleToken,
  searchGmail,
} from './google.js';
import { withGoogle } from './planning.js';

let db: Db;
const MASTER_KEY = randomBytes(32).toString('hex');

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM google_tokens');
  await db.query('DELETE FROM secrets');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
});

describe('oauth', () => {
  test('authorize URL requests offline access with read-only scopes', () => {
    const url = new URL(buildGoogleAuthorizeUrl('cid', 'https://x/cb', 'state123'));
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('state'), 'state123');
    const scope = url.searchParams.get('scope') ?? '';
    assert.ok(scope.includes('gmail.readonly'));
    assert.ok(scope.includes('calendar.readonly'));
  });

  test('code exchange posts the authorization_code grant and keeps the refresh token', async () => {
    let seenBody = '';
    const fetchImpl = fakeFetch(async (url, init) => {
      assert.ok(String(url).includes('oauth2.googleapis.com/token'));
      seenBody = String((init?.body as string) ?? '');
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    });
    const out = await exchangeGoogleCode(
      { clientId: 'cid', clientSecret: 'cs', code: 'code', redirectUri: 'https://x/cb' },
      fetchImpl,
    );
    assert.ok(seenBody.includes('grant_type=authorization_code'));
    assert.ok(seenBody.includes('code=code'));
    assert.equal(out.accessToken, 'at');
    assert.equal(out.refreshToken, 'rt');
    assert.equal(out.expiresIn, 3600);
  });

  test('refresh posts the refresh_token grant', async () => {
    let seenBody = '';
    const fetchImpl = fakeFetch(async (_url, init) => {
      seenBody = String((init?.body as string) ?? '');
      return jsonResponse({ access_token: 'at2', expires_in: 3600 });
    });
    const out = await refreshGoogleAccessToken({ clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' }, fetchImpl);
    assert.ok(seenBody.includes('grant_type=refresh_token'));
    assert.ok(seenBody.includes('refresh_token=rt'));
    assert.equal(out.accessToken, 'at2');
    assert.equal(out.refreshToken, null);
  });

  test('userinfo parses email and name', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ email: 'a@b.c', name: 'Ab' }));
    const user = await fetchGoogleUserInfo('at', fetchImpl);
    assert.equal(user.email, 'a@b.c');
    assert.equal(user.name, 'Ab');
  });
});

describe('token storage', () => {
  test('save/load round-trips the sealed blob', async () => {
    await saveGoogleToken(db, MASTER_KEY, {
      refreshToken: 'rt',
      accessToken: 'at',
      expiresIn: 3600,
      email: 'a@b.c',
      name: 'Ab',
    });
    const stored = await loadGoogleToken(db, MASTER_KEY);
    assert.ok(stored);
    assert.equal(stored.email, 'a@b.c');
    assert.equal(stored.blob.refreshToken, 'rt');
    assert.equal(stored.blob.accessToken, 'at');
    assert.ok(stored.blob.accessExpiresAt > Date.now());
  });

  test('a fresh access token is returned without any HTTP', async () => {
    await saveGoogleToken(db, MASTER_KEY, {
      refreshToken: 'rt',
      accessToken: 'fresh-at',
      expiresIn: 3600,
      email: 'a@b.c',
      name: '',
    });
    let called = false;
    const fetchImpl = fakeFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const token = await getValidAccessToken(db, MASTER_KEY, 'cid', 'cs', fetchImpl);
    assert.equal(token, 'fresh-at');
    assert.equal(called, false);
  });

  test('an expired access token is refreshed and persisted', async () => {
    await saveGoogleToken(db, MASTER_KEY, {
      refreshToken: 'rt',
      accessToken: 'stale-at',
      expiresIn: -10,
      email: 'a@b.c',
      name: '',
    });
    const fetchImpl = fakeFetch(async () => jsonResponse({ access_token: 'new-at', expires_in: 3600 }));
    const token = await getValidAccessToken(db, MASTER_KEY, 'cid', 'cs', fetchImpl);
    assert.equal(token, 'new-at');
    const stored = await loadGoogleToken(db, MASTER_KEY);
    assert.equal(stored?.blob.accessToken, 'new-at');
    // The original refresh token is kept when Google does not rotate it.
    assert.equal(stored?.blob.refreshToken, 'rt');
  });

  test('no token → null, never throws', async () => {
    const token = await getValidAccessToken(db, MASTER_KEY, 'cid', 'cs');
    assert.equal(token, null);
  });

  test('a failed refresh → null (revoked access)', async () => {
    await saveGoogleToken(db, MASTER_KEY, {
      refreshToken: 'rt',
      accessToken: 'stale-at',
      expiresIn: -10,
      email: 'a@b.c',
      name: '',
    });
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const token = await getValidAccessToken(db, MASTER_KEY, 'cid', 'cs', fetchImpl);
    assert.equal(token, null);
  });
});

function metadataFetch(from: string, subject: string): typeof fetch {
  return fakeFetch(async (url) => {
    if (String(url).includes('/messages?')) {
      return jsonResponse({ messages: [{ id: 'm1' }, { id: 'm2' }], resultSizeEstimate: 2 });
    }
    return jsonResponse({
      payload: {
        headers: [
          { name: 'From', value: from },
          { name: 'Subject', value: subject },
          { name: 'Date', value: 'Wed, 23 Sep 2026' },
        ],
      },
    });
  });
}

describe('read api', () => {
  test('gmail search returns summaries with headers', async () => {
    const messages = await searchGmail('at', 'from:boss', 5, metadataFetch('boss@x.c', 'Invoice'));
    assert.equal(messages.length, 2);
    assert.equal(messages[0].from, 'boss@x.c');
    assert.equal(messages[0].subject, 'Invoice');
  });

  test('gmail read decodes the text/plain body', async () => {
    const body = 'Hello, this is the body.';
    const fetchImpl = fakeFetch(async (url) => {
      if (String(url).includes('format=full')) {
        return jsonResponse({
          snippet: 'Hello,',
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'a@x.c' },
              { name: 'Subject', value: 'Hi' },
            ],
            parts: [{ mimeType: 'text/plain', body: { data: b64url(body) } }],
          },
        });
      }
      return jsonResponse({ payload: { headers: [] } });
    });
    const message = await readGmailMessage('at', 'm1', fetchImpl);
    assert.equal(message.bodyText, body);
  });

  test('gmail read falls back to the snippet when there is no text part', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      if (String(url).includes('format=full')) {
        return jsonResponse({ snippet: 'just a snippet', payload: { mimeType: 'text/html' } });
      }
      return jsonResponse({ payload: { headers: [] } });
    });
    const message = await readGmailMessage('at', 'm1', fetchImpl);
    assert.equal(message.bodyText, '');
    assert.equal(message.snippet, 'just a snippet');
  });

  test('calendar list parses timed and all-day events', async () => {
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({
        items: [
          {
            id: 'e1',
            summary: 'Standup',
            start: { dateTime: '2026-09-24T09:00:00+05:00' },
            end: { dateTime: '2026-09-24T09:30:00+05:00' },
            location: 'Office',
          },
          { id: 'e2', summary: 'Expo', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
        ],
      }),
    );
    const events = await listCalendarEvents('at', '2026-09-23T00:00:00Z', '2026-10-06T00:00:00Z', 10, fetchImpl);
    assert.equal(events.length, 2);
    assert.equal(events[0].summary, 'Standup');
    assert.ok(events[0].start.includes('2026-09-24T09:00'));
    assert.equal(events[1].start, '2026-10-05');
  });
});

describe('read requests', () => {
  test('extracts all three fence kinds', () => {
    const text = [
      'Let me check.',
      '```gmail-search',
      '{"query": "from:boss", "max": 3}',
      '```',
      '```gmail-read',
      '{"id": "m1"}',
      '```',
      '```calendar-list',
      '{"days": 14}',
      '```',
    ].join('\n');
    const requests = extractGoogleReadRequests(text);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0], { kind: 'gmail-search', query: 'from:boss', max: 3 });
    assert.deepEqual(requests[1], { kind: 'gmail-read', id: 'm1' });
    assert.deepEqual(requests[2], { kind: 'calendar-list', days: 14 });
  });

  test('bad JSON blocks are ignored; max and days are clamped', () => {
    const text = '```gmail-search\nnot json\n```\n```gmail-search\n{"query":"x","max":99}\n```\n```calendar-list\n{"days": 365}\n```';
    const requests = extractGoogleReadRequests(text);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], { kind: 'gmail-search', query: 'x', max: 10 });
    assert.deepEqual(requests[1], { kind: 'calendar-list', days: 30 });
  });

  test('empty queries are dropped', () => {
    const requests = extractGoogleReadRequests('```gmail-search\n{"query":"  "}\n```');
    assert.deepEqual(requests, []);
  });
});

describe('executeGoogleRead', () => {
  async function connected(): Promise<void> {
    await saveGoogleToken(db, MASTER_KEY, {
      refreshToken: 'rt',
      accessToken: 'fresh-at',
      expiresIn: 3600,
      email: 'a@b.c',
      name: '',
    });
  }

  test('not connected → ok:false with a plain message', async () => {
    const result = await executeGoogleRead({
      db,
      masterKey: MASTER_KEY,
      clientId: 'cid',
      clientSecret: 'cs',
      request: { kind: 'gmail-search', query: 'x', max: 5 },
    });
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes('Connect'));
  });

  test('gmail-search happy path', async () => {
    await connected();
    const result = await executeGoogleRead({
      db,
      masterKey: MASTER_KEY,
      clientId: 'cid',
      clientSecret: 'cs',
      request: { kind: 'gmail-search', query: 'from:boss', max: 5 },
      fetchImpl: metadataFetch('boss@x.c', 'Invoice'),
    });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes('2 message(s)'));
    assert.ok(result.detail.includes('[m1]'));
    assert.ok(result.detail.includes('Invoice'));
  });

  test('calendar-list happy path', async () => {
    await connected();
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-09-24T09:00:00+05:00' } }] }),
    );
    const result = await executeGoogleRead({
      db,
      masterKey: MASTER_KEY,
      clientId: 'cid',
      clientSecret: 'cs',
      request: { kind: 'calendar-list', days: 7 },
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes('1 event(s)'));
    assert.ok(result.detail.includes('Standup'));
  });

  test('an API failure becomes ok:false, never throws', async () => {
    await connected();
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: 'boom' }, 500));
    const result = await executeGoogleRead({
      db,
      masterKey: MASTER_KEY,
      clientId: 'cid',
      clientSecret: 'cs',
      request: { kind: 'calendar-list', days: 7 },
      fetchImpl,
    });
    assert.equal(result.ok, false);
  });
});

describe('withGoogle', () => {
  test('appends the contract when connected and the prompt mentions mail', () => {
    const out = withGoogle('check my email for the invoice', true);
    assert.ok(out.includes('gmail-search'));
  });

  test('not appended when disconnected', () => {
    assert.equal(withGoogle('check my email', false), 'check my email');
  });

  test('not appended when the prompt is unrelated', () => {
    assert.equal(withGoogle('write a poem', true), 'write a poem');
  });
});

// ---------------------------------------------------------------------------
// executor read-round loop
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'key',
    ACCESS_KEY: 'google-test-access-key',
    SESSION_SECRET: 'google-test-session-secret-32bytes!!',
    MASTER_KEY,
    ENGINE: 'scripted',
    DAILY_RUN_BUDGET: '50',
  } as NodeJS.ProcessEnv);
}

/** A mission the operator can actually run: no approval, no deep research. */
async function createSimpleRun(prompt: string): Promise<Run> {
  return createRun(db, { prompt, kind: 'chat', engine: 'stub' });
}

/** Every event the run emitted, oldest first. */
async function readEvents(runId: string): Promise<Array<{ type: string; payload: unknown }>> {
  const rows = await db.query<{ type: string; payload: unknown }>(
    `SELECT type, payload FROM run_events WHERE run_id = $1 ORDER BY seq ASC`,
    [runId],
  );
  return rows;
}

function settleRun(runId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tick = async (): Promise<void> => {
    const run = await getRun(db, runId);
    if (run && ['completed', 'failed', 'cancelled', 'paused'].includes(run.status)) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return tick();
  };
  return tick();
}

describe('executor google read loop', () => {
  test('a gmail-search request runs, the result feeds a follow-up pass, and the access is logged', async () => {
    const { secrets } = createStores(db, makeConfig());
    await secrets.set('google_client_id', 'cid');
    await secrets.set('google_client_secret', 'cs');
    await saveGoogleToken(db, MASTER_KEY, {
      refreshToken: 'rt',
      accessToken: 'fresh-at',
      expiresIn: 3600,
      email: 'a@b.c',
      name: '',
    });

    // The fake Google: one inbox hit for any search.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(async (url) => {
      if (String(url).includes('/messages?')) {
        return jsonResponse({ messages: [{ id: 'm1' }], resultSizeEstimate: 1 });
      }
      return jsonResponse({
        payload: {
          headers: [
            { name: 'From', value: 'boss@x.c' },
            { name: 'Subject', value: 'Invoice #42' },
          ],
        },
      });
    }) as typeof fetch;

    // First pass asks for a read; second pass answers using the result.
    let passes = 0;
    const engine: Engine = {
      name: 'stub',
      run: async (prompt: string, ctx: EngineContext): Promise<EngineResult> => {
        passes++;
        if (passes === 1) {
          const text = 'I will search the inbox.\n```gmail-search\n{"query":"from:boss"}\n```';
          ctx.text(text);
          return { text };
        }
        const text = 'Found it: Invoice #42 from boss@x.c.';
        assert.ok(prompt.includes('Invoice #42'), 'follow-up pass must carry the read result');
        ctx.text(text);
        return { text };
      },
    };

    const executor = new RunExecutor({
      db,
      bus: new EventBus(),
      engine,
      masterKey: MASTER_KEY,
      secrets,
    });
    const run = await createSimpleRun('check my email for the boss invoice');
    try {
      executor.start(run);
      await settleRun(run.id);
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(passes, 2);
    const finished = await getRun(db, run.id);
    assert.equal(finished?.status, 'completed');
    const events = await readEvents(run.id);
    const reads = events.filter((e) => e.type === 'google.read');
    assert.equal(reads.length, 1);
    assert.equal((reads[0].payload as { kind: string }).kind, 'gmail-search');
    assert.equal((reads[0].payload as { ok: boolean }).ok, true);
  });

  test('without credentials the capability is off: one pass, no read events', async () => {
    let passes = 0;
    const engine: Engine = {
      name: 'stub',
      run: async (_prompt: string, ctx: EngineContext): Promise<EngineResult> => {
        passes++;
        const text = 'done';
        ctx.text(text);
        return { text };
      },
    };
    const executor = new RunExecutor({ db, bus: new EventBus(), engine });
    const run = await createSimpleRun('check my email');
    executor.start(run);
    await settleRun(run.id);
    assert.equal(passes, 1);
    const events = await readEvents(run.id);
    assert.ok(!events.some((e) => e.type === 'google.read'));
  });
});
