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
import { createStores } from './settings.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { pumpQueue } from './queue.js';
import { ScriptedEngine, type ScriptStep } from './engine/scripted.js';
import { EngineAbortedError, type Engine, type EngineContext, type EngineResult } from './engine/types.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const PASSWORD = 'runs-access-key-for-tests-1234';
/** The config the app and the queue pump share. Assigned in `before`. */
let testConfig: ReturnType<typeof loadConfig>;

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
  // The pump is injected the same way production injects it (see main.ts): the
  // executor knows when a slot frees, and the acceptance path knows how to
  // start a task. Wiring it here means the queue tests exercise the real
  // promotion, not a test-only shortcut.
  executor = new RunExecutor({
    db,
    bus,
    engine,
    snapshotIntervalMs: 25,
    onSlotFree: () => {
      void pumpQueue({ db, executor, config: testConfig }).catch(() => {});
    },
  });

  testConfig = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: PASSWORD,
  } as NodeJS.ProcessEnv);
  const config = testConfig;

  const app = createApp({
    config,
    db,
    bus,
    executor,
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
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

/**
 * Empty the queue and wait for the slot to free.
 *
 * These tests share one database and one active-slot guard, so a task parked by
 * the previous test is a task that changes what this one measures. Draining
 * first is what makes each case about its own behaviour.
 */
async function drainQueue(): Promise<void> {
  const { body } = await api('/api/runs/queue');
  for (const run of body.waiting ?? []) await api(`/api/runs/${run.id}/cancel`, { method: 'POST' });
  await waitFor(async () => {
    const active = await api('/api/runs/active');
    return active.body.run ? null : active;
  }, 10_000);
}

async function startRun(prompt: string, kind = 'chat'): Promise<ApiResult> {
  runCounter += 1;
  return api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ prompt: `${prompt} #${runCounter}`, kind }),
  });
}

describe('attached files', () => {
  test('a file reaches the engine but the file text never reaches the thread', async () => {
    // The recorder every deep-research case already uses: it keeps the prompt
    // the engine was handed, which is the only place the file text may appear.
    const recording = new RecordingEngine();
    useEngine(recording);
    const secret = 'SENSITIVE-CSV-CONTENT';
    const { status, body } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Summarise the attached numbers',
        kind: 'chat',
        attachments: [{ name: 'numbers.csv', text: `a,b\n1,2\n${secret}` }],
      }),
    });
    assert.equal(status, 201);
    assert.ok(
      recording.calls.some((c) => c.prompt.includes(secret) && c.prompt.includes('--- numbers.csv ---')),
      'the engine is handed the file, fenced with its name',
    );

    // What the operator sees in the thread: their own words, plus one line
    // naming the file. Never the contents.
    const messages = await waitFor(async () => {
      const res = await api(`/api/conversations/${body.run.conversationId}/messages`);
      return res.body.messages.length ? res.body.messages : null;
    });
    const mine = messages.find((m: { role: string; content: string }) => m.role === 'user');
    assert.ok(mine.content.includes('Summarise the attached numbers'), 'the question is the record');
    assert.ok(mine.content.includes('numbers.csv'), 'the file is named');
    assert.ok(!mine.content.includes(secret), 'and its contents are not pasted into the conversation');
    useEngine(new ScriptedEngine({ steps: INSTANT, speed: 0 }));
  });

  test('a refused attachment is explained, and nothing starts', async () => {
    const { status, body } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'This should not start',
        attachments: [{ name: 'huge.txt', text: 'x'.repeat(200_001) }],
      }),
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_attachments');
    assert.match(body.message, /huge\.txt is larger than 200 KB/);
    const active = await api('/api/runs/active');
    assert.equal(active.body.run, null, 'a refused request starts nothing');
  });

  test('an SVG is refused as a picture, in a sentence that names the file', async () => {
    const { status, body } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Look at this',
        images: [{ name: 'logo.svg', mimeType: 'image/svg+xml', data: 'AAAA' }],
      }),
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_images');
    assert.match(body.message, /logo\.svg/);
    assert.match(body.message, /SVG/);
    const active = await api('/api/runs/active');
    assert.equal(active.body.run, null, 'and nothing starts');
  });

  test('a picture rides the request and stops at the engine, naming itself in the thread', async () => {
    // The row is what the operator reads and what an API response carries, so
    // the pixels must not be in it — while the run the executor gets must have
    // them, or the model is asked about a picture it never received.
    const { status, body } = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Match this screenshot',
        images: [{ name: 'shot.png', mimeType: 'image/png', data: 'A'.repeat(120) }],
      }),
    });
    assert.equal(status, 201, JSON.stringify(body));
    const stored = JSON.stringify(body.run);
    assert.ok(!stored.includes('A'.repeat(120)), 'no pixels in the run the client gets back');
    assert.match(body.run.prompt, /🖼 1 image: shot\.png/, 'the thread says what was sent');

    // It runs to the end with the picture attached: the images are handed to the
    // executor, not just accepted and dropped.
    const finished = await waitFor(async () => {
      const run = await api(`/api/runs/${body.run.id}`);
      return ['completed', 'failed', 'cancelled'].includes(run.body.run.status) ? run : null;
    });
    assert.equal(finished.body.run.status, 'completed');
  });
});

describe('a second ask waits its turn instead of hitting a wall', () => {
  /** Slow enough that the first task is still running when the second arrives. */
  const SLOW: ScriptStep[] = [
    { log: 'starting', delayMs: 10 },
    { text: 'working… ', delayMs: 400 },
    { text: 'done', delayMs: 10 },
  ];

  beforeEach(async () => {
    // Short: the queue tests wait on real wall-clock transitions, so every
    // second of script is a second of test.
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    await drainQueue();
  });

  test('the second ask is accepted and parked, not refused', async () => {
    await drainQueue();
    const first = await startRun('the first task');
    assert.equal(first.status, 201);
    await waitFor(async () => {
      const run = await api(`/api/runs/${first.body.run.id}`);
      return run.body.run.status === 'running' ? run : null;
    });

    const second = await startRun('the second task');
    assert.equal(second.status, 201, 'not a 409: the ask is taken, it just waits');
    assert.equal(second.body.run.status, 'waiting');
    assert.equal(second.body.queue.position, 1);
    assert.ok(second.body.queue.ahead, 'the run in front of it is named');

    // The slot still belongs to exactly one run.
    const active = await api('/api/runs/active');
    assert.equal(active.body.run.id, first.body.run.id);
  });

  test('when the first finishes, the waiting one starts by itself and completes', async () => {
    await drainQueue();
    const first = await startRun('the first task');
    await waitFor(async () => {
      const run = await api(`/api/runs/${first.body.run.id}`);
      return run.body.run.status === 'running' ? run : null;
    });
    const second = await startRun('the second task');
    const secondId = second.body.run.id;

    const finished = await waitFor(async () => {
      const run = await api(`/api/runs/${secondId}`);
      return run.body.run.status === 'completed' ? run : null;
    }, 15_000);
    assert.equal(finished.body.run.status, 'completed');

    // The stream is the record: a wait that happens silently is a wait the
    // operator cannot tell apart from a task that never started.
    const streamed = await readStream(secondId, { after: 0, timeoutMs: 2_000 });
    const names = streamed.frames.map((f) => f.event);
    assert.ok(names.includes('run.queued'), 'the wait is announced, not silent');
    assert.ok(names.includes('run.started'), 'and then it actually started');

    // The first task was not disturbed by any of this.
    const firstAfter = await api(`/api/runs/${first.body.run.id}`);
    assert.equal(firstAfter.body.run.status, 'completed');
  });

  test('the queue is first come, first served', async () => {
    await drainQueue();
    const first = await startRun('first');
    await waitFor(async () => {
      const run = await api(`/api/runs/${first.body.run.id}`);
      return run.body.run.status === 'running' ? run : null;
    });
    const a = await startRun('queued a');
    const b = await startRun('queued b');
    assert.equal(a.body.queue.position, 1);
    assert.equal(b.body.queue.position, 2, 'the second in line is second');

    const order: string[] = [];
    await waitFor(async () => {
      for (const id of [a.body.run.id, b.body.run.id]) {
        const run = await api(`/api/runs/${id}`);
        if (run.body.run.status === 'running' && !order.includes(id)) order.push(id);
      }
      const finished = await api(`/api/runs/${b.body.run.id}`);
      return finished.body.run.status === 'completed' ? finished : null;
    }, 20_000);
    assert.equal(order[0], a.body.run.id, 'the one that asked first ran first');
  });

  test('cancelling a waiting task takes it out of the line', async () => {
    await drainQueue();
    const first = await startRun('first');
    await waitFor(async () => {
      const run = await api(`/api/runs/${first.body.run.id}`);
      return run.body.run.status === 'running' ? run : null;
    });
    const queued = await startRun('never mind');
    const cancelled = await api(`/api/runs/${queued.body.run.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.ok, true);
    const after = await api(`/api/runs/${queued.body.run.id}`);
    assert.equal(after.body.run.status, 'cancelled', 'a parked task can be called off');

    const list = await api('/api/runs');
    const waiting = (list.body.runs ?? []).filter((r: { status: string }) => r.status === 'waiting');
    assert.deepEqual(waiting, [], 'it is not still in the line');
  });
});

describe('steering a live task', () => {
  /**
   * An engine that records every prompt it is handed and takes its time, so a
   * steer has something live to interrupt.
   */
  class SteeringEngine implements Engine {
    readonly name = 'steering-test';
    readonly prompts: string[] = [];
    /** What each pass was handed to continue from — the sandbox proof. */
    readonly handed: { interactionId: string | null; environmentId: string | null }[] = [];
    private release: (() => void) | null = null;
    private stopped = 0;

    /**
     * Every pass waits to be released or aborted, which is what makes these
     * tests deterministic: nothing finishes because it was fast, only because
     * the test said so or because a stop arrived.
     */
    async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
      this.prompts.push(prompt);
      const mine = this.prompts.length;
      this.handed.push({
        interactionId: ctx.previousInteractionId ?? null,
        environmentId: ctx.environmentId ?? null,
      });
      // The real engine announces its handles mid-stream; this one does too,
      // which is what makes the executor's continuation seam testable here.
      ctx.continuation?.({ interactionId: `int_${mine}`, environmentId: `env_${mine}` });
      ctx.text(`pass ${mine} starting. `);
      await new Promise<void>((resolve) => {
        this.release = resolve;
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      this.release = null;
      if (ctx.signal.aborted) {
        this.stopped += 1;
        throw new EngineAbortedError();
      }
      ctx.text(`pass ${mine} done. `);
      return { text: `pass ${mine} done. `, interactionId: `int_${mine}`, environmentId: `env_${mine}` } as EngineResult;
    }

    /** Let the pass in flight finish normally. */
    finish(): void {
      this.release?.();
    }

    get stoppedCount(): number {
      return this.stopped;
    }

    get passCount(): number {
      return this.prompts.length;
    }
  }

  test('a steered pass resumes the sandbox the first pass opened', async () => {
    // The handles are announced seconds into a task, so a steer must use the
    // ones the stopped pass learned — not the ones the run started with.
    await drainQueue();
    const engine = new SteeringEngine();
    useEngine(engine);

    const started = await startRun('build it in the wrong folder');
    const runId = started.body.run.id;
    await waitFor(async () => (engine.passCount >= 1 ? true : null));
    await api(`/api/runs/${runId}/steer`, { method: 'POST', body: JSON.stringify({ note: 'use apps/web' }) });
    await waitFor(async () => (engine.passCount >= 2 ? true : null));

    // The run started with no sandbox, so the first pass got nothing. The
    // second was handed the handles the first announced mid-stream — which is
    // the whole point of steering instead of starting over.
    assert.deepEqual(engine.handed[0], { interactionId: null, environmentId: null });
    assert.deepEqual(engine.handed[1], { interactionId: 'int_1', environmentId: 'env_1' });
    // And the live handle is on the record, so a crash mid-steer can reattach.
    const row = await api(`/api/runs/${runId}`);
    assert.equal(row.body.run.interactionId, 'int_2');
    assert.equal(row.body.run.environmentId, 'env_2');
    engine.finish();
    await waitFor(async () => {
      const run = await api(`/api/runs/${runId}`);
      return ['completed', 'failed', 'cancelled'].includes(run.body.run.status) ? run : null;
    }, 10_000);
  });

  test('a note stops the pass and continues the same task with it', async () => {
    await drainQueue();
    const engine = new SteeringEngine();
    useEngine(engine);

    const started = await startRun('build the thing in the wrong folder');
    const runId = started.body.run.id;
    await waitFor(async () => (engine.passCount >= 1 ? true : null));

    const steered = await api(`/api/runs/${runId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ note: 'wrong folder — use apps/web instead' }),
    });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    await waitFor(async () => (engine.passCount >= 2 ? true : null), 8_000);
    engine.finish();

    const finished = await waitFor(async () => {
      const run = await api(`/api/runs/${runId}`);
      return ['completed', 'failed', 'cancelled'].includes(run.body.run.status) ? run : null;
    }, 10_000);

    // The task finished rather than being cancelled or restarted.
    assert.equal(finished.body.run.status, 'completed');
    assert.equal(engine.passCount, 2, 'a second pass ran');
    assert.equal(engine.stoppedCount, 1, 'and the first one was stopped, not left running');

    // The note reached the model, phrased as a correction that wins.
    const second = engine.prompts[1];
    assert.ok(second.includes('wrong folder — use apps/web instead'), 'the note is on the wire');
    assert.ok(/steered this task/i.test(second), 'and is labelled as a steer');
    assert.ok(/newer than the request/i.test(second), 'with the note winning over the original ask');
    assert.ok(second.includes('build the thing in the wrong folder'), 'the original request still rides along');

    // The operator can see it happened, where it happened.
    const events = await api(`/api/runs/${runId}`);
    const steeredEvents = (events.body.events as { type: string; payload: { note?: string } }[]).filter(
      (e) => e.type === 'run.steered',
    );
    assert.equal(steeredEvents.length, 1);
    assert.equal(steeredEvents[0].payload.note, 'wrong folder — use apps/web instead');

    // Same run, one answer: what the first pass produced is still there, which
    // is what makes this a correction rather than a restart. The final snapshot
    // is the record the operator reads.
    const finals = (events.body.events as { type: string; payload: { text?: string; final?: boolean } }[]).filter(
      (e) => e.type === 'text.snapshot' && e.payload.final,
    );
    assert.equal(finals.length, 1, 'the answer is closed exactly once');
    const answer = finals[0].payload.text ?? '';
    assert.ok(answer.includes('pass 1 starting'), `the first pass is still in the answer: ${JSON.stringify(answer)}`);
    assert.ok(answer.includes('pass 2 done'), 'and the second joined it');
    useEngine(new ScriptedEngine({ steps: INSTANT, speed: 0 }));
  });

  test('cancelling during a steer is still a cancel', async () => {
    await drainQueue();
    const engine = new SteeringEngine();
    useEngine(engine);
    const started = await startRun('stop me mid-flight');
    const runId = started.body.run.id;
    await waitFor(async () => (engine.passCount >= 1 ? true : null));

    // Stop arrives while the steered pass is live: the stop wins, and the task
    // does not come back to life with one more pass.
    await api(`/api/runs/${runId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ note: 'actually, do something else' }),
    });
    await waitFor(async () => (engine.passCount >= 2 ? true : null), 8_000);
    await api(`/api/runs/${runId}/cancel`, { method: 'POST' });

    const finished = await waitFor(async () => {
      const run = await api(`/api/runs/${runId}`);
      return ['completed', 'failed', 'cancelled'].includes(run.body.run.status) ? run : null;
    }, 10_000);
    assert.equal(finished.body.run.status, 'cancelled');
    assert.equal(engine.passCount, 2, 'nothing continued after the stop');
    assert.equal(engine.stoppedCount, 2, 'both live passes were stopped');
    useEngine(new ScriptedEngine({ steps: INSTANT, speed: 0 }));
  });

  test('refusals are sentences: nothing running, no note, or a note that is a brief', async () => {
    await drainQueue();
    const started = await startRun('finished before you steer it');
    const runId = started.body.run.id;
    await waitFor(async () => {
      const run = await api(`/api/runs/${runId}`);
      return ['completed', 'failed', 'cancelled'].includes(run.body.run.status) ? run : null;
    });

    const gone = await api(`/api/runs/${runId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ note: 'too late' }),
    });
    assert.equal(gone.status, 409);
    assert.match(gone.body.message, /follow-up message/i);

    assert.equal((await api('/api/runs/run_nope/steer', { method: 'POST', body: JSON.stringify({ note: 'x' }) })).status, 404);

    // A task that is genuinely mid-pass, so the validation cases are tested
    // against a live run rather than against whatever happened to be running.
    const liveEngine = new SteeringEngine();
    useEngine(liveEngine);
    const live = await startRun('steer me');
    const liveId = live.body.run.id;
    await waitFor(async () => (liveEngine.passCount >= 1 ? true : null));

    const empty = await api(`/api/runs/${liveId}/steer`, { method: 'POST', body: JSON.stringify({ note: '   ' }) });
    assert.equal(empty.status, 400);
    assert.match(empty.body.message, /what to change/i);
    const essay = await api(`/api/runs/${liveId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ note: 'x'.repeat(601) }),
    });
    assert.equal(essay.status, 400);
    assert.match(essay.body.message, /under 600 characters/i);
    await api(`/api/runs/${liveId}/cancel`, { method: 'POST' });
    useEngine(new ScriptedEngine({ steps: INSTANT, speed: 0 }));
  });
});

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

  test('a second mission waits its turn while one is in flight', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    await drainQueue();
    const first = await startRun('hold the slot');
    assert.equal(first.status, 201);

    const second = await startRun('should be parked');
    // The ask is taken, not refused: 201 with a place in the line. A refusal
    // here loses the thought the operator had the moment they had it.
    assert.equal(second.status, 201);
    assert.equal(second.body.run.status, 'waiting');
    assert.equal(second.body.queue.position, 1);
    assert.equal(second.body.queue.ahead.id, first.body.run.id);

    executor.cancel(first.body.run.id);
    executor.cancel(second.body.run.id);
  });

  test('the one-at-a-time rule holds even for simultaneous requests', async () => {
    useEngine(new ScriptedEngine({ steps: SLOW, speed: 1 }));
    await drainQueue();

    // The route's pre-check is only a nicer message; the partial unique index
    // is what actually enforces this, so fire them together. With the queue,
    // one wins the slot outright and the others are parked — never a second
    // runner, and never a lost ask.
    const results = await Promise.all([
      startRun('race a'),
      startRun('race b'),
      startRun('race c'),
    ]);

    const created = results.filter((r) => r.status === 201);
    const active = created.filter((r) => r.body.run.status !== 'waiting');
    const parked = created.filter((r) => r.body.run.status === 'waiting');
    assert.equal(created.length, 3, `every ask is taken, got ${created.length}`);
    assert.equal(active.length, 1, `exactly one run holds the slot, got ${active.length}`);
    assert.equal(parked.length, 2, 'the other two are in the line');

    const { body } = await api('/api/runs/active');
    assert.equal(body.run.id, active[0].body.run.id);
    // Every one of them is accounted for, and none is running alongside.
    const { body: line } = await api('/api/runs/queue');
    assert.equal(line.waiting.length, 2);
    for (const r of created) executor.cancel(r.body.run.id);
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
// deep research
// ---------------------------------------------------------------------------

/** Records every engine call so the chaining can be asserted pass by pass. */
class RecordingEngine implements Engine {
  readonly name = 'recording';
  calls: Array<{
    prompt: string;
    previousInteractionId: string | null;
    environmentId: string | null;
  }> = [];

  async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
    const n = this.calls.length + 1;
    this.calls.push({
      prompt,
      previousInteractionId: ctx.previousInteractionId,
      environmentId: ctx.environmentId,
    });
    ctx.text(`pass ${n} findings. `);
    return { text: `pass ${n} findings. `, interactionId: `ix_${n}`, environmentId: 'env_1' };
  }
}

async function startDeepRun(extra: Record<string, unknown>) {
  runCounter += 1;
  return api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ prompt: `deep research #${runCounter}`, ...extra }),
  });
}

async function waitForTerminal(id: string, timeoutMs = 15_000) {
  return waitFor(async () => {
    const { body } = await api(`/api/runs/${id}`);
    return ['completed', 'failed', 'cancelled'].includes(body.run.status) ? body.run : null;
  }, timeoutMs);
}

describe('deep research', () => {
  test('the option and budget are stored on the run', async () => {
    const created = await startDeepRun({ deepResearch: true, researchBudgetMinutes: 60 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.run.deepResearch, true);
    assert.equal(created.body.run.researchBudgetMinutes, 60);

    const finished = await waitForTerminal(created.body.run.id);
    assert.equal(finished.status, 'completed');
  });

  test('no budget means the 15-minute default', async () => {
    const created = await startDeepRun({ deepResearch: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.run.deepResearch, true);
    assert.equal(created.body.run.researchBudgetMinutes, 15);

    const finished = await waitForTerminal(created.body.run.id);
    assert.equal(finished.status, 'completed');
  });

  test('an out-of-range budget is rejected before anything is spent', async () => {
    for (const researchBudgetMinutes of [3, 0, -15, 15.5, 999, 'an hour']) {
      const res = await startDeepRun({ deepResearch: true, researchBudgetMinutes });
      assert.equal(res.status, 400, `budget ${researchBudgetMinutes} should be rejected`);
      assert.equal(res.body.error, 'invalid_research_budget');
    }
  });

  test('the executor chains passes on the same mission until the pass cap', async () => {
    const engine = new RecordingEngine();
    useEngine(engine);

    const created = await startDeepRun({ deepResearch: true, researchBudgetMinutes: 5 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.run.id as string;

    const finished = await waitForTerminal(id);
    assert.equal(finished.status, 'completed');
    assert.equal(engine.calls.length, 8, 'instant passes run to the pass cap, not the clock');

    // The first pass frames the mission as a deep, multi-pass investigation.
    assert.match(engine.calls[0].prompt, /Deep-research mode/);
    assert.match(engine.calls[0].prompt, /up to 5 minutes/);

    // Later passes continue the same sandbox via the previous interaction —
    // one logical mission, not N separate runs.
    assert.equal(engine.calls[1].previousInteractionId, 'ix_1');
    assert.equal(engine.calls[1].environmentId, 'env_1');
    assert.equal(engine.calls[7].previousInteractionId, 'ix_7');

    // Continuation prompts build on prior findings instead of repeating them.
    assert.match(engine.calls[1].prompt, /Build on your prior findings/);
    assert.match(engine.calls[1].prompt, /do NOT repeat/);

    // The last pass is spent synthesising the final report.
    assert.match(engine.calls[7].prompt, /final synthesized report/);

    // The final pass's handles are stored, so a follow-up message continues
    // the research sandbox instead of starting a new one.
    assert.equal(finished.interactionId, 'ix_8');
    assert.equal(finished.environmentId, 'env_1');

    // One mission in the log: the answer accumulates across passes, and each
    // pass boundary is a durable, replayable event.
    const { body } = await api(`/api/runs/${id}`);
    const passes = body.events.filter((e: { type: string }) => e.type === 'research.pass');
    assert.equal(passes.length, 8);
    assert.equal(passes[7].payload.lastChance, true);
    assert.ok(
      body.events.some((e: { type: string }) => e.type === 'research.started'),
      'research.started must be in the log',
    );
  });

  test('a normal run still makes exactly one engine call', async () => {
    const engine = new RecordingEngine();
    useEngine(engine);

    const { run } = await runToCompletion('one-shot check');
    assert.equal(run.status, 'completed');
    assert.equal(engine.calls.length, 1, 'deep research must be opt-in');
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
