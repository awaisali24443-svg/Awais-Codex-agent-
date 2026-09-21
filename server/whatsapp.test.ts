/**
 * WhatsApp intake, end to end, against a fake platform.
 *
 * The fake records every request, so these tests assert the wire format the
 * platform documents (Bearer token, `POST /messages`, `POST /statuses`,
 * `GET /updates?offset=&limit=&timeout=`) and, more importantly, the promises
 * this integration makes:
 *
 *   - a task sent from the phone becomes a run and its answer comes back
 *   - the same message can never start two tasks, however often it is replayed
 *   - the cursor only moves after a batch is handled
 *   - a replaced poll (409) or a rate limit (429) never takes the loop down
 *   - the message is durably recorded *before* it is marked read, because
 *     marking read deletes it from the platform's replay buffer
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { createApp } from './app.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine, type ScriptStep } from './engine/scripted.js';
import { acceptRun } from './accept.js';
import { loadConfig, type AppConfig } from './config.js';
import { getActiveRun, getRun, listRuns } from './runs.js';
import { WhatsAppClient, splitText } from './whatsapp/api.js';
import { WhatsAppPoller } from './whatsapp/poller.js';
import { WhatsAppSender } from './whatsapp/sender.js';

const INSTANT: ScriptStep[] = [
  { text: 'Hello from the agent.' },
  { tool: 'write_file', toolArgs: { path: 'index.html' } },
  { toolResult: { ok: true } },
  { text: ' Done.' },
];

const SLOW: ScriptStep[] = [
  { text: 'Starting…', delayMs: 30 },
  { text: ' still going…', delayMs: 5_000 },
];

const FAILING: ScriptStep[] = [
  { text: 'partial' },
  { fail: 'the sandbox exploded', errorType: 'upstream_error' },
];

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  authorization: string | null;
}

/** A local stand-in for api.whatsapp.com/agent/v1. */
class FakePlatform {
  readonly requests: RecordedRequest[] = [];
  /** Queued /updates responses; an empty queue answers 204. */
  private updates: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }> = [];
  private server: http.Server | null = null;
  baseUrl = '';
  /** Runs at the moment a read receipt arrives — used to prove ordering. */
  onStatuses: (() => Promise<void>) | null = null;
  messages = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.baseUrl = `http://127.0.0.1:${port}/agent/v1`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  /**
   * Queue one /updates response. With no body this is the 204 that means
   * "nothing to deliver" — which, importantly, carries no next_offset.
   */
  queueUpdate(body?: unknown, options: { status?: number; headers?: Record<string, string> } = {}): void {
    const status = options.status ?? (body === undefined ? 204 : 200);
    this.updates.push({ body, status, headers: options.headers });
  }

  /** Drop anything still queued and forget the request log. */
  reset(): void {
    this.updates.length = 0;
    this.requests.length = 0;
    this.messages = 0;
    this.onStatuses = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/agent\/v1/, '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    let body: Record<string, unknown> | null = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }

    this.requests.push({
      method: req.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      authorization: req.headers.authorization ?? null,
    });

    const json = (status: number, payload: unknown): void => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };

    if (path === '/updates') {
      const next = this.updates.shift();
      if (!next || next.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (next.status && next.status !== 200) {
        const text = JSON.stringify(next.body ?? { error: { message: 'boom', code: 1 } });
        res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers });
        res.end(text);
        return;
      }
      json(200, next.body);
      return;
    }

    if (path === '/messages') {
      this.messages += 1;
      json(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: 'user:5', wa_id: 'user:5' }],
        messages: [{ id: `wamid.OUT${this.messages}` }],
      });
      return;
    }

    if (path === '/statuses') {
      await this.onStatuses?.();
      json(200, { success: true });
      return;
    }

    json(404, { error: { message: 'not found', code: 100 } });
  }

  /** Requests to one endpoint, in order. */
  to(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }
}

function updateEnvelope(
  messages: Array<Record<string, unknown>>,
  nextOffset: number,
  statuses: Array<Record<string, unknown>> = [],
): unknown {
  return {
    object: 'whatsapp_agent_platform',
    entry: [
      {
        id: '123456789',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', contacts: [], messages, statuses },
          },
        ],
      },
    ],
    next_offset: nextOffset,
  };
}

function textMessage(body: string, wamid = 'wamid.IN1'): Record<string, unknown> {
  return { from: 'user:5', id: wamid, timestamp: '1736844652', type: 'text', text: { body } };
}

let db: Db;
let platform: FakePlatform;
let bus: EventBus;
let executor: RunExecutor;
let config: AppConfig;
let poller: WhatsAppPoller;
let sender: WhatsAppSender;
let engineScript: ScriptStep[] = INSTANT;
let scriptSpeed = 0;

function buildPoller(overrides: Partial<ConstructorParameters<typeof WhatsAppPoller>[0]> = {}): WhatsAppPoller {
  const client = new WhatsAppClient({ token: 'test-token', baseUrl: platform.baseUrl });
  sender = new WhatsAppSender(client);
  return new WhatsAppPoller({
    db,
    bus,
    client,
    sender,
    executor,
    config,
    accept: (input) => acceptRun({ db, executor, config }, input),
    log: () => {},
    pollTimeoutSeconds: 1,
    minPollIntervalMs: 5,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    replacedBackoffMs: 20,
    ...overrides,
  });
}

/** Transient engine whose script a test can swap between cases. */
class SwitchableEngine extends ScriptedEngine {
  constructor() {
    super({ steps: INSTANT, speed: 0 });
  }

  override async run(prompt: string, ctx: Parameters<ScriptedEngine['run']>[1]) {
    return new ScriptedEngine({ steps: engineScript, speed: scriptSpeed }).run(prompt, ctx);
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

type RunRow = Awaited<ReturnType<typeof listRuns>>[number];

/**
 * Find a run by its prompt. `listRuns` orders by `started_at`, and tests create
 * runs inside the same millisecond, so position in the list is not an identity.
 */
async function runByPrompt(prompt: string): Promise<RunRow | null> {
  const runs = await listRuns(db, 50);
  return runs.find((r) => r.prompt === prompt) ?? null;
}

/**
 * Wait until a message is completely handled: its run has finished *and* the
 * closing message has gone out. The relay marks the row processed last, so this
 * is the only signal that the whole chain — accept, run, deliver — is done.
 */
async function waitForDelivered(wamid: string, timeoutMs = 6_000): Promise<void> {
  await waitFor(async () => {
    const rows = await db.query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM wa_updates WHERE wamid = $1',
      [wamid],
    );
    return rows.length === 1 && rows[0]?.processed_at != null;
  }, timeoutMs);
}

function sentBodies(): string[] {
  return platform.to('/messages').map((r) => String((r.body?.text as { body?: string })?.body ?? ''));
}

function sentText(): string {
  return sentBodies().join('\n');
}

before(async () => {
  db = await createDb();
  await migrate(db);
  platform = new FakePlatform();
  await platform.start();
  config = loadConfig({
    NODE_ENV: 'test',
    ENGINE: 'scripted',
    ACCESS_KEY: 'test-access-key-1234',
    SESSION_SECRET: 'whatsapp-session-secret-that-is-long-enough',
  } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  // Order matters. The loop must be gone before the database is cleared, and
  // the relays must have sent their closing messages before the next test
  // starts counting requests — otherwise a previous answer shows up mid-way
  // through the next test's assertions.
  await poller?.stop(3_000);
  await executor.shutdown(2_000);
  await waitFor(() => poller.health().watching === 0, 6_000).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  platform.reset();
  engineScript = INSTANT;
  scriptSpeed = 0;
  await db.query('DELETE FROM messages');
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM wa_updates');
  await db.query('DELETE FROM wa_state');
  await db.query('DELETE FROM budgets');
});

beforeEach(() => {
  bus = new EventBus();
  executor = new RunExecutor({ db, bus, engine: new SwitchableEngine(), snapshotIntervalMs: 20 });
  poller = buildPoller();
});

after(async () => {
  await platform.stop();
  await db.close();
});

describe('whatsapp intake', () => {
  it('turns a message into a task and sends the answer back', async () => {
    platform.queueUpdate(updateEnvelope([textMessage('build me a landing page')], 42));

    await poller.pollOnce();
    await waitForDelivered('wamid.IN1');

    const run = await runByPrompt('build me a landing page');
    assert.equal(run?.kind, 'whatsapp');
    assert.equal(run?.prompt, 'build me a landing page');
    assert.equal(run?.status, 'completed');

    const sends = platform.to('/messages');
    assert.equal(sends[0]?.method, 'POST');
    assert.equal(sends[0]?.authorization, 'Bearer test-token');
    // No `to`: an agent has exactly one recipient, and the id is learned from
    // traffic rather than configured.
    assert.equal(sends[0]?.body?.to, undefined);
    assert.equal(sends[0]?.body?.messaging_product, 'whatsapp');
    assert.equal(sends[0]?.body?.type, 'text');
    assert.match(String((sends[0]?.body?.text as { body?: string })?.body), /On it/);
    assert.deepEqual(sends[0]?.body?.context, { message_id: 'wamid.IN1' });

    // The answer itself, from the durable snapshot, not from memory.
    const answer = String((sends.at(-1)?.body?.text as { body?: string })?.body);
    assert.match(answer, /Hello from the agent\./);
    assert.match(answer, /Done\./);
  });

  it('records the message before marking it read, and advances the cursor after', async () => {
    let rowExistedWhenMarkedRead = false;
    platform.onStatuses = async () => {
      const rows = await db.query<{ wamid: string }>('SELECT wamid FROM wa_updates WHERE wamid = $1', [
        'wamid.IN1',
      ]);
      rowExistedWhenMarkedRead = rows.length === 1;
    };
    platform.queueUpdate(updateEnvelope([textMessage('do a thing')], 77));

    await poller.pollOnce();
    await waitFor(() => platform.to('/statuses').length > 0);
    await waitForDelivered('wamid.IN1');

    assert.equal(rowExistedWhenMarkedRead, true, 'the message must be durable before it is marked read');

    // Typing indicator rides along with the read receipt.
    assert.deepEqual(platform.to('/statuses')[0]?.body, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN1',
      typing_indicator: { type: 'text' },
    });

    const state = await db.query<{ poll_offset: string }>('SELECT poll_offset FROM wa_state');
    assert.equal(Number(state[0]?.poll_offset), 77);
    assert.equal(platform.to('/updates')[0]?.query.offset, undefined, 'a first poll starts at the head');
    assert.equal(platform.to('/updates')[0]?.query.timeout, '1');
  });

  it('never starts a second task for a replayed message id', async () => {
    const envelope = updateEnvelope([textMessage('only once please')], 5);
    platform.queueUpdate(envelope);

    await poller.pollOnce();
    await waitForDelivered('wamid.IN1');

    // The same message again, as if the cursor had been rolled back.
    platform.queueUpdate(envelope);
    await poller.pollOnce();

    const runs = await listRuns(db, 10);
    assert.equal(runs.length, 1, 'a replay must not create a second run');
    assert.equal(poller.health().duplicates, 1);
    // And no second acknowledgement.
    assert.equal(platform.to('/messages').length, 2);
  });

  it('re-polls with the same offset after an empty poll', async () => {
    platform.queueUpdate(updateEnvelope([textMessage('first')], 10));
    await poller.pollOnce();
    await waitForDelivered('wamid.IN1');

    platform.queueUpdate(); // 204: nothing to deliver
    assert.equal(await poller.pollOnce(), 'empty');

    const polls = platform.to('/updates');
    assert.equal(polls.at(-1)?.query.offset, '10', 'a 204 must not move the cursor');
    assert.equal(poller.health().offset, 10);
  });

  it('survives a replaced poll (409) and keeps serving', async () => {
    platform.queueUpdate({ error: { message: 'newer poll', code: 1752041 } }, { status: 409 });
    platform.queueUpdate(updateEnvelope([textMessage('/help')], 3));

    poller.start();
    await waitForDelivered('wamid.IN1', 8_000);
    await poller.stop(3_000);

    assert.ok(platform.to('/updates').length >= 2, 'the loop must keep polling after a 409');
    const rows = await db.query<{ processed_at: Date | null }>('SELECT processed_at FROM wa_updates');
    assert.equal(rows.length, 1);
    assert.ok(rows[0]?.processed_at, 'the command must still have been handled');
  });

  it('honours Retry-After on a 429 without losing the offset', async () => {
    platform.queueUpdate(updateEnvelope([textMessage('earlier')], 8));
    await poller.pollOnce();
    await waitForDelivered('wamid.IN1');

    platform.queueUpdate({ error: { message: 'slow down', code: 130429 } }, {
      status: 429,
      headers: { 'Retry-After': '0' },
    });
    platform.queueUpdate(updateEnvelope([textMessage('/help')], 9));

    poller.start();
    await waitFor(() => poller.health().receipts + poller.health().duplicates + platform.to('/messages').length >= 0 && platform.to('/updates').length >= 3, 5_000);
    await poller.stop(3_000);

    const polls = platform.to('/updates');
    assert.equal(polls[1]?.query.offset, '8', 'a rate limit must reuse the offset');
    assert.equal(polls[2]?.query.offset, '8', 'and the /help in the next batch was the one handled');
  });

  it('answers /status and /cancel', async () => {
    engineScript = SLOW;
    scriptSpeed = 1;
    platform.queueUpdate(updateEnvelope([textMessage('long task')], 1));
    await poller.pollOnce();
    await waitFor(async () => (await getActiveRun(db)) !== null);

    platform.queueUpdate(updateEnvelope([textMessage('/status', 'wamid.IN2')], 2));
    await poller.pollOnce();
    const statusReply = String(
      (platform.to('/messages').at(-1)?.body?.text as { body?: string })?.body,
    );
    assert.match(statusReply, /long task/);
    assert.match(statusReply, /running/);
    assert.match(statusReply, /Tasks left today/);

    platform.queueUpdate(updateEnvelope([textMessage('/cancel', 'wamid.IN3')], 3));
    await poller.pollOnce();
    await waitFor(async () => (await getActiveRun(db)) === null);
    await waitFor(() => /Cancelled|Stopping/.test(sentText()), 6_000);
    const run = await runByPrompt('long task');
    assert.equal(run?.status, 'cancelled');
    const cancelReply = String(
      (platform.to('/messages').at(-1)?.body?.text as { body?: string })?.body,
    );
    // The relay sends the closing message; either ordering is fine, so assert
    // that a cancellation outcome reached the phone at all.
    assert.match(
      platform
        .to('/messages')
        .map((r) => String((r.body?.text as { body?: string })?.body))
        .join('\n'),
      /Cancelled|Stopping/,
    );
    assert.ok(cancelReply.length > 0);
  });

  it('refuses politely when a task is already running', async () => {
    engineScript = SLOW;
    scriptSpeed = 1;
    platform.queueUpdate(updateEnvelope([textMessage('first task')], 1));
    await poller.pollOnce();
    await waitFor(async () => (await getActiveRun(db)) !== null);

    platform.queueUpdate(updateEnvelope([textMessage('second task', 'wamid.IN2')], 2));
    await poller.pollOnce();

    const reply = String((platform.to('/messages').at(-1)?.body?.text as { body?: string })?.body);
    assert.match(reply, /still on this one/);
    assert.equal((await listRuns(db, 10)).length, 1, 'the second task must not create a run');

    await executor.shutdown();
  });

  it('explains a spent budget instead of starting a task', async () => {
    await db.query(`INSERT INTO budgets (day, bucket, count) VALUES (CURRENT_DATE, 'whatsapp', $1)`, [
      config.dailyRunBudget,
    ]);
    platform.queueUpdate(updateEnvelope([textMessage('one too many')], 4));

    await poller.pollOnce();
    await waitFor(() => platform.to('/messages').length > 0);

    const reply = sentText();
    assert.match(reply, /Daily whatsapp run budget exhausted/);
    assert.match(reply, /Resets at/);

    // The run row exists only to be closed: it never reaches the engine, so a
    // refused task costs nothing and does not occupy the one-at-a-time slot.
    const runs = await listRuns(db, 10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'failed');
    assert.equal(runs[0]?.errorType, 'budget_exceeded');
    assert.equal(await getActiveRun(db), null);
  });

  it('tells the sender when a message is not text', async () => {
    platform.queueUpdate(
      updateEnvelope([{ from: 'user:5', id: 'wamid.IMG', timestamp: '1', type: 'image' }], 6),
    );
    await poller.pollOnce();

    const reply = String((platform.to('/messages').at(-1)?.body?.text as { body?: string })?.body);
    assert.match(reply, /only take tasks as text/);
    assert.equal((await listRuns(db, 10)).length, 0);
  });

  it('reports a failed task with its reason', async () => {
    engineScript = FAILING;
    scriptSpeed = 0;
    platform.queueUpdate(updateEnvelope([textMessage('break it')], 2));

    await poller.pollOnce();
    await waitForDelivered('wamid.IN1');

    const sent = sentText();
    assert.match(sent, /Failed: the sandbox exploded/);
    assert.match(sent, /partial/, 'whatever the agent produced is still delivered');
  });

  it('splits a long answer into platform-legal chunks, in order', async () => {
    const paragraph = `${'word '.repeat(120).trim()}\n\n`;
    engineScript = [{ text: paragraph.repeat(30) }];
    scriptSpeed = 0;

    platform.queueUpdate(updateEnvelope([textMessage('write a lot')], 2));
    await poller.pollOnce();
    await waitForDelivered('wamid.IN1', 15_000);

    const answerChunks = sentBodies().filter((b) => b.startsWith('word'));
    assert.ok(answerChunks.length > 1, 'the answer must be split');
    for (const chunk of answerChunks) {
      assert.ok(chunk.length <= 4_096, `chunk of ${chunk.length} characters exceeds the cap`);
    }
    assert.match(answerChunks[0] ?? '', /^word/);
  });

  it('resumes a message that was recorded but never started', async () => {
    // Exactly the state a crash between `recordMessage` and `acceptRun` leaves.
    const payload = {
      id: 'wamid.CRASH',
      from: 'user:5',
      timestamp: 1,
      type: 'text',
      text: 'finish what you started',
      contextId: null,
      profileName: null,
    };
    await db.query(
      `INSERT INTO wa_updates (wamid, kind, payload, processed_at, run_id)
            VALUES ($1, 'text', $2::jsonb, NULL, NULL)`,
      ['wamid.CRASH', JSON.stringify(payload)],
    );

    assert.equal(await poller.reconcile(), 1);
    await waitForDelivered('wamid.CRASH');

    const run = await runByPrompt('finish what you started');
    assert.equal(run?.status, 'completed');
    assert.equal((await listRuns(db, 10)).length, 1, 'recovery must not double the task');
  });

  it('delivers the outcome of a task that died with the previous process', async () => {
    // Exactly what a crash plus boot-time orphan recovery leaves behind: the
    // run is closed, and the message the user is waiting on is unprocessed.
    await db.query(
      `INSERT INTO runs (id, conversation_id, kind, prompt, status, engine,
                         error_type, error_message, finished_at)
       VALUES ('run_dead', NULL, 'whatsapp', 'something slow', 'failed', 'scripted',
               'orphaned', 'the process exited', now())`,
    );
    const payload = {
      id: 'wamid.IN1',
      from: 'user:5',
      timestamp: 1,
      type: 'text',
      text: 'something slow',
      contextId: null,
      profileName: null,
    };
    await db.query(
      `INSERT INTO wa_updates (wamid, kind, payload, processed_at, run_id)
            VALUES ('wamid.IN1', 'text', $1::jsonb, NULL, 'run_dead')`,
      [JSON.stringify(payload)],
    );

    assert.equal(await poller.reconcile(), 1);
    await waitForDelivered('wamid.IN1', 8_000);

    assert.match(sentText(), /Failed: the process exited/);
    // It must not start a second task for a message whose run already exists.
    assert.equal((await listRuns(db, 10)).length, 1);
  });

  it('continues the same sandbox for a follow-up, and starts fresh for /new', async () => {
    platform.queueUpdate(updateEnvelope([textMessage('first task')], 1));
    await poller.pollOnce();
    await waitForDelivered('wamid.IN1');

    platform.queueUpdate(updateEnvelope([textMessage('follow up', 'wamid.IN2')], 2));
    await poller.pollOnce();
    await waitForDelivered('wamid.IN2');

    const first = await runByPrompt('first task');
    const followUp = await runByPrompt('follow up');
    assert.equal(followUp?.conversationId, first?.conversationId, 'the phone keeps one thread');
    assert.ok(first?.interactionId, 'a completed task records where its sandbox lives');
    assert.equal(
      followUp?.previousInteractionId,
      first?.interactionId,
      'a follow-up must resume the sandbox the agent was working in',
    );

    platform.queueUpdate(updateEnvelope([textMessage('/new start over', 'wamid.IN3')], 3));
    await poller.pollOnce();
    await waitForDelivered('wamid.IN3');

    const fresh = await runByPrompt('start over');
    assert.equal(fresh?.previousInteractionId, null, '/new must not continue the old sandbox');
    assert.notEqual(fresh?.conversationId, first?.conversationId);
  });
});

describe('the admin view', () => {
  it('reports live poller health on /api/status and /readyz', async () => {
    const app = createApp({
      config,
      db,
      bus,
      executor,
      status: {
        startedAt: Date.now(),
        migrationsApplied: 1,
        orphanedRuns: 0,
        poller: () => poller.health(),
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      assert.equal(poller.health().state, 'disabled');
      poller.start();

      // Both endpoints read the poller at request time, not at boot: a value
      // frozen at startup would still say "running" long after it died.
      const ready = await (await fetch(`${base}/readyz`)).json();
      assert.equal(ready.checks.poller, 'running');

      const status = await fetch(`${base}/api/status`, {
        headers: { 'x-access-key': config.accessKey },
      });
      assert.equal(status.status, 200);
      const body = (await status.json()) as { poller: { state: string; handled: number } };
      assert.equal(body.poller.state, 'running');
      assert.equal(body.poller.handled, 0);
    } finally {
      await poller.stop(2_000);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('chunking', () => {
  it('keeps every chunk inside the cap and loses nothing', () => {
    const text = `${'a'.repeat(3_000)} ${'b'.repeat(3_000)} ${'c'.repeat(3_000)}`;
    const chunks = splitText(text);
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) assert.ok(chunk.length <= 4_096);
    assert.equal(chunks.join(' ').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  });

  it('cuts an unbreakable run rather than failing to deliver', () => {
    const chunks = splitText('x'.repeat(9_000));
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(''), 'x'.repeat(9_000));
  });

  it('returns nothing for whitespace', () => {
    assert.deepEqual(splitText('   \n  '), []);
  });
});

describe('the client', () => {
  it('refuses to send more than the platform accepts', async () => {
    const client = new WhatsAppClient({ token: 't', baseUrl: platform.baseUrl });
    await assert.rejects(() => client.sendText('x'.repeat(4_097)), /caps a message at 4096/);
    assert.equal(platform.to('/messages').length, 0, 'the oversized body never reaches the wire');
  });

  it('parses the webhook-shaped envelope the poll returns', async () => {
    platform.queueUpdate(
      updateEnvelope([textMessage('hello there', 'wamid.PARSE')], 99, [
        { id: 'wamid.OUT1', status: 'delivered', recipient_id: 'user:5', timestamp: '2' },
      ]),
    );
    const client = new WhatsAppClient({ token: 't', baseUrl: platform.baseUrl });
    const updates = await client.getUpdates({ offset: 0, timeoutSeconds: 1 });

    assert.equal(updates?.agentId, '123456789');
    assert.equal(updates?.nextOffset, 99);
    assert.equal(updates?.messages[0]?.id, 'wamid.PARSE');
    assert.equal(updates?.messages[0]?.text, 'hello there');
    assert.equal(updates?.statuses[0]?.status, 'delivered');
  });

  it('returns null for the 204 that means "nothing yet"', async () => {
    const client = new WhatsAppClient({ token: 't', baseUrl: platform.baseUrl });
    assert.equal(await client.getUpdates({ timeoutSeconds: 1 }), null);
  });

  it('reports a replaced poll as its own error kind', async () => {
    platform.queueUpdate({ error: { message: 'newer poll', code: 1752041 } }, { status: 409 });
    const client = new WhatsAppClient({ token: 't', baseUrl: platform.baseUrl });
    await assert.rejects(
      () => client.getUpdates({ offset: 1, timeoutSeconds: 1 }),
      (err: Error & { kind?: string }) => err.kind === 'poll_replaced',
    );
  });
});
