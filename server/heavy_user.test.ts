/**
 * A heavy user walks the whole app.
 *
 * Everything else in this suite tests one thing at a time with the pieces it
 * needs. This file does the opposite: it boots the real `createApp` — the same
 * routes, sessions, budgets and executor that run on the phone — and then uses
 * the product the way a person does, over HTTP, in order:
 *
 *   sign in with the saved link → assign a task → watch it work and ask
 *   permission → approve it → keep the file it produced → rate the answer →
 *   share the replay → search for the task later → book the next one.
 *
 * Two things this is here to catch that narrower tests miss:
 *
 *   * **the stream is one stream.** A run's events belong to that run, arrive in
 *     order, and re-attaching after a reconnect continues rather than restarts.
 *     That is what makes the live view occupy one card instead of spawning a
 *     second one every time the app comes back to the foreground.
 *   * **nothing half-works.** A feature that returns 500 under a realistic
 *     sequence of calls is not finished, however green its unit test is.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from './app.js';
import { createStores } from './settings.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine, type ScriptStep } from './engine/scripted.js';

const SECRET = 'heavy-user-session-secret-definitely-long-enough';
const ACCESS_KEY = 'heavy-user-access-key-123456';

/**
 * A scripted task that looks like the real ones: it announces a plan, writes a
 * file, streams its answer in pieces, and finishes. The delays are near zero —
 * the pipeline is real, the clock is not.
 */
const SCRIPT: ScriptStep[] = [
  { log: 'Step 1/3: Read what is there now', delayMs: 1 },
  { log: 'Step 2/3: Build the new page', delayMs: 1 },
  { log: 'Step 3/3: Check it renders', delayMs: 1 },
  { thinking: 'Deciding how to build this. ', delayMs: 1 },
  { tool: 'write_file', toolArgs: { path: 'site/index.html' }, delayMs: 1 },
  { toolResult: { ok: true, bytes: 812 }, delayMs: 1 },
  { artifact: 'site/index.html', delayMs: 1 },
  { text: 'Built it. ', delayMs: 1 },
  { text: 'The page is at site/index.html ', delayMs: 1 },
  // A link in the answer, so the sources strip has something real to show.
  { text: 'and it follows https://example.com/guide closely.', delayMs: 1 },
  // Closing the steps is not decoration: a step announced and never finished
  // is exactly what the end-of-run checks fail the task for.
  { log: 'Step 1/3 done: read 42 files', delayMs: 1 },
  { log: 'Step 2/3 done: wrote site/index.html', delayMs: 1 },
  { log: 'Step 3/3 done: it renders', delayMs: 1 },
  { log: 'Task complete', logLevel: 'info', delayMs: 1 },
];

let db: Db;
let server: Server;
let base: string;
let cookie: string;

/** Boot the real app with a given engine, on its own port. */
async function startApp(engine: ScriptedEngine): Promise<{ base: string; close: () => Promise<void> }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: ACCESS_KEY,
    DAILY_RUN_BUDGET: '50',
  } as NodeJS.ProcessEnv);
  const bus = new EventBus();
  const app = createApp({
    config,
    db,
    bus,
    executor: new RunExecutor({ db, bus, engine }),
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
  });
  const started = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(started.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => started.close(() => resolve())),
  };
}

const COMPLEX_PROMPT = [
  'Build me a small landing page for the shop.',
  '- it should load fast on a phone',
  '- include the three prices',
  '- link to the guide',
  'Take your time and check it renders before you finish.',
].join('\n');

before(async () => {
  db = await createDb('');
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: ACCESS_KEY,
    DAILY_RUN_BUDGET: '50',
  } as NodeJS.ProcessEnv);

  const bus = new EventBus();
  const app = createApp({
    config,
    db,
    bus,
    executor: new RunExecutor({ db, bus, engine: new ScriptedEngine({ steps: SCRIPT, speed: 0 }) }),
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
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

/** Requests carry the session cookie the way the browser does. */
function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });
}

interface StreamEvent {
  /** The durable sequence number, or null for decoration (heartbeats, `end`). */
  seq: number | null;
  name: string;
  data: Record<string, unknown>;
}

/** Only durable events carry a sequence number; decoration has none. */
function durable(events: StreamEvent[]): StreamEvent[] {
  return events.filter((e) => typeof e.seq === 'number');
}

/**
 * Read a run's stream the way the browser does, until the run is over.
 *
 * Returns every event, in the order received, with the sequence number the
 * server assigned — the client's whole promise ("reconnect and you lose
 * nothing") rests on those numbers being monotonic and per-run.
 */
async function readStream(
  runId: string,
  { after = 0, until = (e: StreamEvent) => e.name === 'run.completed' || e.name === 'run.failed' || e.name === 'run.plan_ready' } = {},
): Promise<StreamEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const res = await fetch(`${base}/api/runs/${runId}/stream${after ? `?after=${after}` : ''}`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200, 'the stream opens');

  const events: StreamEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const name = /^event: (.+)$/m.exec(frame)?.[1]?.trim();
        const dataLine = /^data: (.+)$/m.exec(frame)?.[1];
        // The durable position rides the `id:` line — that is the EventSource
        // protocol's own cursor, which is how a reconnecting browser resumes
        // without the app having to remember anything.
        const idLine = /^id: (.+)$/m.exec(frame)?.[1];
        if (!name || !dataLine) continue;
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(dataLine); } catch { /* keep going */ }
        const seq = idLine !== undefined && Number.isFinite(Number(idLine)) ? Number(idLine) : null;
        events.push({ seq, name, data });
        if (until(events[events.length - 1])) return events;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

/** One task, from assignment to a finished answer. */
async function runTask(body: Record<string, unknown>): Promise<{ runId: string; conversationId: string; events: StreamEvent[] }> {
  const accepted = await api('/api/runs', { method: 'POST', body: JSON.stringify(body) });
  const payload = (await accepted.json()) as { run?: { id: string; status: string; conversationId: string | null }; message?: string };
  assert.ok(accepted.ok, `the task is accepted (${accepted.status}): ${payload.message ?? ''}`);
  const runId = payload.run!.id;
  const conversationId = payload.run!.conversationId!;

  let events = await readStream(runId);
  const last = events[events.length - 1];

  // Approving a plan is the operator's one irreversible tap; do it exactly as
  // the card does, then read the same stream from where it stopped.
  if (last?.name === 'run.plan_ready') {
    const approved = await api(`/api/runs/${runId}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200, 'the plan can be approved');
    events = events.concat(await readStream(runId, { after: last.seq ?? 0 }));
  }

  return { runId, conversationId, events };
}

describe('a heavy user walks the app', () => {
  test('the saved link signs in, and the app assets are served', async () => {
    // A browser navigation with the saved link. `redirect: 'manual'` matters:
    // the key is turned into a cookie *on the redirect*, and a script that
    // follows the redirect has not stored it, exactly like a browser with
    // cookies switched off. The real phone keeps the cookie and lands signed
    // in on the stripped URL.
    const claimed = await fetch(`${base}/api/status?k=${ACCESS_KEY}`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    });
    assert.equal(claimed.status, 302, 'the key is claimed and stripped from the address bar');
    assert.equal(claimed.headers.get('location'), '/api/status');
    const setCookie = claimed.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /ac_session=/);
    assert.match(setCookie, /HttpOnly/);
    cookie = setCookie.split(';')[0];

    for (const asset of ['/', '/app.js', '/styles.css', '/welcome.js']) {
      const res = await api(asset);
      assert.equal(res.status, 200, `${asset} is served`);
    }

    // Without the cookie nothing is served: deny by default still holds.
    const anonymous = await fetch(`${base}/api/conversations`);
    assert.equal(anonymous.status, 401);
  });

  test('a task streams into one run: plan, approval, answer, and a file', async () => {
    const { runId, conversationId, events } = await runTask({
      prompt: COMPLEX_PROMPT,
      attachments: [{ name: 'prices.csv', text: 'sku,price\nshop-a,1200\nshop-b,900\n' }],
    });

    const names = events.map((e) => e.name);
    assert.ok(names.includes('run.plan_ready'), 'a complex task asks before it spends');

    // Every durable event belongs to this run, and the sequence never goes
    // backwards and never repeats — this is what lets the client attach a
    // reconnect to the card it already has instead of building a second one.
    const seqs = durable(events).map((e) => e.seq as number);
    assert.ok(seqs.length > 0, 'the run reported itself durably, not just as decoration');
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'events arrive in order');
    assert.equal(new Set(seqs).size, seqs.length, 'no event is delivered twice, across the approval too');
    for (const event of events) {
      if (event.data.runId) assert.equal(event.data.runId, runId, 'every event names this run');
    }

    assert.ok(names.includes('run.completed'), `the task finished (got ${names.join(', ')})`);
    const textSnapshots = events.filter((e) => e.name === 'text.snapshot');
    assert.ok(textSnapshots.length > 0, 'the answer streamed in pieces, not one block at the end');
    const finalText = String(textSnapshots[textSnapshots.length - 1].data.text ?? '');
    assert.match(finalText, /site\/index\.html/, 'and the answer is the finished text');

    const messages = (await (await api(`/api/conversations/${conversationId}/messages`)).json()) as {
      messages: Array<{ id: string; role: string; content: string; feedback: unknown }>;
    };
    assert.equal(messages.messages[0].role, 'user');
    assert.ok(messages.messages[0].content.includes('Build me a small landing page'), 'the question is stored');
    assert.ok(messages.messages[0].content.includes('prices.csv'), 'the attached file is named in the thread');
    assert.ok(
      !messages.messages[0].content.includes('shop-a,1200'),
      'but its contents stay out of the conversation, where they could leak back out of the API',
    );

    const answer = messages.messages.find((m) => m.role === 'assistant');
    assert.ok(answer, 'the answer is stored as a message');
    assert.match(answer!.content, /site\/index\.html/);
    assert.equal(answer!.feedback, null, 'an untouched answer carries no rating');

    // Re-attaching replays only what came after the cursor: a reconnect is a
    // continuation, not a second copy.
    const cursor = durable(events)[0].seq as number;
    const replay = await readStream(runId, { after: cursor, until: (e) => e.name === 'run.completed' });
    const replayed = durable(replay).map((e) => e.seq as number);
    assert.ok(replayed[0] > cursor, 'the replay starts after the cursor');
    assert.ok(!replayed.some((seq) => seq <= cursor), 'and never repeats an event the client already drew');
    assert.ok(replay.some((e) => e.name === 'run.completed'), 'including the end of the run');
  });

  test('the file it produced can be listed, opened and kept', async () => {
    const conversations = (await (await api('/api/conversations')).json()) as { conversations: Array<{ id: string }> };
    const conversationId = conversations.conversations[0].id;
    const messages = (await (await api(`/api/conversations/${conversationId}/messages`)).json()) as {
      messages: Array<{ runId: string | null; role: string }>;
    };
    const runId = messages.messages.find((m) => m.role === 'assistant')!.runId!;

    const list = (await (await api(`/api/runs/${runId}/artifacts`)).json()) as {
      artifacts: Array<{ id: string; name: string; previewable: boolean; downloadUrl: string }>;
    };
    assert.equal(list.artifacts.length, 1, 'one file came back');
    const file = list.artifacts[0];
    assert.equal(file.name, 'index.html');
    assert.equal(file.previewable, true, 'a web page can be opened, not only downloaded');

    // The bytes live in a sandbox that does not exist in a test — the point is
    // that the failure is a sentence with the right status, never a 500 and
    // never a corrupt download.
    const download = await api(file.downloadUrl);
    if (download.status !== 200) {
      const body = (await download.json()) as { message?: string; error?: string };
      assert.equal(download.status, 404);
      assert.ok(body.message || body.error, 'a missing file explains itself');
    }

    const pinned = await api(`/api/artifacts/${file.id}/pin`, { method: 'POST' });
    assert.ok([200, 404, 409].includes(pinned.status), `keeping a file answers with a fact, not a crash (${pinned.status})`);
    if (pinned.status !== 200) {
      const body = (await pinned.json()) as { message?: string };
      assert.ok(body.message && body.message.length > 10, 'and says why it could not');
    }
  });

  test('an answer can be rated, re-rated, and read back', async () => {
    const conversations = (await (await api('/api/conversations')).json()) as { conversations: Array<{ id: string }> };
    const conversationId = conversations.conversations[0].id;
    const messages = (await (await api(`/api/conversations/${conversationId}/messages`)).json()) as {
      messages: Array<{ id: string; role: string }>;
    };
    const answerId = messages.messages.find((m) => m.role === 'assistant')!.id;

    // The live card rates by run; the stored thread rates by message. Both have
    // to land on the same row.
    const byRun = await api(`/api/runs/${(messages.messages.find((m) => m.role === 'assistant') as { runId?: string }).runId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'down', reason: 'wrong' }),
    });
    assert.equal(byRun.status, 200, 'a rating can be given from the card that just finished');
    const byRunBack = (await (await api(`/api/conversations/${conversationId}/messages`)).json()) as {
      messages: Array<{ id: string; feedback: { rating: string } | null }>;
    };
    assert.equal(byRunBack.messages.find((m) => m.id === answerId)!.feedback?.rating, 'down', 'and it lands on the answer in the thread');

    const down = await api(`/api/messages/${answerId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'down', reason: 'too_long', note: 'Shorter next time.' }),
    });
    assert.equal(down.status, 200);

    // Changing his mind is one row, not two.
    const up = await api(`/api/messages/${answerId}/feedback`, { method: 'POST', body: JSON.stringify({ rating: 'up' }) });
    assert.equal(up.status, 200);
    const back = (await (await api(`/api/conversations/${conversationId}/messages`)).json()) as {
      messages: Array<{ id: string; feedback: { rating: string; reason: string | null } | null }>;
    };
    const rated = back.messages.find((m) => m.id === answerId)!;
    assert.equal(rated.feedback?.rating, 'up', 'the newest opinion is the one that shows');
    assert.equal(rated.feedback?.reason, null, 'and it does not carry the old complaint');

    const summary = (await (await api('/api/feedback/summary')).json()) as { up: number; down: number; recent: unknown[] };
    assert.ok(summary.up >= 1 && summary.recent.length >= 1, 'and it can be read back as a set');

    const cleared = await api(`/api/messages/${answerId}/feedback`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    const after = (await (await api(`/api/conversations/${conversationId}/messages`)).json()) as {
      messages: Array<{ id: string; feedback: unknown }>;
    };
    assert.equal(after.messages.find((m) => m.id === answerId)!.feedback, null, 'and taken back');
  });

  test('a bad rating explains itself rather than failing silently', async () => {
    const conversations = (await (await api('/api/conversations')).json()) as { conversations: Array<{ id: string }> };
    const messages = (await (await api(`/api/conversations/${conversations.conversations[0].id}/messages`)).json()) as {
      messages: Array<{ id: string; role: string }>;
    };
    const answerId = messages.messages.find((m) => m.role === 'assistant')!.id;

    const nonsense = await api(`/api/messages/${answerId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'down', reason: 'because' }),
    });
    assert.equal(nonsense.status, 400);
    assert.match(String(((await nonsense.json()) as { message: string }).message), /Unknown reason/);

    const missing = await api('/api/messages/msg_nope/feedback', { method: 'POST', body: JSON.stringify({ rating: 'up' }) });
    assert.equal(missing.status, 404);
  });

  test('the task can be found again by what was said inside it', async () => {
    const byTitle = (await (await api('/api/conversations?q=landing')).json()) as { conversations: unknown[] };
    assert.ok(byTitle.conversations.length >= 1, 'search by what the task was about');

    const byBody = (await (await api('/api/conversations?q=index.html')).json()) as { conversations: unknown[] };
    assert.ok(byBody.conversations.length >= 1, 'and by something said inside it, not just the title');

    const nothing = (await (await api('/api/conversations?q=zzzznothinghere')).json()) as { conversations: unknown[] };
    assert.equal(nothing.conversations.length, 0, 'and an empty result is honest');
  });

  test('a finished task can be shared as a replay a stranger can read', async () => {
    const conversations = (await (await api('/api/conversations')).json()) as { conversations: Array<{ id: string }> };
    const messages = (await (await api(`/api/conversations/${conversations.conversations[0].id}/messages`)).json()) as {
      messages: Array<{ runId: string | null; role: string }>;
    };
    const runId = messages.messages.find((m) => m.role === 'assistant')!.runId!;

    const shared = await api(`/api/runs/${runId}/share`, { method: 'POST' });
    assert.equal(shared.status, 200);
    const { url } = (await shared.json()) as { url: string };
    const token = url.split('/share/')[1];

    // No session: this is the link that gets texted to a phone.
    const page = await fetch(`${base}/share/${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('<h1>Task replay</h1>'));
    assert.ok(/task/i.test(html) && !/mission/i.test(html), 'it says task, never mission');
    assert.ok(!/<script/.test(html), 'and runs no script at all');
    assert.ok(html.includes('--paper:#f5f3ef'), 'while wearing the app\u2019s own palette');

    const revoked = await api(`/api/runs/${runId}/share`, { method: 'DELETE' });
    assert.equal(revoked.status, 200);
    assert.equal((await fetch(`${base}/share/${token}`)).status, 404, 'and a revoked link stops working');
  });

  test('one task at a time, and a running task can be stopped', async () => {
    // A task that is genuinely still working: the fast script finishes before a
    // cancel could ever reach it, which would make this test a lie.
    const slow = await startApp(
      new ScriptedEngine({
        steps: Array.from({ length: 40 }, (_, i) => ({ log: `working ${i}`, delayMs: 250 })),
        speed: 1,
      }),
    );
    try {
      const accept = (prompt: string) =>
        fetch(`${slow.base}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ prompt }),
        });

      const first = await accept('a long one');
      assert.ok(first.ok);
      const runId = ((await first.json()) as { run: { id: string } }).run.id;

      const second = await accept('and another');
      assert.equal(second.status, 409, 'the second task is refused while the first is running');
      const refusal = (await second.json()) as { message: string; activeRunId: string };
      assert.equal(refusal.activeRunId, runId, 'and the refusal names the task that is in the way');

      const active = (await (await fetch(`${slow.base}/api/runs/active`, { headers: { cookie } })).json()) as {
        run: { id: string } | null;
      };
      assert.equal(active.run?.id, runId, 'the running task is visible, so it cannot be forgotten');

      const cancelled = await fetch(`${slow.base}/api/runs/${runId}/cancel`, { method: 'POST', headers: { cookie } });
      assert.equal(cancelled.status, 200);

      // Read the stream the way the client does: it should end with the run
      // saying it stopped, not by timing out.
      const stream = await fetch(`${slow.base}/api/runs/${runId}/stream`, {
        headers: { cookie, accept: 'text/event-stream' },
      });
      const body = await stream.text();
      assert.match(body, /event: run\.cancelled/, 'and the stream says it stopped');
      assert.ok(!/event: run\.completed/.test(body), 'without pretending it finished');
    } finally {
      await slow.close();
    }
  });

  test('the next task can be booked, the profile remembered, the budget read', async () => {
    const reminder = await api('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({ text: 'check the deploy', runAt: new Date(Date.now() + 3_600_000).toISOString() }),
    });
    assert.ok([200, 201].includes(reminder.status), `a reminder can be booked (${reminder.status})`);
    const list = (await (await api('/api/reminders')).json()) as { reminders: Array<{ id: string }> };
    assert.ok(list.reminders.length >= 1, 'and it is listed');
    const removed = await api(`/api/reminders/${list.reminders[0].id}`, { method: 'DELETE' });
    assert.ok([200, 204].includes(removed.status));

    const memory = await api('/api/memory');
    assert.equal(memory.status, 200, 'memory answers');

    const budget = (await (await api('/api/budget')).json()) as {
      limit: number;
      buckets: Array<{ bucket: string; used: number; remaining: number }>;
    };
    assert.ok(budget.limit >= 1, 'the daily budget is readable');
    assert.ok(Array.isArray(budget.buckets) && budget.buckets.length >= 1, 'with what has been spent per channel');
    assert.ok(budget.buckets.every((b) => typeof b.used === 'number' && typeof b.remaining === 'number'));

    const settings = (await (await api('/api/settings')).json()) as { settings: Array<{ key: string; value: unknown }> };
    assert.ok(settings.settings.some((s) => s.key === 'dailyRunBudget'), 'settings are listed');

    const briefing = await api('/api/briefing');
    assert.equal(briefing.status, 200, 'the briefing answers');
  });

  test('a task that claims success with unfinished steps is failed, with the reason', async () => {
    // The agent said it was done; the checks say three steps never finished.
    // The operator must see a failure with that sentence on it rather than a
    // cheerful answer built on nothing.
    const sloppy = await startApp(
      new ScriptedEngine({
        steps: [
          { log: 'Step 1/2: Read the thing', delayMs: 1 },
          { log: 'Step 2/2: Change the thing', delayMs: 1 },
          { text: 'All done!', delayMs: 1 },
        ],
        speed: 0,
      }),
    );
    try {
      const accepted = await fetch(`${sloppy.base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ prompt: COMPLEX_PROMPT }),
      });
      const { run } = (await accepted.json()) as { run: { id: string; status: string } };
      if (run.status === 'awaiting_plan') {
        await fetch(`${sloppy.base}/api/runs/${run.id}/approve`, { method: 'POST', headers: { cookie } });
      }
      const stream = await fetch(`${sloppy.base}/api/runs/${run.id}/stream`, { headers: { cookie, accept: 'text/event-stream' } });
      const body = await stream.text();
      assert.match(body, /event: run\.failed/, 'the run is failed, not quietly completed');
      assert.match(body, /verification_failed/);
      assert.match(body, /step\(s\) not finished/, 'and the reason is the unfinished steps');
    } finally {
      await sloppy.close();
    }
  });

  test('a task that fails says so, in the thread and in the stream', async () => {
    // The same app, a task that dies: the operator still gets one card with a
    // reason on it rather than a spinner that never stops.
    const failing = new ScriptedEngine({
      steps: [
        { log: 'Step 1/1: Try the thing', delayMs: 1 },
        { log: 'Trying', delayMs: 1 },
        { fail: 'the sandbox refused the build', errorType: 'engine_error', delayMs: 1 },
      ],
      speed: 0,
    });
    const bus = new EventBus();
    const app = createApp({
      config: loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, ACCESS_KEY: ACCESS_KEY, DAILY_RUN_BUDGET: '50' } as NodeJS.ProcessEnv),
      db,
      bus,
      executor: new RunExecutor({ db, bus, engine: failing }),
      ...createStores(db, loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, ACCESS_KEY: ACCESS_KEY } as NodeJS.ProcessEnv)),
      status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
    });
    const failingServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const failingBase = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;
    try {
      const accepted = await fetch(`${failingBase}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ prompt: 'build the thing that breaks' }),
      });
      const { run } = (await accepted.json()) as { run: { id: string } };
      const stream = await fetch(`${failingBase}/api/runs/${run.id}/stream`, { headers: { cookie, accept: 'text/event-stream' } });
      const body = await stream.text();
      assert.match(body, /event: run\.failed/, 'the failure reaches the viewer');
    } finally {
      await new Promise<void>((resolve) => failingServer.close(() => resolve()));
    }
  });
});
