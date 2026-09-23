/**
 * LinkedIn integration tests.
 *
 * Cover the three risky seams: OAuth exchange against a fake LinkedIn
 * (request shape matters — LinkedIn rejects malformed exchanges silently),
 * the publish payload + URN header (without the header we cannot keep the
 * post URN), and the fenced-draft pipeline (a draft must file, and a normal
 * answer must never file one).
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun } from './runs.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  extractLinkedInDraft,
  fetchMemberInfo,
  listPendingDrafts,
  loadLinkedInToken,
  publishTextPost,
  recordLinkedInDraft,
  saveLinkedInToken,
} from './linkedin.js';
import { withLinkedIn } from './planning.js';

let db: Db;
const MASTER_KEY = randomBytes(32).toString('hex');

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM linkedin_drafts');
  await db.query('DELETE FROM linkedin_tokens');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
});

describe('buildAuthorizeUrl', () => {
  test('carries the self-serve scopes and the state', () => {
    const url = new URL(
      buildAuthorizeUrl('cid123', 'https://app.example/api/linkedin/callback', 's3cr3t'),
    );
    assert.equal(url.hostname, 'www.linkedin.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'cid123');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/linkedin/callback');
    assert.equal(url.searchParams.get('state'), 's3cr3t');
    assert.ok(url.searchParams.get('scope')!.includes('w_member_social'));
    assert.ok(url.searchParams.get('scope')!.includes('openid'));
  });
});

describe('exchangeCode', () => {
  test('posts a form-encoded exchange and reads the token', async () => {
    let seenBody = '';
    const fetchImpl = fakeFetch(async (_url, init) => {
      seenBody = (init?.body as string) ?? '';
      return jsonResponse({ access_token: 'tok_abc', expires_in: 5184000 });
    });
    const result = await exchangeCode(
      { clientId: 'cid', clientSecret: 'csec', code: 'authcode', redirectUri: 'https://app/cb' },
      fetchImpl,
    );
    assert.equal(result.accessToken, 'tok_abc');
    assert.equal(result.expiresIn, 5184000);
    const params = new URLSearchParams(seenBody);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code'), 'authcode');
    assert.equal(params.get('client_secret'), 'csec');
  });

  test('fails loudly on a rejected code', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    await assert.rejects(() => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'u' }, fetchImpl));
  });
});

describe('fetchMemberInfo', () => {
  test('builds the person URN from userinfo', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      assert.ok(url.includes('/v2/userinfo'));
      return jsonResponse({ sub: 'abc123', name: 'Awais Ali' });
    });
    const member = await fetchMemberInfo('tok', fetchImpl);
    assert.equal(member.urn, 'urn:li:person:abc123');
    assert.equal(member.name, 'Awais Ali');
  });
});

describe('publishTextPost', () => {
  test('sends the REST payload and returns the post URN from the header', async () => {
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = fakeFetch(async (_url, init) => {
      seenHeaders = Object.fromEntries(new Headers(init?.headers as Headers).entries());
      seenBody = JSON.parse(init?.body as string);
      return jsonResponse({}, 201, { 'x-restli-id': 'urn:li:share:789' });
    });
    const urn = await publishTextPost('tok', 'urn:li:person:abc123', 'Hello world', fetchImpl);
    assert.equal(urn, 'urn:li:share:789');
    assert.equal(seenHeaders['authorization'], 'Bearer tok');
    assert.equal(seenHeaders['linkedin-version'], '202605');
    assert.equal(seenBody.author, 'urn:li:person:abc123');
    assert.equal(seenBody.commentary, 'Hello world');
    assert.equal(seenBody.lifecycleState, 'PUBLISHED');
    assert.equal(seenBody.visibility, 'PUBLIC');
  });

  test('refuses empty and overlong posts before touching the network', async () => {
    let called = false;
    const fetchImpl = fakeFetch(async () => {
      called = true;
      return jsonResponse({}, 201, { 'x-restli-id': 'urn:li:share:1' });
    });
    await assert.rejects(() => publishTextPost('t', 'urn:li:person:x', '   ', fetchImpl));
    await assert.rejects(() => publishTextPost('t', 'urn:li:person:x', 'a'.repeat(3001), fetchImpl));
    assert.equal(called, false);
  });
});

describe('token storage', () => {
  test('round-trips the sealed token and reports expiry', async () => {
    await saveLinkedInToken(db, MASTER_KEY, {
      accessToken: 'secret_token_value',
      expiresIn: 5184000,
      memberUrn: 'urn:li:person:abc123',
      memberName: 'Awais Ali',
    });
    const token = await loadLinkedInToken(db, MASTER_KEY);
    assert.ok(token);
    assert.equal(token.accessToken, 'secret_token_value');
    assert.equal(token.memberUrn, 'urn:li:person:abc123');
    assert.ok(token.expiresAt.getTime() > Date.now() + 50 * 24 * 3600_000);
    // The plaintext must never sit in the row.
    const rows = await db.query<{ ciphertext: string }>('SELECT ciphertext FROM linkedin_tokens');
    assert.ok(!rows[0].ciphertext.includes('secret_token_value'));
  });

  test('a second connect replaces the first', async () => {
    const first = { accessToken: 'one', expiresIn: 100, memberUrn: 'urn:li:person:a', memberName: 'A' };
    const second = { accessToken: 'two', expiresIn: 100, memberUrn: 'urn:li:person:b', memberName: 'B' };
    await saveLinkedInToken(db, MASTER_KEY, first);
    await saveLinkedInToken(db, MASTER_KEY, second);
    const token = await loadLinkedInToken(db, MASTER_KEY);
    assert.equal(token?.accessToken, 'two');
  });

  test('null when never connected', async () => {
    assert.equal(await loadLinkedInToken(db, MASTER_KEY), null);
  });
});

describe('fenced drafts', () => {
  test('extracts the draft and files it as pending', async () => {
    const run = await createRun(db, { prompt: 'write a LinkedIn post about my expo app', engine: 'scripted' });
    const answer = `Here is your post:\n\n\`\`\`linkedin-post\nBuilding in public is fun.\n\`\`\``;
    const id = await recordLinkedInDraft(db, run.id, answer);
    assert.ok(id);
    const drafts = await listPendingDrafts(db, run.conversationId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].text, 'Building in public is fun.');
    assert.equal(drafts[0].status, 'pending');
  });

  test('a normal answer files nothing — no silent publishing', async () => {
    const run = await createRun(db, { prompt: 'what is the weather', engine: 'scripted' });
    const id = await recordLinkedInDraft(db, run.id, 'Sunny, 22 degrees.');
    assert.equal(id, null);
    assert.deepEqual(await listPendingDrafts(db, run.conversationId), []);
  });

  test('extractLinkedInDraft ignores empty fences', () => {
    assert.equal(extractLinkedInDraft('```linkedin-post\n   \n```'), null);
  });
});

describe('withLinkedIn', () => {
  test('adds the convention only for LinkedIn missions', () => {
    const plain = withLinkedIn('write a haiku about rain');
    assert.ok(!plain.includes('linkedin-post'));
    const linked = withLinkedIn('draft a LinkedIn post about my project');
    assert.ok(linked.includes('linkedin-post'));
    assert.ok(linked.endsWith('draft a LinkedIn post about my project'));
  });
});
