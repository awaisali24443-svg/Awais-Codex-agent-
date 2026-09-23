/**
 * Antigravity engine tests.
 *
 * These run against a local fake that speaks the documented protocol:
 * POST /v1beta/interactions returning an SSE stream, and
 * GET  /v1beta/interactions/:id returning a stored interaction.
 *
 * What that does and does not prove. It proves the engine's own logic end to
 * end over real HTTP: request shape, stream parsing, continuation, the retry
 * ladder, quota classification, recovery after a cut, cancellation and the idle
 * watchdog. It cannot prove Google accepts the payload — only a real key can,
 * and that is the first thing to check once one is available.
 *
 * The fake records every request so the tests assert on what was actually sent
 * rather than on what the code intended to send.
 *
 * NOTE ON `--test-force-exit`. The cancellation and idle-watchdog cases abort a
 * fetch mid-stream, and Node's global fetch leaves the aborted socket in its
 * internal keep-alive pool. That pooled socket keeps the test process alive
 * after every test has passed, which is a Node/undici detail and not a defect in
 * the engine. The flag is in the `test` script so `npm test` terminates; the
 * tests themselves are all real and none of them are skipped.
 */
import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AntigravityEngine, extractContentText } from './antigravity.js';
import { EngineAbortedError, EngineError, type EngineContext } from './types.js';

interface Recorded {
  method: string;
  path: string;
  body: any;
}

interface Fake {
  base: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

/** Handler returns a status + body, or writes a stream directly. */
type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
) => void | Promise<void>;

async function startFake(handler: Handler): Promise<Fake> {
  const requests: Recorded[] = [];
  // Tracked so cleanup cannot hang on a stream the test deliberately left open
  // (the cancellation and idle-watchdog cases both end with an open socket).
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      void Promise.resolve(handler(req, res, body)).catch((err) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/v1beta`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    },
  };
}

function sse(res: http.ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    if (e.event) res.write(`event: ${e.event}\n`);
    res.write(`data: ${JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

/** A realistic opening frame set: started, a tool call, deltas, then the result. */
function happyStream(): Array<{ event?: string; data: unknown }> {
  return [
    { event: 'interaction.start', data: { interaction: { id: 'int_abc', environment_id: 'env_xyz' } } },
    { event: 'step', data: { step: { summary: 'Reading the project' } } },
    {
      event: 'step',
      data: { step: { tool_calls: [{ name: 'create_file', arguments: { TargetFile: 'app/build/outputs/app-debug.apk' } }] } },
    },
    { event: 'delta', data: { delta: { text: 'Building ' } } },
    { event: 'delta', data: { delta: { text: 'your app.' } } },
    {
      event: 'interaction.complete',
      data: {
        interaction: {
          id: 'int_abc',
          environment_id: 'env_xyz',
          status: 'completed',
          output_text: 'Building your app.',
          steps: [{ type: 'model_output', content: [{ text: 'Building your app.' }] }],
        },
      },
    },
  ];
}

function makeCtx(overrides: Partial<EngineContext> = {}): {
  ctx: EngineContext;
  seen: { text: string; thinking: string; tools: string[]; logs: string[] };
  controller: AbortController;
} {
  const seen = { text: '', thinking: '', tools: [] as string[], logs: [] as string[] };
  const controller = new AbortController();
  const ctx: EngineContext = {
    runId: 'run_test',
    signal: controller.signal,
    previousInteractionId: null,
    environmentId: null,
    text: (c) => (seen.text += c),
    thinking: (c) => (seen.thinking += c),
    tool: (n) => seen.tools.push(n),
    toolResult: () => {},
    log: (m) => seen.logs.push(m),
    ...overrides,
  };
  return { ctx, seen, controller };
}

let fake: Fake;

function engineFor(base: string, extra: Partial<ConstructorParameters<typeof AntigravityEngine>[0]> = {}) {
  return new AntigravityEngine({
    apiKey: 'test-key',
    agent: 'antigravity-preview-09-2026',
    apiBase: base,
    retryDelayMs: 0,
    // Rate-limit waits are real sleeps: keep them tiny in tests.
    rateLimitBaseDelayMs: 20,
    rateLimitMaxWaitMs: 5_000,
    ...extra,
  });
}

beforeEach(async () => {
  if (fake) await fake.close();
});

// ---------------------------------------------------------------------------

describe('the request it sends', () => {
  test('posts a streaming agent interaction to the documented endpoint', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    await engine.run('build me an app', ctx);

    const post = fake.requests.find((r) => r.method === 'POST');
    assert.equal(post?.path, '/v1beta/interactions');
    assert.equal(post?.body.agent, 'antigravity-preview-09-2026');
    assert.equal(post?.body.stream, true);
    assert.deepEqual(post?.body.input, [{ type: 'text', text: 'build me an app' }]);
    assert.equal(post?.body.environment, 'remote');
  });

  test('sends the key as a header, never in the URL', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const { ctx } = makeCtx();

    let authHeader = '';
    const seenUrls: string[] = [];
    const spyingFetch: typeof fetch = (input, init) => {
      seenUrls.push(String(input));
      authHeader = String((init?.headers as Record<string, string>)?.['x-goog-api-key'] ?? '');
      return fetch(input, init);
    };
    const spyEngine = engineFor(fake.base, { fetchImpl: spyingFetch });

    await spyEngine.run('hello', ctx);
    assert.ok(seenUrls.every((u) => !u.includes('test-key')), 'the key must never be in a URL');
    assert.equal(authHeader, 'test-key');
    assert.ok(!fake.requests[0].path.includes('key='));
  });

  test('continues a sandbox when given one', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx({ previousInteractionId: 'int_prev', environmentId: 'env_prev' });

    await engine.run('and now the icon', ctx);

    const body = fake.requests[0].body;
    assert.equal(body.previous_interaction_id, 'int_prev');
    assert.equal(body.environment, 'env_prev');
  });

  test('passes the token ceiling through when configured', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base, { maxTotalTokens: 50_000 });
    const { ctx } = makeCtx();

    await engine.run('anything', ctx);

    assert.deepEqual(fake.requests[0].body.agent_config, {
      type: 'antigravity',
      max_total_tokens: 50_000,
    });
  });

  test('requests live thought summaries as a top-level field', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    await engine.run('build me an app', ctx);

    assert.equal(fake.requests[0].body.thinking_summaries, 'auto');
  });
});

describe('reading the stream', () => {
  test('streams text, milestones and tool calls to the context', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('build me an app', ctx);

    assert.equal(result.text, 'Building your app.');
    assert.equal(result.interactionId, 'int_abc');
    assert.equal(result.environmentId, 'env_xyz');
    assert.equal(seen.text, 'Building your app.');
    assert.deepEqual(seen.tools, ['create_file']);
    assert.ok(seen.logs.some((l) => l.includes('Reading the project')));
  });

  test('reports a produced artifact', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    await engine.run('build it', ctx);

    assert.ok(
      seen.logs.some((l) => l.includes('app-debug.apk')),
      `expected an artifact log, got ${JSON.stringify(seen.logs)}`,
    );
  });

  test('recovers the answer from steps when no deltas arrive', async () => {
    fake = await startFake((_req, res) =>
      sse(res, [
        { event: 'interaction.start', data: { interaction: { id: 'int_steps' } } },
        {
          event: 'interaction.complete',
          data: {
            interaction: {
              id: 'int_steps',
              status: 'completed',
              steps: [
                { type: 'model_output', content: 'part one ' },
                { type: 'model_output', content: [{ text: 'and part two' }] },
              ],
            },
          },
        },
      ]),
    );
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    const result = await engine.run('no deltas here', ctx);
    assert.equal(result.text, 'part one and part two');
  });

  test('the longer of streamed and final text wins', async () => {
    // The stream is cut after two chunks, but the stored interaction has the
    // whole answer. Returning the truncated version would lose the tail.
    fake = await startFake((_req, res) =>
      sse(res, [
        { event: 'interaction.start', data: { interaction: { id: 'int_long' } } },
        { event: 'delta', data: { delta: { text: 'Short.' } } },
        {
          event: 'interaction.complete',
          data: {
            interaction: {
              id: 'int_long',
              status: 'completed',
              output_text: 'Short. But the complete answer is much longer than that.',
            },
          },
        },
      ]),
    );
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    const result = await engine.run('length check', ctx);
    assert.match(result.text, /complete answer is much longer/);
  });

  test('survives malformed frames and unknown fields', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': a comment frame\n\n');
      res.write('data: {not json at all\n\n');
      res.write('data: [DONE]\n\n');
      res.write(`data: ${JSON.stringify({ something: 'unrecognised', nested: { deep: true } })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: { text: 'still here' }, extra: 1 })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ interaction: { id: 'int_x', status: 'completed', output_text: 'still here' } })}\n\n`,
      );
      res.end();
    });
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('robustness', ctx);
    assert.equal(result.text, 'still here');
    assert.equal(seen.text, 'still here');
  });

  test('an interaction that produces nothing is reported, not silently empty', async () => {
    fake = await startFake((_req, res) => sse(res, [{ event: 'interaction.start', data: { interaction: { id: 'e' } } }]));
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    await assert.rejects(
      () => engine.run('nothing', ctx),
      (err: EngineError) => err.errorType === 'truncated',
    );
  });
});

describe('failures', () => {
  const statusCase = async (status: number, message: string, expected: string) => {
    fake = await startFake((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    });
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();
    await assert.rejects(
      () => engine.run('fail please', ctx),
      (err: EngineError) => err.errorType === expected,
    );
  };

  test('a rejected key is an auth failure', () => statusCase(401, 'API key not valid', 'auth_failed'));
  test('a forbidden key is an auth failure', () => statusCase(403, 'permission denied', 'auth_failed'));

  test('an exhausted daily quota is not retried', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Quota exceeded for quota metric 'Generate requests per day per project per model-FreeTier'",
          },
        }),
      );
    });
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    await assert.rejects(
      () => engine.run('out of runs', ctx),
      (err: EngineError) => err.errorType === 'quota_exceeded' && err.retryable === false,
    );
    assert.equal(fake.requests.length, 1, 'a spent quota must never be retried');
  });

  test('rate limits are waited out, not failed — the mission continues', async () => {
    let calls = 0;
    fake = await startFake((_req, res) => {
      calls += 1;
      if (calls <= 2) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Resource exhausted: too many tokens per minute' } }));
        return;
      }
      sse(res, happyStream());
    });
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('rate limited', ctx);
    assert.equal(calls, 3, 'two 429s are waited out, the third attempt runs');
    assert.equal(result.interactionId, 'int_abc');
    assert.ok(
      seen.logs.some((l) => /waiting \d+s, then continuing/i.test(l)),
      'the wait is logged so the operator watches patience, not a hang',
    );
  });

  test('the default first rate-limit wait clears a full TPM minute window', () => {
    const engine = new AntigravityEngine({ apiKey: 'k', agent: 'antigravity-preview-09-2026' });
    const baseDelay = (engine as unknown as { rateLimitBaseDelayMs: number }).rateLimitBaseDelayMs;
    assert.equal(baseDelay, 65_000, 'first wait is 65s measured from the 429, not 30s');
  });

  test('a mid-stream 429 resumes the stored interaction instead of restarting', async () => {
    let calls = 0;
    fake = await startFake((_req, res, body) => {
      calls += 1;
      if (calls === 1) {
        // The agent starts, emits its id, then the TPM window fills mid-run.
        sse(res, [
          { event: 'interaction.start', data: { interaction: { id: 'int_mid', environment_id: 'env_1' } } },
          { event: 'delta', data: { delta: { text: 'partial ' } } },
          { event: 'error', data: { error: { message: '429: Resource exhausted, tokens per minute', code: 429 } } },
        ]);
        return;
      }
      // The resume must continue the stored interaction, not start over.
      assert.equal(body.previous_interaction_id, 'int_mid');
      sse(res, happyStream());
    });
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('mid-stream limit', ctx);
    assert.equal(calls, 2);
    assert.equal(result.text, 'Building your app.');
    assert.ok(seen.logs.some((l) => /continuing where it stopped/i.test(l)));
  });

  test('waiting too long parks the mission instead of hanging the slot', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Resource exhausted: too many tokens per minute' } }));
    });
    const engine = engineFor(fake.base, { rateLimitMaxWaitMs: 30 });
    const { ctx } = makeCtx();

    await assert.rejects(
      () => engine.run('always limited', ctx),
      (err: EngineError) => err.errorType === 'rate_limited' && err.retryable === false,
    );
  });

  test('a dead sandbox falls back to a fresh one', async () => {
    let calls = 0;
    fake = await startFake((_req, res, body) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(body.environment, 'env_gone');
        assert.equal(body.previous_interaction_id, 'int_old');
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'environment not found' } }));
        return;
      }
      sse(res, happyStream());
    });
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx({ previousInteractionId: 'int_old', environmentId: 'env_gone' });

    const result = await engine.run('continue please', ctx);

    assert.equal(fake.requests.length, 2);
    const retry = fake.requests[1].body;
    assert.equal(retry.environment, 'remote', 'must fall back to a fresh sandbox');
    assert.equal(retry.previous_interaction_id, undefined, 'a dead sandbox cannot be continued');
    assert.equal(result.interactionId, 'int_abc');
    assert.ok(seen.logs.some((l) => /fresh one/i.test(l)));
  });

  test('an unknown-field rejection retries without the optional fields', async () => {
    let calls = 0;
    fake = await startFake((_req, res, body) => {
      calls += 1;
      if (calls === 1) {
        assert.ok(body.store !== undefined, 'store is sent on the first attempt');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unknown field: store' } }));
        return;
      }
      assert.equal(body.store, undefined, 'the field the API rejected must be gone');
      sse(res, happyStream());
    });
    const engine = engineFor(fake.base);
    const { ctx } = makeCtx();

    await engine.run('compat check', ctx);
    assert.equal(calls, 2);
  });

  test('a network failure is classified, not thrown raw', async () => {
    const engine = engineFor('http://127.0.0.1:1/v1beta', { retryDelayMs: 0 });
    const { ctx } = makeCtx();

    await assert.rejects(
      () => engine.run('unreachable', ctx),
      (err: EngineError) => err.errorType === 'network_error',
    );
  });

  test('no key is an auth failure that says what to do', async () => {
    fake = await startFake((_req, res) => sse(res, happyStream()));
    const engine = engineFor(fake.base, { apiKey: '' });
    const { ctx } = makeCtx();

    await assert.rejects(
      () => engine.run('no key', ctx),
      (err: EngineError) => err.errorType === 'auth_failed' && /GEMINI_API_KEY/.test(err.message),
    );
    assert.equal(fake.requests.length, 0, 'it must not even try without a key');
  });
});

describe('live thinking summaries', () => {
  test('a thought_summary delta feeds the Thinking panel', async () => {
    fake = await startFake((_req, res) =>
      sse(res, [
        { event: 'interaction.start', data: { interaction: { id: 'int_think' } } },
        {
          event: 'step.delta',
          data: {
            delta: {
              type: 'thought_summary',
              content: { parts: [{ text: 'Weighing two approaches…' }] },
            },
          },
        },
        {
          event: 'step.delta',
          data: {
            delta: { type: 'text', content: { parts: [{ text: 'Going with the second.' }] } },
          },
        },
        {
          event: 'interaction.complete',
          data: {
            interaction: { id: 'int_think', status: 'completed', output_text: 'Going with the second.' },
          },
        },
      ]),
    );
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('think out loud', ctx);

    assert.ok(
      seen.thinking.includes('Weighing two approaches'),
      `thinking panel got: ${JSON.stringify(seen.thinking)}`,
    );
    // The thought text must not leak into the answer stream…
    assert.equal(seen.text, 'Going with the second.');
    // …and the text delta in Content shape must still reach it.
    assert.equal(result.text, 'Going with the second.');
  });

  test('step.start thought and tool steps map to the right panels', async () => {
    fake = await startFake((_req, res) =>
      sse(res, [
        { event: 'interaction.start', data: { interaction: { id: 'int_ss' } } },
        {
          event: 'step.start',
          data: {
            step: { type: 'thought', content: { parts: [{ text: 'Checking the build config' }] } },
          },
        },
        {
          event: 'step.start',
          data: {
            step: { type: 'tool_call', tool_calls: [{ name: 'run_tests', arguments: {} }] },
          },
        },
        {
          event: 'interaction.complete',
          data: { interaction: { id: 'int_ss', status: 'completed', output_text: 'done' } },
        },
      ]),
    );
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    await engine.run('start steps', ctx);

    assert.ok(seen.thinking.includes('Checking the build config'));
    assert.deepEqual(seen.tools, ['run_tests']);
  });

  test('an unknown-enum rejection retries with the qualified enum name first', async () => {
    let calls = 0;
    fake = await startFake((_req, res, body) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(body.thinking_summaries, 'auto', 'the first attempt uses the documented value');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown enum value "auto" for thinking_summaries' } }));
        return;
      }
      // The qualified name must be tried BEFORE any field is stripped: store
      // must survive, or the recovery machinery dies quietly with it.
      assert.equal(body.thinking_summaries, 'THINKING_SUMMARIES_AUTO');
      assert.equal(body.store, true, 'optional fields must not be stripped for an enum rejection');
      sse(res, happyStream());
    });
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('enum check', ctx);

    assert.equal(calls, 2, 'exactly one enum retry, then the mission runs');
    assert.equal(result.interactionId, 'int_abc');
    assert.ok(seen.logs.some((l) => /THINKING_SUMMARIES_AUTO/i.test(l)), 'the retry is logged');
  });

  test('extractContentText tolerates odd shapes', async () => {
    assert.equal(extractContentText({ parts: [{ text: 'a' }, 'b', { nope: 1 }, null] }), 'ab');
    assert.equal(extractContentText({ parts: 'not an array' }), '');
    assert.equal(extractContentText(null), '');
    assert.equal(extractContentText('a string'), '');
  });
});

describe('recovery and cancellation', () => {
  test('a cut stream recovers the stored interaction instead of truncating', async () => {
    fake = await startFake((req, res) => {
      if (req.method === 'GET') {
        assert.match(req.url ?? '', /interactions\/int_cut$/);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'int_cut',
            status: 'completed',
            environment_id: 'env_cut',
            output_text: 'The complete answer, recovered.',
          }),
        );
        return;
      }
      // Open a stream, send a little, then destroy the socket mid-mission.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ interaction: { id: 'int_cut' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: { text: 'The complete ' } })}\n\n`);
      setTimeout(() => res.destroy(), 30);
    });
    const engine = engineFor(fake.base);
    const { ctx, seen } = makeCtx();

    const result = await engine.run('cut me off', ctx);

    assert.equal(result.text, 'The complete answer, recovered.');
    assert.equal(result.interactionId, 'int_cut');
    assert.equal(result.environmentId, 'env_cut');
    assert.ok(seen.logs.some((l) => /recovering/i.test(l)));
    assert.ok(fake.requests.some((r) => r.method === 'GET'));
  });

  test('if recovery fails the mission fails loudly rather than reporting a fragment', async () => {
    fake = await startFake((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ interaction: { id: 'int_lost' } })}\n\n`);
      setTimeout(() => res.destroy(), 20);
    });
    const engine = engineFor(fake.base, { recoveryAttempts: 1 });
    const { ctx } = makeCtx();

    await assert.rejects(() => engine.run('lose me', ctx), (err: EngineError) =>
      ['network_error', 'truncated'].includes(err.errorType),
    );
  });

  test('cancelling stops the mission', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ interaction: { id: 'int_slow' }, delta: { text: 'starting ' } })}\n\n`);
      // Never ends on its own — only the abort can stop this.
    });
    const engine = engineFor(fake.base);
    const { ctx, controller } = makeCtx();

    const running = engine.run('cancel me', ctx);
    setTimeout(() => controller.abort(), 80);

    await assert.rejects(() => running, (err) => err instanceof EngineAbortedError);
  });

  test('a stalled agent is closed as idle_timeout, not left holding the slot', async () => {
    fake = await startFake((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ interaction: { id: 'int_stall' } })}\n\n`);
      // Then silence. No operator cancel — the watchdog must act.
    });
    const engine = engineFor(fake.base, { idleTimeoutMs: 300 });
    const { ctx } = makeCtx();

    await assert.rejects(
      () => engine.run('stall', ctx),
      (err: EngineError) => err.errorType === 'idle_timeout',
    );
  });
});
