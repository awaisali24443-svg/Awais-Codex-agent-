/**
 * Public artifact download links.
 *
 * The promise under test: a finished mission's file can get an unguessable
 * public link (`POST /api/artifacts/:id/share`), and that link downloads the
 * bytes with no session (`GET /a/:token`) — the shape that lets a WhatsApp
 * text carry a file to the phone. The unhappy paths are the interesting ones:
 * unfinished runs never mint, malformed/unknown/revoked tokens 404 with no
 * hint, and a resumed run's link 404s until it finishes again.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun, finishRun } from './runs.js';
import {
  artifactsRoot,
  getArtifactByShareToken,
  recordArtifact,
  setArtifactShareToken,
} from './artifacts.js';
import { artifactShareUrl, newShareToken } from './share.js';
import { createArtifactRoutes, createPublicArtifactRoutes } from './routes/artifacts.js';
import type { AppConfig } from './config.js';

const config = {
  appUrl: 'https://awais-codex-agent-arena.onrender.com/',
  geminiApiKey: '',
} as AppConfig;

let db: Db;
let base: string;
let closeServer: () => Promise<void>;

function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    // Mounted exactly like app.ts: the mint route behind /api (authenticated
    // in production; the session layer is tested elsewhere), the download
    // route public.
    app.use('/api', createArtifactRoutes({ db, config }));
    app.use(createPublicArtifactRoutes({ db, config }));
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

before(async () => {
  db = await createDb('');
  await migrate(db);
  const started = await startServer();
  base = started.base;
  closeServer = started.close;
});

after(async () => {
  await closeServer();
  await db.close();
  fs.rmSync(artifactsRoot(), { recursive: true, force: true });
});

beforeEach(async () => {
  await db.query('DELETE FROM artifacts');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  fs.rmSync(artifactsRoot(), { recursive: true, force: true });
});

async function finishedRunWithArtifact(name: string): Promise<{ runId: string; artifactId: string }> {
  const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
  const artifact = (await recordArtifact(db, run.id, `/out/${name}`))!;
  await finishRun(db, run.id, { status: 'completed', text: 'done' });
  return { runId: run.id, artifactId: artifact.id };
}

/** Seed cached bytes so the download never touches the sandbox. */
function seedBytes(artifactId: string, name: string, bytes: string): void {
  const dir = path.join(artifactsRoot(), artifactId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  return undefined;
}

async function seedStored(artifactId: string, name: string, bytes: string): Promise<void> {
  seedBytes(artifactId, name, bytes);
  await db.query('UPDATE artifacts SET size = $2, sha256 = $3, storage_key = $4 WHERE id = $1', [
    artifactId,
    bytes.length,
    'seed',
    path.join(artifactId, name),
  ]);
}

describe('artifactShareUrl', () => {
  test('joins the base and the /a/ path, stripping a trailing slash', () => {
    assert.equal(
      artifactShareUrl(config, 'tok123'),
      'https://awais-codex-agent-arena.onrender.com/a/tok123',
    );
  });

  test('a token is URL-safe by construction', () => {
    assert.match(newShareToken(), /^[A-Za-z0-9_-]{32}$/);
  });
});

describe('share token storage', () => {
  test('round-trips: mint, look up, revoke', async () => {
    const { artifactId } = await finishedRunWithArtifact('app-debug.apk');
    assert.equal(await getArtifactByShareToken(db, 'nope'), null);
    assert.equal(await getArtifactByShareToken(db, ''), null);

    const token = newShareToken();
    await setArtifactShareToken(db, artifactId, token);
    const found = await getArtifactByShareToken(db, token);
    assert.equal(found?.id, artifactId);

    await setArtifactShareToken(db, artifactId, null);
    assert.equal(await getArtifactByShareToken(db, token), null);
  });
});

describe('POST /api/artifacts/:id/share', () => {
  test('unknown artifact 404s', async () => {
    const res = await fetch(`${base}/api/artifacts/art_missing/share`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('an unfinished run cannot mint a link', async () => {
    const run = await createRun(db, { prompt: 'still going', engine: 'scripted' });
    const artifact = (await recordArtifact(db, run.id, '/out/app-debug.apk'))!;
    const res = await fetch(`${base}/api/artifacts/${artifact.id}/share`, { method: 'POST' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'not_finished');
  });

  test('a finished run mints an idempotent link, and the list shows it', async () => {
    const { runId, artifactId } = await finishedRunWithArtifact('app-debug.apk');

    const first = await fetch(`${base}/api/artifacts/${artifactId}/share`, { method: 'POST' });
    assert.equal(first.status, 200);
    const one = (await first.json()) as { url: string; token: string };
    assert.match(one.url, new RegExp(`/a/${one.token}$`));

    const second = await fetch(`${base}/api/artifacts/${artifactId}/share`, { method: 'POST' });
    const two = (await second.json()) as { url: string; token: string };
    assert.equal(two.token, one.token, 'minting twice keeps the same link');

    const list = await fetch(`${base}/api/runs/${runId}/artifacts`);
    const listed = (await list.json()) as {
      artifacts: Array<{ id: string; shareUrl: string | null }>;
    };
    assert.equal(listed.artifacts[0]?.shareUrl, one.url);
  });
});

describe('GET /a/:token', () => {
  test('a malformed token 404s with no hint', async () => {
    for (const bad of ['x', '../etc', 'tok with space', 'a'.repeat(65)]) {
      const res = await fetch(`${base}/a/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 404, bad);
      assert.equal(await res.text(), 'Not found');
    }
  });

  test('an unknown token 404s with no hint', async () => {
    const res = await fetch(`${base}/a/${newShareToken()}`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not found');
  });

  test('a revoked token 404s', async () => {
    const { artifactId } = await finishedRunWithArtifact('notes.txt');
    const token = newShareToken();
    await setArtifactShareToken(db, artifactId, token);
    await setArtifactShareToken(db, artifactId, null);
    const res = await fetch(`${base}/a/${token}`);
    assert.equal(res.status, 404);
  });

  test('a token on an unfinished run 404s', async () => {
    const run = await createRun(db, { prompt: 'still going', engine: 'scripted' });
    const artifact = (await recordArtifact(db, run.id, '/out/app-debug.apk'))!;
    const token = newShareToken();
    await setArtifactShareToken(db, artifact.id, token);
    const res = await fetch(`${base}/a/${token}`);
    assert.equal(res.status, 404);
  });

  test('a valid token downloads the bytes as an attachment', async () => {
    const { artifactId } = await finishedRunWithArtifact('app-debug.apk');
    await seedStored(artifactId, 'app-debug.apk', 'APK-BYTES-HERE');
    const token = newShareToken();
    await setArtifactShareToken(db, artifactId, token);

    const res = await fetch(`${base}/a/${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(
      res.headers.get('content-disposition') ?? '',
      /attachment; filename="app-debug\.apk"/,
    );
    assert.equal(await res.text(), 'APK-BYTES-HERE');
  });
});
