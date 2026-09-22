/**
 * The done ping.
 *
 * The claim being tested is the opt-in contract: a ping goes out exactly when
 * a web-started run asked for one and finished (or failed), and never
 * otherwise — no token, no ping; no opt-in, no ping; a WhatsApp run never
 * gets pinged on top of its relayed answer.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from '../db.js';
import { migrate } from '../migrate.js';
import { createRun, emitEvent, getRun, setRunStatus, type Run, type TerminalStatus } from '../runs.js';
import type { SecretName } from '../settings.js';
import { composeDonePing, sendDonePing } from './doneping.js';

const TOKEN = 'wa-agent-api-key-from-the-phone';

let db: Db;

interface CapturedSend {
  body: Record<string, unknown>;
}

/** A stand-in for the agent API that only records outbound sends. */
async function fakePlatform(): Promise<{ url: string; sends: CapturedSend[]; close(): Promise<void>; failNext(): void }> {
  const sends: CapturedSend[] = [];
  let fail = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/messages') {
        sends.push({ body: JSON.parse(raw) as Record<string, unknown> });
        if (fail) {
          fail = false;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'boom' } }));
          return;
        }
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
    failNext: () => {
      fail = true;
    },
  };
}

const secrets = (token: string | null, to: string | null = '+10000000000') => ({
  get: (name: SecretName) => (name === 'whatsapp_to' ? to ?? '' : token ?? ''),
});

async function makeRun(notifyWhatsapp: boolean, kind: 'chat' | 'whatsapp' = 'chat'): Promise<Run> {
  const run = await createRun(db, {
    prompt: '  Summarise the quarterly report  ',
    kind,
    engine: 'scripted',
    notifyWhatsapp,
  });
  await emitEvent(db, run.id, 'text.snapshot', { text: 'Here is the **summary**.' });
  // Keep the one-active-run rule happy: this run is done as far as the db cares.
  await setRunStatus(db, run.id, 'completed');
  return (await getRun(db, run.id)) as Run;
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

describe('composeDonePing', () => {
  test('completed ping names the task and converts the answer', () => {
    const message = composeDonePing(
      { prompt: 'Summarise the quarterly report' },
      'completed',
      'Here is the **summary**.',
      null,
    );
    assert.ok(message.startsWith('✅ Done — Summarise the quarterly report'));
    assert.ok(!message.includes('**'), 'markdown must be converted for WhatsApp');
    assert.ok(message.includes('summary'));
  });

  test('failed ping carries the reason and any partial answer', () => {
    const message = composeDonePing({ prompt: 'Big task' }, 'failed', 'partial', 'quota_exceeded');
    assert.ok(message.includes('❌ Failed'));
    assert.ok(message.includes('quota_exceeded'));
    assert.ok(message.includes('partial'));
  });
});

describe('sendDonePing', () => {
  test('sends one ping for an opted-in web run that completed', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    const run = await makeRun(true);
    const ok = await sendDonePing(
      { db, secrets: secrets(TOKEN), baseUrl: platform.url },
      run,
      'completed',
    );

    assert.equal(ok, true);
    assert.equal(platform.sends.length, 1);
    const payload = platform.sends[0].body;
    const text = (payload.text as { body?: string })?.body ?? '';
    assert.ok(text.includes('✅ Done — Summarise the quarterly report'));
    assert.equal(payload.to, '+10000000000', 'the ping carries the configured recipient');
  });

  test('stays silent without a configured recipient', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    const run = await makeRun(true);
    assert.equal(
      await sendDonePing({ db, secrets: secrets(TOKEN, null), baseUrl: platform.url }, run, 'completed'),
      false,
    );
    assert.equal(platform.sends.length, 0);
  });

  test('stays silent without an opt-in, for other channels, and on cancel', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    const deps = { db, secrets: secrets(TOKEN), baseUrl: platform.url };

    assert.equal(await sendDonePing(deps, await makeRun(false), 'completed'), false);
    assert.equal(await sendDonePing(deps, await makeRun(true, 'whatsapp'), 'completed'), false);
    assert.equal(await sendDonePing(deps, await makeRun(true), 'cancelled' as TerminalStatus), false);
    assert.equal(platform.sends.length, 0);
  });

  test('stays silent without a token, and never throws on platform failure', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    const run = await makeRun(true);
    assert.equal(
      await sendDonePing({ db, secrets: secrets(null), baseUrl: platform.url }, run, 'completed'),
      false,
    );

    platform.failNext();
    assert.equal(
      await sendDonePing({ db, secrets: secrets(TOKEN), baseUrl: platform.url }, run, 'failed'),
      false,
      'a failed send resolves false, it does not throw',
    );
  });
});
