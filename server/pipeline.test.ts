/**
 * End-to-end tests for the two features v2 was missing.
 *
 * The unit tests next door prove the memory engine and the artifact store work
 * in isolation. These prove they are actually *wired in*: that a mission's
 * prompt reaches the engine with memory attached, that the operator's stored
 * prompt is not rewritten, that learning happens after the run closes, and that
 * an artifact can be fetched over HTTP from a sandbox snapshot.
 *
 * Wiring is where features go to die quietly — a module that passes its own
 * tests and is never called looks identical to a working one until a user asks.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from './app.js';
import { createStores } from './settings.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig, type AppConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { createRun, finishRun, getRun, buildHistoryBlock } from './runs.js';
import { addMemory, clearMemories, listMemories, updateProfile } from './memory.js';
import { artifactsRoot, listArtifacts, recordArtifact } from './artifacts.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import type { Engine, EngineContext, EngineResult } from './engine/types.js';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'pipeline-access-key-for-tests';

/** Captures the prompt the engine was actually handed. */
class RecordingEngine implements Engine {
  readonly name = 'recording';
  readonly prompts: string[] = [];

  async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
    this.prompts.push(prompt);
    ctx.log('recording');
    ctx.text('done');
    return { text: 'done', interactionId: 'int_1', environmentId: 'env_1' };
  }
}

let db: Db;
let agent: Server;
let base: string;
let engine: RecordingEngine;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'key',
      ACCESS_KEY,
      SESSION_SECRET: SECRET,
      ENGINE: 'scripted',
      DAILY_RUN_BUDGET: '50',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

/** The access key header stands in for the browser's session cookie. */
const auth = { 'x-access-key': ACCESS_KEY };

async function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, { headers: auth });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Wait for a run to reach a terminal state without sleeping a fixed amount. */
async function settle(runId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(db, runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

before(async () => {
  db = await createDb('');
  await migrate(db);

  engine = new RecordingEngine();
  const bus = new EventBus();
  const config = makeConfig();
  const executor = new RunExecutor({ db, bus, engine, snapshotIntervalMs: 10 });
  const app = createApp({
    config,
    db,
    bus,
    executor,
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
  });

  agent = http.createServer(app);
  await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => agent.close(() => resolve()));
  await db.close();
  fs.rmSync(artifactsRoot(), { recursive: true, force: true });
});

beforeEach(async () => {
  engine.prompts.length = 0;
  await clearMemories(db);
  await db.query('UPDATE memory_profile SET name = NULL, role = NULL, preferred_language = NULL, preferred_frameworks = \'[]\'::jsonb, environment = NULL, custom_directives = \'[]\'::jsonb');
  await db.query('DELETE FROM artifacts');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
});

describe('memory reaches the agent', () => {
  test('a recalled memory is prepended to the prompt the engine receives', async () => {
    await updateProfile(db, { name: 'Awais' });
    await addMemory(db, { content: 'The deployment target is Render', tags: ['deploy'] });

    const created = await post('/api/runs', { prompt: 'how do I deploy this' });
    assert.equal(created.status, 201);
    await settle(created.body.run.id);

    assert.equal(engine.prompts.length, 1);
    const sent = engine.prompts[0];
    assert.match(sent, /PERSISTENT MEMORY/);
    assert.match(sent, /Name: Awais/);
    assert.match(sent, /deployment target is Render/);
    assert.ok(sent.endsWith('how do I deploy this'), 'the operator prompt stays last and verbatim');
  });

  test('the stored prompt stays exactly what the operator typed', async () => {
    await addMemory(db, { content: 'Prefers Tailwind for styling', tags: ['styling'] });

    const created = await post('/api/runs', { prompt: 'style this styling page' });
    await settle(created.body.run.id);

    const run = await getRun(db, created.body.run.id);
    assert.equal(run?.prompt, 'style this styling page');
    assert.equal(run?.prompt.includes('PERSISTENT MEMORY'), false);
  });

  test('the recall is recorded as a durable event, so it is explainable', async () => {
    await addMemory(db, { content: 'Uses PostgreSQL', tags: ['postgresql'] });
    const created = await post('/api/runs', { prompt: 'is postgresql the right database here' });
    await settle(created.body.run.id);

    const detail = await get(`/api/runs/${created.body.run.id}`);
    const recall = detail.body.events.find((e: { type: string }) => e.type === 'memory.recall');
    assert.ok(recall, 'expected a memory.recall event');
    assert.equal(recall.payload.recalled, 1);
  });

  test('with nothing remembered the prompt is untouched', async () => {
    const created = await post('/api/runs', { prompt: 'build a calculator' });
    await settle(created.body.run.id);

    assert.equal(engine.prompts[0], 'build a calculator');
    const detail = await get(`/api/runs/${created.body.run.id}`);
    assert.equal(
      detail.body.events.some((e: { type: string }) => e.type === 'memory.recall'),
      false,
      'nothing was remembered, so nothing should be claimed',
    );
  });
});

describe('memory learns from a mission', () => {
  test('an explicit instruction is remembered after the run closes', async () => {
    const created = await post('/api/runs', { prompt: 'remember that: deploys go through Render' });
    await settle(created.body.run.id);

    // Extraction is deliberately detached from the run, so it lands a beat later.
    const deadline = Date.now() + 2_000;
    let stored = await listMemories(db);
    while (stored.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      stored = await listMemories(db);
    }

    assert.equal(stored.length, 1);
    assert.equal(stored[0].category, 'instruction');
    assert.match(stored[0].content, /deploys go through Render/);
    assert.equal(stored[0].source, 'web');
  });

  test('the next mission already benefits from what the last one taught', async () => {
    const first = await post('/api/runs', { prompt: 'remember that: the staging URL is stage.example.com' });
    await settle(first.body.run.id);

    const deadline = Date.now() + 2_000;
    while ((await listMemories(db)).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const second = await post('/api/runs', { prompt: 'what is the staging URL' });
    await settle(second.body.run.id);
    assert.match(engine.prompts.at(-1) ?? '', /stage\.example\.com/);
  });
});

describe('the memory API', () => {
  test('is behind the session, like everything else under /api', async () => {
    const res = await fetch(`${base}/api/memory`);
    assert.equal(res.status, 401);
  });

  test('exposes what is remembered and lets it be corrected', async () => {
    const headers = { 'content-type': 'application/json', 'x-access-key': ACCESS_KEY };

    const created = await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Prefers pnpm', category: 'preference', tags: ['tooling'] }),
    });
    assert.equal(created.status, 201);
    const { memory } = (await created.json()) as { memory: { id: string } };

    const listed = await fetch(`${base}/api/memory`, { headers });
    const listedBody = (await listed.json()) as { memories: unknown[]; total: number };
    assert.equal(listedBody.total, 1);

    const patched = await fetch(`${base}/api/memory/${memory.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ content: 'Prefers pnpm, not npm' }),
    });
    assert.equal(patched.status, 200);

    const removed = await fetch(`${base}/api/memory/${memory.id}`, { method: 'DELETE', headers });
    assert.equal(removed.status, 200);

    const empty = (await (await fetch(`${base}/api/memory`, { headers })).json()) as { total: number };
    assert.equal(empty.total, 0);
  });

  test('rejects a category it does not know rather than guessing', async () => {
    const res = await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-key': ACCESS_KEY },
      body: JSON.stringify({ content: 'x', category: 'vibes' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('a mission that builds something', () => {
  test('an artifact the engine produces becomes a recorded row and a durable event', async () => {
    class BuildingEngine implements Engine {
      readonly name = 'building';
      async run(_prompt: string, ctx: EngineContext): Promise<EngineResult> {
        ctx.artifact?.('app/build/outputs/apk/debug/app-debug.apk');
        ctx.text('built it');
        return { text: 'built it', environmentId: 'env_build' };
      }
    }

    const bus = new EventBus();
    const executor = new RunExecutor({ db, bus, engine: new BuildingEngine(), snapshotIntervalMs: 10 });
    const run = await createRun(db, { prompt: 'build the app', engine: 'building' });
    executor.start(run);

    const deadline = Date.now() + 5_000;
    let stored = await listArtifacts(db, run.id);
    while (stored.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      stored = await listArtifacts(db, run.id);
    }

    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, 'app-debug.apk');
    assert.equal(stored[0].mime, 'application/vnd.android.package-archive');

    const detail = await get(`/api/runs/${run.id}`);
    const event = detail.body.events.find((e: { type: string }) => e.type === 'artifact');
    assert.ok(event, 'the stream must tell the client what was built');
    assert.equal(event.payload.id, stored[0].id, 'the event carries the id, so the UI can link it');
  });
});

describe('artifacts over HTTP', () => {
  /** A tar.gz shaped exactly like the sandbox snapshot. */
  function archiveWith(files: Record<string, string>): Buffer {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pipe-'));
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pipe-tar-')), 'snapshot.tgz');
    execFileSync('tar', ['-czf', out, '-C', staging, '.']);
    return fs.readFileSync(out);
  }

  async function serve(snapshot: Buffer | null) {
    const config = makeConfig({ geminiApiKey: 'test-key' });
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createArtifactRoutes({
        db,
        config,
        fetchImpl: (async () =>
          snapshot
            ? new Response(new Uint8Array(snapshot), { status: 200 })
            : new Response('gone', { status: 404 })) as unknown as typeof fetch,
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  test('lists what a mission produced', async () => {
    const run = await createRun(db, { prompt: 'build it', engine: 'recording' });
    await recordArtifact(db, run.id, 'app/build/outputs/apk/debug/app-debug.apk');

    const { url, close } = await serve(null);
    try {
      const res = await fetch(`${url}/api/runs/${run.id}/artifacts`);
      const body = (await res.json()) as { artifacts: Array<{ name: string; downloadUrl: string; stored: boolean }> };

      assert.equal(res.status, 200);
      assert.equal(body.artifacts.length, 1);
      assert.equal(body.artifacts[0].name, 'app-debug.apk');
      assert.equal(body.artifacts[0].stored, false, 'nothing is downloaded until it is asked for');
      assert.match(body.artifacts[0].downloadUrl, /^\/api\/artifacts\/.+\/download$/);
    } finally {
      await close();
    }
  });

  test('404s on an unknown run rather than inventing an empty list', async () => {
    const { url, close } = await serve(null);
    try {
      const res = await fetch(`${url}/api/runs/run_nope/artifacts`);
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  });

  test('downloads the bytes out of the sandbox snapshot', async () => {
    const run = await createRun(db, { prompt: 'build it', engine: 'recording' });
    const artifact = await recordArtifact(db, run.id, 'out/app-release.apk');
    await db.query('UPDATE runs SET environment_id = $2 WHERE id = $1', [run.id, 'env_pipe']);

    const { url, close } = await serve(archiveWith({ 'out/app-release.apk': 'APK-BYTES' }));
    try {
      const res = await fetch(`${url}/api/artifacts/${artifact?.id}/download`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
      assert.match(res.headers.get('content-disposition') ?? '', /filename="app-release\.apk"/);
      assert.equal(await res.text(), 'APK-BYTES');
    } finally {
      await close();
    }
  });

  test('an expired sandbox explains itself instead of serving an empty file', async () => {
    const run = await createRun(db, { prompt: 'build it', engine: 'recording' });
    const artifact = await recordArtifact(db, run.id, 'out/app-debug.apk');
    await db.query('UPDATE runs SET environment_id = $2 WHERE id = $1', [run.id, 'env_gone']);

    const { url, close } = await serve(null);
    try {
      const res = await fetch(`${url}/api/artifacts/${artifact?.id}/download`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, 'artifact_unavailable');
      assert.match(body.message, /expire|not in the sandbox/i);
    } finally {
      await close();
    }
  });
});

describe('conversation awareness', () => {
  test('a follow-up run sees the recent turns but not its own prompt', async () => {
    const first = await createRun(db, { prompt: 'plan my expo booth', engine: 'recording' });
    await finishRun(db, first.id, { status: 'completed', text: 'Here is your booth plan.' });

    const followup = await createRun(db, {
      prompt: 'make it cheaper',
      engine: 'recording',
      conversationId: first.conversationId,
    });

    const block = await buildHistoryBlock(db, first.conversationId, followup.id);
    assert.ok(block.includes('user: plan my expo booth'), 'sees the earlier question');
    assert.ok(block.includes('assistant: Here is your booth plan.'), 'sees the earlier answer');
    assert.ok(!block.includes('make it cheaper'), 'does not repeat its own prompt');
  });

  test('a first message gets no history block', async () => {
    const run = await createRun(db, { prompt: 'hello', engine: 'recording' });
    const block = await buildHistoryBlock(db, run.conversationId, run.id);
    assert.equal(block, '');
  });
});
