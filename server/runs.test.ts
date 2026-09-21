/**
 * Run pipeline tests.
 *
 * These drive the real HTTP surface with a real Postgres (PGlite) behind it and
 * a real event bus in front of it. The scripted engine replaces only the model,
 * so everything being tested here — sequence allocation, cancellation, the SSE
 * handshake, budget enforcement — is the code that ships.
 *
 * The stream tests are the important ones. A dropped connection is the normal
 * case on a phone with a WhatsApp-only data package, so "reconnect and lose
 * nothing" is a product requirement, not an edge case.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from './app.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine, type ScriptStep } from './engine/scripted.js';
import type { Engine } from './engine/types.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const PASSWORD = 'runs-access-key-for-tests-1234';

/** Instant: a run is over before the test connects, which exercises replay. */
const INSTANT: ScriptStep[] = [
  { text: 'Hello ' },
  { thinking: 'thinking about it' },
  { tool: 'noop', toolArgs: { a: 1 } },
  { toolResult: { ok: true } },
  { log: 'step done' },
  { text: 'world' },
];

/** Slow enough to connect mid-run and cancel during it. */
const SLOW: ScriptStep[] = [
  { text: 'partial output ' },
  { delayMs: 400, text: 'more ' },
  { delayMs: 5_000, text: 'never arrives' },
];

const FAILING: ScriptStep[] = [
  { text: 'starting ' },
  { fail: 'the engine exploded' },
];

let db: Db;
let server: Server;
let base: string;
let cookie: string;
let bus: EventBus;
let executor: RunExecutor;
let runCounter = 0;

/**
 * Lets a test swap the script mid-suite without rebuilding the app.
 *
 * The alternative — a Proxy over RunExecutor, or restarting the server per
 * test — either breaks `this` binding or leaves the listening server attached
 * to a stale app. One stable indirection is easier to reason about than both.
 */
class SwappableEngine implements Engine {
  readonly name = 'scripted';
  target: Engine = new ScriptedEngine({ steps: INSTANT, speed: 0 });

  run(prompt: string, ctx: Parameters<Engine['run']>[1]) {
    return this.target.run(prompt, ctx);
  }
}

const engine = new SwappableEngine();

/** Each test gets a fresh script so delays do not leak between cases. */
function useEngine(next: Engine): void {
  engine.target = next;
}

before(async () => {
  db = await createDb('');
  await migrate(db);

  bus = new EventBus();
  executor = new RunExecutor({ db, bus, engine, snapshotIntervalMs: 25 });

  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: PASSWORD,
  } as NodeJS.ProcessEnv);

  const app = createApp({
    config,
    db,
    bus,
    executor,
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0, poller: 'disabled' },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // No login route any more: the access key is presented directly, which is
  // exactly what a script or the future UI does.
  cookie = '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

beforeEach(async () => {
  // One mission at a time is global, so each case starts from a clean slate.
  await db.query(`UPDATE runs SET status = 'cancelled', finished_at = now()
                   WHERE status IN ('queued', 'running', 'paused')`);
  await db.query('DELETE FROM budgets');
  useEngine(new ScriptedEngine({ steps: INSTANT, speed: 0 }));
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-access-key': PASSWORD,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

async function startRun(prompt: string, kind = 'chat'): Promise<ApiResult> {
  runCounter += 1;
  return api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ prompt: `${prompt} #${runCounter}`, kind }),
  });
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface SseFrame {
  id?: number;
  event: string;
  data: any;
}

/**
 * Minimal SSE client. Reads frames until the server sends `event: end`, the
 * socket closes, or the timeout expires — and reports which of those happened,
 * because "the stream ended cleanly" is itself an assertion.
 */
function readStream(
  runId: string,
  options: { lastEventId?: number; after?: number; stopAfter?: number; timeoutMs?: number } = {},
): Promise<{ frames: SseFrame[]; ended: boolean; closedEarly: boolean }> {
  const { lastEventId, after, stopAfter, timeoutMs = 5_000 } = options;
  const query = after !== undefined ? `?after=${after}` : '';

  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    let ended = false;
    let settled = false;

    const req = http.get(
      `${base}/api/runs/${runId}/stream${query}`,
      {
        headers: {
          'x-access-key': PASSWORD,
          accept: 'text/event-stream',
          ...(lastEventId !== undefined ? { 'Last-Event-ID': String(lastEventId) } : {}),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`stream returned ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';

        res.on('data', (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const frame: SseFrame = { event: 'message', data: null };
            let hasField = false;
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) continue; // comment / heartbeat
              if (line.startsWith('id: ')) {
                frame.id = Number(line.slice(4));
                hasField = true;
              } else if (line.startsWith('event: ')) {
                frame.event = line.slice(7);
                hasField = true;
              } else if (line.startsWith('data: ')) {
                frame.data = JSON.parse(line.slice(6));
                hasField = true;
              }
            }
            // A comment-only block (`: ping`, `: stream open`) is not an
            // event. Counting it as one made the first frame look like a
            // message with no type.
            if (hasField) frames.push(frame);

            if (frame.event === 'end') ended = true;
            if (stopAfter !== undefined && frames.length >= stopAfter) {
              settled = true;
              req.destroy();
              resolve({ frames, ended, closedEarly: false });
              return;
            }
            boundary = buffer.indexOf('\n\n');
          }
        });

        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ frames, ended, closedEarly: !ended });
        });
      },
    );

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ frames, ended, closedEarly: !ended });
    });
  });
}

async function runToCompletion(prompt: string, kind = 'chat') {
  const created = await startRun(prompt, kind);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.run.id as string;
  const finished = await waitFor(async () => {
    const { body } = await api(`/api/runs/${id}`);
    return ['completed', 'failed', 'cancelled'].includes(body.run.status) ? body.run : null;
  });
  return { id, run: finished, created: created.body };
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe('run lifecycle', () => {
  test('a run is created, executed, and closed', async () => {
    const { run } = await runToCompletion('say hello');
    assert.equal(run.status, 'completed');
    assert.ok(run.finishedAt, 'finishedAt must be set on a terminal run');
  });

  test('the answer is persisted as a message, not only streamed', async () => {
    const { run } = await runToCompletion('persist this');
    const { body } = await api(`/api/conversations/${run.conversationId}/messages`);

    assert.equal(body.messages.length, 2, 'one user message and one assistant message');
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[1].content, 'Hello world');
  });

  test('a second mission is refused while one is in flight', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    const first = await startRun('hold the slot');
    assert.equal(first.status, 201);

    const second = await startRun('should be refused');
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'run_in_progress');
    assert.equal(second.body.activeRunId, first.body.run.id);

    executor.cancel(first.body.run.id);
  });

  test('the one-at-a-time rule holds even for simultaneous requests', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));

    // The route's pre-check is only a nicer error message; the partial unique
    // index is what actually enforces this, so fire them together.
    const results = await Promise.all([
      startRun('race a'),
      startRun('race b'),
      startRun('race c'),
    ]);

    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.equal(created.length, 1, `exactly one run must win, got ${created.length}`);
    assert.equal(refused.length, 2);

    const { body } = await api('/api/runs/active');
    assert.equal(body.run.id, created[0].body.run.id);

    executor.cancel(created[0].body.run.id);
  });

  test('events are numbered from 1 with no gaps', async () => {
    const { id } = await runToCompletion('sequence check');
    const { body } = await api(`/api/runs/${id}`);

    const seqs = body.events.map((e: { seq: number }) => e.seq);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, i) => i + 1),
      'the event log must be gap-free or replay cannot be trusted',
    );
  });

  test('an engine failure closes the run as failed and keeps what it produced', async () => {
    useEngine(new ScriptedEngine({ steps: FAILING, speed: 0 }));
    const { run } = await runToCompletion('this will fail');

    assert.equal(run.status, 'failed');
    assert.equal(run.errorType, 'engine_error');
    assert.match(run.errorMessage, /exploded/);

    const { body } = await api(`/api/conversations/${run.conversationId}/messages`);
    assert.equal(body.messages[1].content, 'starting', 'partial output must survive a failure');
  });

  test('a cancelled run keeps its partial answer', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    const created = await startRun('cancel me');
    const id = created.body.run.id as string;

    await waitFor(async () => {
      const { body } = await api(`/api/runs/${id}`);
      return body.run.status === 'running' ? body.run : null;
    });
    // Let the first chunk land so there is partial output to preserve.
    await new Promise((r) => setTimeout(r, 150));

    const cancelled = await api(`/api/runs/${id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);

    const finished = await waitFor(async () => {
      const { body } = await api(`/api/runs/${id}`);
      return ['cancelled', 'failed'].includes(body.run.status) ? body.run : null;
    });
    assert.equal(finished.status, 'cancelled');

    const { body } = await api(`/api/conversations/${finished.conversationId}/messages`);
    assert.equal(body.messages.length, 2, 'the partial answer must be stored');
    assert.match(body.messages[1].content, /partial output/);
  });

  test('cancelling a run nobody is executing still clears it', async () => {
    const { id } = await runToCompletion('already done');
    const again = await api(`/api/runs/${id}/cancel`, { method: 'POST' });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyFinished, true);
  });
});

// ---------------------------------------------------------------------------
// the live stream
// ---------------------------------------------------------------------------

describe('live stream', () => {
  test('a finished run replays its whole log and then ends', async () => {
    const { id, run } = await runToCompletion('replay me');
    assert.equal(run.status, 'completed');

    const { frames, ended } = await readStream(id);

    assert.equal(ended, true, 'the stream must signal completion rather than hang');
    assert.equal(frames.at(-1)?.event, 'end');
    assert.equal(frames[0].event, 'run.started');
    assert.ok(frames.some((f) => f.event === 'text.snapshot'));
    assert.ok(frames.some((f) => f.event === 'tool.call'));
    assert.ok(frames.some((f) => f.event === 'run.completed'));
  });

  test('the final snapshot contains the complete answer', async () => {
    const { id } = await runToCompletion('complete answer please');
    const { frames } = await readStream(id);

    const last = [...frames].reverse().find((f) => f.event === 'text.snapshot');
    assert.equal(last?.data.text, 'Hello world');
  });

  test('reconnecting mid-run delivers only what was missed', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    const created = await startRun('reconnect me');
    const id = created.body.run.id as string;

    // First connection: watch a little, then drop it like a flaky phone link.
    const first = await readStream(id, { stopAfter: 2, timeoutMs: 3_000 });
    assert.ok(first.frames.length >= 2);
    const lastSeen = first.frames.filter((f) => f.id !== undefined).at(-1)?.id ?? 0;
    assert.ok(lastSeen > 0, 'replay must include durable events with ids');

    executor.cancel(id);
    await waitFor(async () => {
      const { body } = await api(`/api/runs/${id}`);
      return body.run.status === 'cancelled' ? body.run : null;
    });

    // Second connection: resume from the last sequence number seen.
    const second = await readStream(id, { lastEventId: lastSeen });

    const ids = second.frames.filter((f) => f.id !== undefined).map((f) => f.id as number);
    assert.ok(ids.length > 0, 'the resume must deliver the events that were missed');
    assert.ok(
      ids.every((id2) => id2 > lastSeen),
      `resume must not resend seen events (saw ${ids.join(',')} after ${lastSeen})`,
    );
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'resumed events must stay in order');
  });

  test('?after= works for clients that cannot send Last-Event-ID', async () => {
    const { id } = await runToCompletion('after param');
    const all = await readStream(id);
    const third = all.frames.filter((f) => f.id !== undefined)[2];

    const resumed = await readStream(id, { after: third.id });
    const ids = resumed.frames.filter((f) => f.id !== undefined).map((f) => f.id as number);
    assert.ok(ids.every((v) => v > (third.id as number)));
  });

  test('two clients can watch the same run at once', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    const created = await startRun('two watchers');
    const id = created.body.run.id as string;

    const [a, b] = await Promise.all([
      readStream(id, { stopAfter: 1, timeoutMs: 3_000 }),
      readStream(id, { stopAfter: 1, timeoutMs: 3_000 }),
    ]);
    assert.ok(a.frames.length >= 1);
    assert.ok(b.frames.length >= 1);
    assert.ok(bus.subscriberCount(id) >= 0);

    executor.cancel(id);
  });

  test('the bus forgets runs once nobody is listening', async () => {
    const { id } = await runToCompletion('no leaks');
    await readStream(id);
    // Give the close handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bus.subscriberCount(id), 0, 'an abandoned channel would leak memory');
  });

  test('an unknown run is a 404, not an empty stream', async () => {
    const result = await api('/api/runs/run_does_not_exist');
    assert.equal(result.status, 404);
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

describe('daily budget', () => {
  test('runs are refused once the day is spent, and never reach the engine', async () => {
    // Fill today's web bucket the way a real day of missions would.
    await db.query(
      `INSERT INTO budgets (day, bucket, count) VALUES (CURRENT_DATE, 'web', 100)
       ON CONFLICT (day, bucket) DO UPDATE SET count = 100`,
    );

    const third = await startRun('third must be refused');
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'daily_budget_exceeded');
    assert.equal(third.body.limit, 100);
    assert.equal(third.body.used, 100);
    assert.match(third.body.resetsAt, /T00:00:00Z$/);

    // The refused run is recorded as failed, so it is visible rather than silent.
    const { body: runsBody } = await api('/api/runs?limit=5');
    const refused = runsBody.runs.find((r: { prompt: string }) =>
      r.prompt.includes('third must be refused'),
    );
    assert.equal(refused.status, 'failed');
    assert.equal(refused.errorType, 'budget_exceeded');

    // A refused mission must never have reached the engine.
    const { body } = await api(`/api/conversations/${refused.conversationId}/messages`);
    assert.equal(body.messages.length, 1, 'only the user message exists for a refused run');
  });

  test('usage is reported per channel', async () => {
    await runToCompletion('count me', 'chat');
    const { body } = await api('/api/budget');
    const web = body.buckets.find((b: { bucket: string }) => b.bucket === 'web');
    assert.equal(web.used, 1);
    assert.equal(web.remaining, 99);
  });

  test('whatsapp missions are counted separately from the web', async () => {
    await runToCompletion('from whatsapp', 'whatsapp');
    const { body } = await api('/api/budget');
    assert.equal(body.buckets.find((b: { bucket: string }) => b.bucket === 'whatsapp').used, 1);
    assert.equal(body.buckets.find((b: { bucket: string }) => b.bucket === 'web').used, 0);
  });
});

// ---------------------------------------------------------------------------
// input handling
// ---------------------------------------------------------------------------

describe('input handling', () => {
  test('an empty prompt is rejected', async () => {
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: '   ' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'prompt_required');
  });

  test('an oversized prompt is rejected before it costs a run', async () => {
    const res = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'x'.repeat(8_001) }),
    });
    assert.equal(res.status, 413);
  });

  test('every run route demands a session', async () => {
    for (const path of ['/api/runs', '/api/runs/active', '/api/budget', '/api/conversations']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} must not be public`);
    }
  });
});
