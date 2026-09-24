/**
 * Pinned artifacts.
 *
 * The promise under test: a file the operator asks to keep is stored in the
 * database, is served from there after the sandbox is gone, and is not swept by
 * retention. Before this, every artifact was a promise with an expiry date — the
 * bytes came from an expiring sandbox, the cache lived on an ephemeral disk, and
 * the row itself was deleted after seven days.
 *
 * The failing-before shape is the third case: with `environmentId` nulled (what
 * an expired sandbox looks like) an unpinned artifact is a 404, and a pinned one
 * still downloads.
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
  PINNED_MAX_BYTES,
  artifactsRoot,
  getArtifact,
  pinArtifact,
  pinnedBytes,
  pruneArtifacts,
  recordArtifact,
  unpinArtifact,
} from './artifacts.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import type { AppConfig } from './config.js';

const config = { appUrl: 'https://example.test', geminiApiKey: '' } as AppConfig;

let db: Db;
let base: string;
let closeServer: () => Promise<void>;

function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api', createArtifactRoutes({ db, config }));
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
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

/** A finished run and one recorded artifact, with bytes cached where the code looks. */
async function artifactWithBytes(
  name: string,
  contents: string,
): Promise<{ runId: string; artifactId: string }> {
  const run = await createRun(db, { prompt: 'build it', engine: 'scripted' });
  const artifact = (await recordArtifact(db, run.id, `/out/${name}`))!;
  await finishRun(db, run.id, { status: 'completed', text: 'done' });

  const dir = path.join(artifactsRoot(), artifact.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents);
  await db.query('UPDATE artifacts SET size = $2, storage_key = $3 WHERE id = $1', [
    artifact.id,
    contents.length,
    path.join(artifact.id, name),
  ]);
  return { runId: run.id, artifactId: artifact.id };
}

describe('pinning', () => {
  test('the bytes land in the database and come back byte-for-byte', async () => {
    const { artifactId } = await artifactWithBytes('report.pdf', 'PDF-BYTES-HERE');

    const result = await pinArtifact(db, artifactId, { db, apiKey: '', environmentId: '' });
    assert.equal(result.ok, true, 'pinning a cached artifact succeeds');

    const stored = await pinnedBytes(db, artifactId);
    assert.equal(stored?.bytes.toString('utf8'), 'PDF-BYTES-HERE');

    const row = await db.query<{ pinned: boolean; size: string }>(
      'SELECT pinned, size FROM artifacts WHERE id = $1',
      [artifactId],
    );
    assert.equal(row[0]?.pinned, true);
    assert.equal(Number(row[0]?.size), 'PDF-BYTES-HERE'.length);
  });

  test('an artifact whose bytes are gone cannot be pinned — and says why', async () => {
    const run = await createRun(db, { prompt: 'never built', engine: 'scripted' });
    const artifact = (await recordArtifact(db, run.id, '/out/missing.zip'))!;
    await finishRun(db, run.id, { status: 'completed', text: 'done' });

    const result = await pinArtifact(db, artifact.id, { db, apiKey: '', environmentId: '' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unavailable');
    assert.match(result.message, /never built|could not be read/);
  });

  test('the size cap is enforced rather than silently truncating', async () => {
    const { artifactId } = await artifactWithBytes('huge.bin', 'x');
    // Pretend the file is enormous: the check reads the materialized size.
    const big = path.join(artifactsRoot(), artifactId, 'huge.bin');
    fs.writeFileSync(big, Buffer.alloc(PINNED_MAX_BYTES + 1, 0x41));
    await db.query('UPDATE artifacts SET size = $2 WHERE id = $1', [
      artifactId,
      PINNED_MAX_BYTES + 1,
    ]);

    const result = await pinArtifact(db, artifactId, { db, apiKey: '', environmentId: '' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'too_large');
    assert.equal(await pinnedBytes(db, artifactId), null);
  });
});

describe('a pinned file outlives everything that used to delete it', () => {
  test('it downloads after the sandbox is gone, where an unpinned copy 404s', async () => {
    const { artifactId } = await artifactWithBytes('app-debug.apk', 'APK-BYTES');

    // No sandbox, no cached bytes: what an expired environment looks like.
    fs.rmSync(path.join(artifactsRoot(), artifactId), { recursive: true, force: true });

    const before = await fetch(`${base}/api/artifacts/${artifactId}/download`);
    assert.equal(before.status, 404, 'unpinned + no cache + no sandbox = honest 404');

    const pinned = await pinArtifact(db, artifactId, {
      db,
      apiKey: 'k',
      environmentId: '',
      // The materializer would return null here too; seed the cache first so the
      // pin has something real to keep, exactly as a first download would.
    });
    assert.equal(pinned.ok, false, 'nothing to pin once every source is gone');

    // Now the realistic order: the file is downloaded once, then kept.
    const { artifactId: freshId } = await artifactWithBytes('app-debug.apk', 'APK-BYTES');
    const kept = await pinArtifact(db, freshId, { db, apiKey: '', environmentId: '' });
    assert.equal(kept.ok, true);

    fs.rmSync(path.join(artifactsRoot(), freshId), { recursive: true, force: true });
    await db.query('UPDATE runs SET environment_id = NULL');

    const after = await fetch(`${base}/api/artifacts/${freshId}/download`);
    assert.equal(after.status, 200, 'the pinned bytes are served with no sandbox and no cache');
    assert.equal(await after.text(), 'APK-BYTES');
    assert.match(after.headers.get('content-disposition') ?? '', /app-debug\.apk/);
  });

  test('retention spares a pinned row and still takes an unpinned one', async () => {
    const { artifactId: keptId } = await artifactWithBytes('keep.txt', 'keep me');
    const { artifactId: oldId } = await artifactWithBytes('forget.txt', 'let me go');

    assert.equal((await pinArtifact(db, keptId, { db, apiKey: '', environmentId: '' })).ok, true);

    // Age both beyond the window, then sweep.
    await db.query(`UPDATE artifacts SET created_at = now() - interval '30 days'`);
    const removed = await pruneArtifacts(db, 7);

    assert.equal(removed, 1, 'only the unpinned row was swept');
    assert.ok(await getArtifact(db, keptId), 'the pinned row survived');
    assert.equal(await getArtifact(db, oldId), null);
    assert.equal((await pinnedBytes(db, keptId))?.bytes.toString('utf8'), 'keep me');
  });

  test('unpinning deletes the stored bytes, so the database does not grow forever', async () => {
    const { artifactId } = await artifactWithBytes('temp.txt', 'temp');
    await pinArtifact(db, artifactId, { db, apiKey: '', environmentId: '' });
    assert.ok(await pinnedBytes(db, artifactId));

    const updated = await unpinArtifact(db, artifactId);
    assert.equal(updated?.pinned, false);
    assert.equal(await pinnedBytes(db, artifactId), null);
  });
});

describe('POST /api/artifacts/:id/pin', () => {
  test('unknown artifact 404s', async () => {
    const res = await fetch(`${base}/api/artifacts/art_missing/pin`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  test('pins over HTTP and reports it in the run\'s artifact list', async () => {
    const { runId, artifactId } = await artifactWithBytes('notes.md', '# notes');

    const res = await fetch(`${base}/api/artifacts/${artifactId}/pin`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; artifact: { pinned: boolean; size: number } };
    assert.equal(body.ok, true);
    assert.equal(body.artifact.pinned, true);
    assert.equal(body.artifact.size, '# notes'.length);

    const list = await fetch(`${base}/api/runs/${runId}/artifacts`);
    const listed = (await list.json()) as { artifacts: Array<{ id: string; pinned: boolean }> };
    assert.equal(listed.artifacts.find((a) => a.id === artifactId)?.pinned, true);
  });

  test('an unavailable artifact is a 409 with the reason, not a 500', async () => {
    const run = await createRun(db, { prompt: 'nothing', engine: 'scripted' });
    const artifact = (await recordArtifact(db, run.id, '/out/gone.txt'))!;
    await finishRun(db, run.id, { status: 'completed', text: 'done' });

    const res = await fetch(`${base}/api/artifacts/${artifact.id}/pin`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'unavailable');
    assert.ok(body.message.length > 10);
  });

  test('unpin over HTTP clears the flag', async () => {
    const { artifactId } = await artifactWithBytes('x.txt', 'x');
    await fetch(`${base}/api/artifacts/${artifactId}/pin`, { method: 'POST' });

    const res = await fetch(`${base}/api/artifacts/${artifactId}/unpin`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { artifact: { pinned: boolean } };
    assert.equal(body.artifact.pinned, false);
  });
});
