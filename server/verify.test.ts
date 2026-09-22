/**
 * Tests for the verification tool.
 *
 * The tool's whole value is that its answers are trustworthy, so these tests
 * are about the *classification*: a rejected key, a missing agent, an exhausted
 * quota and a blocked network are four different problems with four different
 * fixes, and a checker that reports them as one thing is worse than nothing.
 *
 * The other half is secrecy. The report is designed to be pasted into a chat or
 * an issue, so the last test asserts the obvious: no credential, and no
 * meaningful part of one, ever appears in it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAgent,
  checkGeminiKey,
  checkGitHubToken,
  checkWhatsAppToken,
  formatReport,
  hasFailure,
  identify,
  sendWhatsAppTestMessage,
  verdictForEngineError,
  type CheckResult,
} from './verify.js';
import { EngineError } from './engine/types.js';

const KEY = 'AQ.Ab8RN6TESTKEY-do-not-use-0123456789abcdef';
const TOKEN = 'WAAVtesttoken-do-not-use-0123456789abcdefghijklmnop';

/**
 * A fetch that answers with one canned response.
 *
 * 204 has to be sent with no body at all: `Response` refuses a body on a
 * null-body status, and the throw would have been classified as a network
 * failure — which is exactly the kind of wrong answer this tool must not give.
 */
function respond(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return async () =>
    new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers,
    });
}

/** An inbound batch in the shape the platform actually sends. */
function updatesEnvelope(
  messages: Array<Record<string, unknown>>,
  nextOffset = 0,
): Record<string, unknown> {
  return {
    entry: [{ id: 'agent-1', changes: [{ value: { messages, contacts: [{ wa_id: '123' }] } }] }],
    next_offset: nextOffset,
  };
}

/** A fetch that throws the way a blocked network does. */
const blockedFetch: typeof fetch = async () => {
  throw new TypeError('fetch failed');
};

// ---------------------------------------------------------------------------
// the key
// ---------------------------------------------------------------------------

describe('gemini key check', () => {
  test('a working key reports how much it can see', async () => {
    const result = await checkGeminiKey({
      apiKey: KEY,
      fetchImpl: respond(200, { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] }),
    });
    assert.equal(result.verdict, 'ok');
    assert.match(result.summary, /2 models/);
    assert.equal(result.evidence?.status, 200);
  });

  test('a rejected key is reported as auth failure, with the API\'s own words', async () => {
    const result = await checkGeminiKey({
      apiKey: KEY,
      fetchImpl: respond(400, {
        error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' },
      }),
    });
    assert.equal(result.verdict, 'auth_failed');
    assert.match(result.summary, /API key not valid/);
  });

  test('401 and 403 are auth failures too', async () => {
    for (const status of [401, 403]) {
      const result = await checkGeminiKey({ apiKey: KEY, fetchImpl: respond(status, { error: { message: 'nope' } }) });
      assert.equal(result.verdict, 'auth_failed', `status ${status}`);
    }
  });

  test('a 429 is a rate limit, not a bad key', async () => {
    const result = await checkGeminiKey({ apiKey: KEY, fetchImpl: respond(429, { error: { message: 'quota' } }) });
    assert.equal(result.verdict, 'rate_limited');
  });

  test('a blocked network says so instead of blaming the key', async () => {
    const result = await checkGeminiKey({ apiKey: KEY, fetchImpl: blockedFetch });
    assert.equal(result.verdict, 'network');
    assert.match(result.summary, /outbound internet/);
  });

  test('no key at all is a skip, not a failure', async () => {
    const result = await checkGeminiKey({ apiKey: '  ' });
    assert.equal(result.verdict, 'not_configured');
    assert.equal(hasFailure([result]), false);
  });
});

// ---------------------------------------------------------------------------
// the agent
// ---------------------------------------------------------------------------

describe('agent check', () => {
  test('a missing agent is distinguished from a bad key', async () => {
    // The engine turns a 404 on the agent into `agent_unavailable`.
    const result = await checkAgent({
      apiKey: KEY,
      agent: 'antigravity-preview-09-2026',
      fetchImpl: respond(404, { error: { message: 'agent not found' } }),
    });
    assert.equal(result.check, 'agent');
    assert.equal(result.verdict, 'agent_unavailable');
    assert.match(result.summary, /antigravity-preview-09-2026/);
    assert.match(result.summary, /ANTIGRAVITY_AGENT/, 'the fix should be named');
  });

  test('an unauthorised agent call names the key', async () => {
    const result = await checkAgent({ apiKey: KEY, fetchImpl: respond(401, { error: { message: 'bad key' } }) });
    assert.equal(result.verdict, 'auth_failed');
  });

  test('a blocked network is reported as a network problem', async () => {
    const result = await checkAgent({ apiKey: KEY, fetchImpl: blockedFetch });
    assert.equal(result.verdict, 'network');
  });

  test('without a key the agent is skipped rather than attempted', async () => {
    const result = await checkAgent({ apiKey: '' });
    assert.equal(result.verdict, 'not_configured');
  });

  test('every engine failure maps to a distinct verdict', () => {
    assert.equal(verdictForEngineError('auth_failed'), 'auth_failed');
    assert.equal(verdictForEngineError('agent_unavailable'), 'agent_unavailable');
    assert.equal(verdictForEngineError('quota_exceeded'), 'quota_exceeded');
    assert.equal(verdictForEngineError('rate_limited'), 'rate_limited');
    assert.equal(verdictForEngineError('network_error'), 'network');
    assert.equal(verdictForEngineError('idle_timeout'), 'timeout');
    assert.equal(verdictForEngineError('upstream_error'), 'upstream_error');
  });

  test('an EngineError from deep in the engine still classifies', async () => {
    // A 500 mid-stream: the engine raises upstream_error, and the check must not
    // turn that into "the network is down".
    const result = await checkAgent({ apiKey: KEY, fetchImpl: respond(500, 'boom') });
    assert.equal(result.verdict, 'upstream_error');
    assert.ok(result.evidence?.errorType);
    assert.equal(EngineError.name, 'EngineError');
  });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe('github token check', () => {
  const PAT = 'github_pat_test-do-not-use-0123456789abcdef';

  test('without a token the check is skipped rather than attempted', async () => {
    const result = await checkGitHubToken({ token: '' });
    assert.equal(result.check, 'github_token');
    assert.equal(result.verdict, 'not_configured');
  });

  test('an accepted token reports the owner and its kind', async () => {
    const result = await checkGitHubToken({ token: PAT, fetchImpl: respond(200, { login: 'octocat' }) });
    assert.equal(result.verdict, 'ok');
    assert.match(result.summary, /octocat/);
    assert.match(result.summary, /fine-grained/);
    assert.equal(JSON.stringify(result).includes(PAT), false, 'the report must not contain the token');
  });

  test('a rejected token is auth_failed, not "not configured"', async () => {
    const result = await checkGitHubToken({
      token: PAT,
      fetchImpl: respond(401, { message: 'Bad credentials' }),
    });
    assert.equal(result.verdict, 'auth_failed');
  });

  test('a blocked network is reported as a network problem', async () => {
    const result = await checkGitHubToken({ token: PAT, fetchImpl: blockedFetch });
    assert.equal(result.verdict, 'network');
  });
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

describe('whatsapp token check', () => {
  test('204 means the token is good and the inbox is empty', async () => {
    const result = await checkWhatsAppToken({ token: TOKEN, fetchImpl: respond(204, '') });
    assert.equal(result.verdict, 'ok');
    assert.match(result.summary, /inbox is empty/);
    assert.equal(result.evidence?.status, 204);
  });

  test('200 reports what is waiting without consuming it', async () => {
    const result = await checkWhatsAppToken({
      token: TOKEN,
      fetchImpl: respond(
        200,
        updatesEnvelope([{ id: 'wamid.1', from: 'user:1', type: 'text', text: { body: 'hi' } }], 7),
      ),
    });
    assert.equal(result.verdict, 'ok');
    assert.equal(result.evidence?.pending, 1);
    assert.equal(result.evidence?.nextOffset, 7);
  });
  test('a rejected token tells the user to regenerate it, and where', async () => {
    const result = await checkWhatsAppToken({
      token: TOKEN,
      fetchImpl: respond(401, { error: { message: 'Invalid token', code: 190 } }),
    });
    assert.equal(result.verdict, 'auth_failed');
    assert.match(result.summary, /Settings → Agents/);
  });

  test('a rate limit is not reported as a bad token', async () => {
    const result = await checkWhatsAppToken({
      token: TOKEN,
      fetchImpl: respond(429, { error: { message: 'too many requests' } }, { 'retry-after': '30' }),
    });
    assert.equal(result.verdict, 'rate_limited');
  });

  test('no token is a skip', async () => {
    const result = await checkWhatsAppToken({ token: '' });
    assert.equal(result.verdict, 'not_configured');
  });
});

describe('whatsapp send check', () => {
  test('a delivered message reports its id', async () => {
    const result = await sendWhatsAppTestMessage({
      token: TOKEN,
      fetchImpl: respond(200, { messages: [{ id: 'wamid.out.1' }], contacts: [{ wa_id: '123' }] }),
    });
    assert.equal(result.verdict, 'ok');
    assert.equal(result.evidence?.messageId, 'wamid.out.1');
    assert.match(result.summary, /on your phone/);
  });

  test('409 is reported as a conflict, because the token is not the problem', async () => {
    const result = await checkWhatsAppToken({
      token: TOKEN,
      fetchImpl: respond(409, { error: { message: 'another poller holds this agent' } }),
    });
    assert.equal(result.verdict, 'conflict');
    assert.match(result.summary, /another poller|another process/i);
    assert.match(result.summary, /POLLER_ENABLED=false/);
  });

  test('a refused send points at the token', async () => {
    const result = await sendWhatsAppTestMessage({
      token: TOKEN,
      fetchImpl: respond(403, { error: { message: 'token revoked', code: 190 } }),
    });
    assert.equal(result.verdict, 'auth_failed');
    assert.match(result.summary, /token is not valid/);
  });

  test('a blocked network is a network verdict, not a delivery claim', async () => {
    const result = await sendWhatsAppTestMessage({ token: TOKEN, fetchImpl: blockedFetch });
    assert.equal(result.verdict, 'network');
    assert.equal(result.evidence?.messageId, undefined);
  });
});

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

describe('the report', () => {
  test('summarises pass, fail and skip', () => {
    const results: CheckResult[] = [
      { check: 'gemini_key', verdict: 'ok', summary: 'fine' },
      { check: 'whatsapp_token', verdict: 'auth_failed', summary: 'bad' },
      { check: 'agent', verdict: 'not_configured', summary: 'skipped' },
    ];
    const report = formatReport(results);
    assert.match(report, /1 passed · 1 failed · 1 skipped/);
    assert.match(report, /\[PASS\] gemini_key/);
    assert.match(report, /\[FAIL\] whatsapp_token/);
    assert.match(report, /\[SKIP\] agent/);
    assert.equal(hasFailure(results), true);
  });

  test('never contains a credential, however it is reported', async () => {
    // Every path that produced evidence, then serialised the way the CLI does.
    const results: CheckResult[] = [
      await checkGeminiKey({ apiKey: KEY, fetchImpl: respond(200, { models: [] }) }),
      await checkGeminiKey({ apiKey: KEY, fetchImpl: respond(400, { error: { message: 'API key not valid' } }) }),
      await checkGeminiKey({ apiKey: KEY, fetchImpl: blockedFetch }),
      await checkAgent({ apiKey: KEY, fetchImpl: respond(401, { error: { message: 'no' } }) }),
      await checkWhatsAppToken({ token: TOKEN, fetchImpl: respond(204, '') }),
      await checkWhatsAppToken({ token: TOKEN, fetchImpl: respond(401, { error: { message: 'no' } }) }),
      await sendWhatsAppTestMessage({ token: TOKEN, fetchImpl: respond(200, { messages: [{ id: 'x' }] }) }),
      await sendWhatsAppTestMessage({ token: TOKEN, fetchImpl: blockedFetch }),
    ];

    const serialized = `${formatReport(results)}\n${JSON.stringify(results)}`;
    assert.equal(serialized.includes(KEY), false, 'the Gemini key leaked into the report');
    assert.equal(serialized.includes(TOKEN), false, 'the WhatsApp token leaked into the report');
    // Fragments long enough to be useful to an attacker must not appear either.
    assert.equal(serialized.includes(KEY.slice(3, 20)), false);
    assert.equal(serialized.includes(TOKEN.slice(4, 20)), false);

    // What it does show is an identity anyone can match against.
    assert.match(identify(KEY), /^[0-9a-f]{12} · AQ\.A/);
    assert.match(serialized, /fingerprint/);
  });
});
