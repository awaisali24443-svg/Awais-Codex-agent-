/**
 * The morning digest.
 *
 * The claim being tested is the anti-spam contract: one WhatsApp message per
 * morning, never a run, never a throw — and nothing at all without a token,
 * a recipient, or the toggle on.
 */
import test, { after, afterEach, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from '../db.js';
import { migrate } from '../migrate.js';
import { createRun, setRunStatus, type Run } from '../runs.js';
import { newId } from '../runs.js';
import type { SecretName } from '../settings.js';
import { saveCreatorId } from './store.js';
import {
  collectDigestData,
  composeMorningDigest,
  karachiDateString,
  maybeSendMorningDigest,
  type DigestData,
  type DigestDeps,
} from './morningdigest.js';

const TOKEN = 'wa-agent-api-key-from-the-phone';
const CREATOR = 'user:creator-01';
/** A morning the tests own: 2026-09-23 07:30 Asia/Karachi = 02:30 UTC. */
const MORNING = new Date('2026-09-23T07:30:00+05:00');

let db: Db;

interface CapturedSend {
  body: Record<string, unknown>;
}

/** A stand-in for the agent API that only records outbound sends. */
async function fakePlatform(): Promise<{ url: string; sends: CapturedSend[]; close(): Promise<void> }> {
  const sends: CapturedSend[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/messages') {
        sends.push({ body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: 'wamid.1' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const secrets = (token: string | null, to: string | null = null) => ({
  get: (name: SecretName) => (name === 'whatsapp_to' ? to ?? '' : token ?? ''),
});

const baseDeps = (overrides: Partial<DigestDeps> = {}): DigestDeps => ({
  db,
  config: { morningDigestEnabled: true },
  secrets: secrets(TOKEN),
  now: () => MORNING,
  ...overrides,
});

/** A finished run inside the digest window, then completed so the next one may start. */
async function finishedRun(
  prompt: string,
  status: 'completed' | 'failed' | 'cancelled',
  errorMessage: string | null = null,
): Promise<Run> {
  const run = await createRun(db, { prompt, kind: 'chat', engine: 'scripted' });
  await setRunStatus(
    db,
    run.id,
    status,
    status === 'failed' ? { errorType: 'boom', errorMessage } : {},
  );
  // Land the run inside the 12-hour window relative to MORNING.
  await db.query(`UPDATE runs SET finished_at = $2 WHERE id = $1`, [
    run.id,
    new Date(MORNING.getTime() - 3_600_000).toISOString(),
  ]);
  return run;
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

afterEach(async () => {
  await db.query(`DELETE FROM runs`);
  await db.query(`DELETE FROM linkedin_drafts`);
  await db.query(`DELETE FROM scheduled_tasks`);
  await db.query(`DELETE FROM morning_digest_log`);
  await db.query(`DELETE FROM wa_state`);
});

describe('composeMorningDigest', () => {
  const quiet: DigestData = {
    date: '2026-09-23',
    finished: [],
    active: [],
    drafts: [],
    dueToday: [],
  };

  test('a quiet night is one short line, not silence', () => {
    const message = composeMorningDigest(quiet);
    assert.ok(message.startsWith('🌅 Morning digest —'));
    assert.ok(message.includes('Quiet night'));
    assert.doesNotMatch(message, /\|/);
  });

  test('a busy night names failures with their reason and what is waiting', () => {
    const message = composeMorningDigest({
      ...quiet,
      finished: [
        { id: 'r1', status: 'completed', kind: 'chat', prompt: 'Water the plants', errorType: null, errorMessage: null },
        { id: 'r2', status: 'failed', kind: 'chat', prompt: 'Fix the login bug', errorType: 'boom', errorMessage: 'timed out after 30 minutes of trying', },
      ],
      active: [
        { id: 'r3', status: 'awaiting_plan', kind: 'chat', prompt: 'Add search to the site', errorType: null, errorMessage: null },
      ],
      drafts: [{ id: 'd1', snippet: 'Excited to share what we built this week' }],
      dueToday: [{ id: 's1', name: 'Evening review', at: '18:30' }],
    });
    assert.ok(message.includes('2 ran'));
    assert.ok(message.includes('1 failed'));
    assert.ok(message.includes('❌ "Fix the login bug" — timed out after 30 minutes of trying'));
    assert.ok(message.includes('1 plan to approve'));
    assert.ok(message.includes('1 LinkedIn draft to publish'));
    assert.ok(message.includes('18:30 — Evening review'));
  });
});

describe('karachiDateString', () => {
  test('07:30 PKT on 23 Sep is 2026-09-23 even though it is still 22 Sep in UTC', () => {
    assert.equal(karachiDateString(MORNING), '2026-09-23');
  });
});

describe('collectDigestData', () => {
  test('sees finished runs, active runs, drafts, and schedules due today', async () => {
    const ok = await finishedRun('Nightly research', 'completed');
    await finishedRun('Broken task', 'failed', 'kaboom');
    // One active run right now.
    const active = await createRun(db, { prompt: 'Still working', kind: 'chat', engine: 'scripted' });

    await db.query(
      `INSERT INTO linkedin_drafts (id, run_id, text, status) VALUES ($1, $2, $3, 'pending')`,
      [newId('dr'), ok.id, 'A draft post about the launch'],
    );
    await db.query(
      `INSERT INTO scheduled_tasks
         (id, name, prompt, cadence, time_of_day, timezone, deliver, next_run_at)
       VALUES ($1, 'Evening review', 'review', 'daily', '18:30', 'Asia/Karachi', 'web', $2)`,
      [newId('sch'), new Date('2026-09-23T18:30:00+05:00').toISOString()],
    );

    const data = await collectDigestData(db, MORNING);
    assert.equal(data.date, '2026-09-23');
    assert.equal(data.finished.length, 2);
    assert.ok(data.finished.some((r) => r.status === 'failed' && r.errorMessage === 'kaboom'));
    assert.equal(data.active.length, 1);
    assert.equal(data.active[0].id, active.id);
    assert.equal(data.drafts.length, 1);
    assert.equal(data.dueToday.length, 1);
    assert.equal(data.dueToday[0].at, '18:30');
  });

  test('ignores published drafts and schedules due tomorrow', async () => {
    const ok = await finishedRun('Nightly research', 'completed');
    await db.query(
      `INSERT INTO linkedin_drafts (id, run_id, text, status) VALUES ($1, $2, $3, 'published')`,
      [newId('dr'), ok.id, 'already out'],
    );
    await db.query(
      `INSERT INTO scheduled_tasks
         (id, name, prompt, cadence, time_of_day, timezone, deliver, next_run_at)
       VALUES ($1, 'Tomorrow thing', 'x', 'daily', '09:00', 'Asia/Karachi', 'web', $2)`,
      [newId('sch'), new Date('2026-09-24T09:00:00+05:00').toISOString()],
    );

    const data = await collectDigestData(db, MORNING);
    assert.equal(data.drafts.length, 0);
    assert.equal(data.dueToday.length, 0);
  });
});

describe('maybeSendMorningDigest', () => {
  test('sends one message to the learned creator id on a busy morning', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    await saveCreatorId(db, 'agent-test', CREATOR);
    await finishedRun('Nightly research', 'completed');
    await finishedRun('Broken task', 'failed', 'kaboom');

    const ok = await maybeSendMorningDigest({ ...baseDeps(), baseUrl: platform.url, fetchImpl: fetch });
    assert.equal(ok, true);
    assert.equal(platform.sends.length, 1);
    const payload = platform.sends[0].body;
    assert.equal(payload.to, CREATOR);
    const text = (payload.text as { body?: string })?.body ?? '';
    assert.ok(text.startsWith('🌅 Morning digest —'));
    assert.ok(text.includes('1 failed'));
    assert.ok(text.includes('kaboom'));
  });

  test('a second attempt the same morning sends nothing — one message per morning', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    await saveCreatorId(db, 'agent-test', CREATOR);
    const deps = { ...baseDeps(), baseUrl: platform.url, fetchImpl: fetch };
    assert.equal(await maybeSendMorningDigest(deps), true);
    assert.equal(await maybeSendMorningDigest(deps), false);
    assert.equal(platform.sends.length, 1);
  });

  test('silent without a token', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await saveCreatorId(db, 'agent-test', CREATOR);
    const ok = await maybeSendMorningDigest({
      ...baseDeps({ secrets: secrets(null) }),
      baseUrl: platform.url,
      fetchImpl: fetch,
    });
    assert.equal(ok, false);
    assert.equal(platform.sends.length, 0);
  });

  test('silent when the toggle is off', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await saveCreatorId(db, 'agent-test', CREATOR);
    const ok = await maybeSendMorningDigest({
      ...baseDeps({ config: { morningDigestEnabled: false } }),
      baseUrl: platform.url,
      fetchImpl: fetch,
    });
    assert.equal(ok, false);
    assert.equal(platform.sends.length, 0);
  });

  test('silent without a recipient — never throws', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    // No learned creator id, no override.
    const ok = await maybeSendMorningDigest({ ...baseDeps(), baseUrl: platform.url, fetchImpl: fetch });
    assert.equal(ok, false);
    assert.equal(platform.sends.length, 0);
  });

  test('a platform failure is swallowed, not thrown — and still claims the day', async (t) => {
    const failing = await httpFailingPlatform();
    t.after(() => failing.close());
    await saveCreatorId(db, 'agent-test', CREATOR);
    const deps = { ...baseDeps(), baseUrl: failing.url, fetchImpl: fetch };
    assert.equal(await maybeSendMorningDigest(deps), false);
    assert.equal(failing.sends.length, 0);
    // The day was claimed: no retry spam on the next tick.
    assert.equal(await maybeSendMorningDigest(deps), false);
  });
});

/** A platform that answers 500 to every send. */
async function httpFailingPlatform(): Promise<{ url: string; sends: CapturedSend[]; close(): Promise<void> }> {
  const sends: CapturedSend[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
