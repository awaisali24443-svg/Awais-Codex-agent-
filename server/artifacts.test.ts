/**
 * Artifact tests.
 *
 * Two halves, tested separately because they fail for different reasons: the
 * *record* (does the product know what a mission built) and the *bytes* (can it
 * actually hand the file over). The interesting cases are the unhappy ones —
 * an expired sandbox, a file that was never built, and an agent-supplied path
 * that tries to climb out of the extraction directory.
 */
import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun } from './runs.js';
import {
  artifactName,
  artifactsRoot,
  extractArchive,
  findFileByBasename,
  getArtifact,
  listArtifacts,
  materializeArtifact,
  mimeFor,
  pruneArtifacts,
  recordArtifact,
} from './artifacts.js';

let db: Db;
let runId: string;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
  fs.rmSync(artifactsRoot(), { recursive: true, force: true });
});

beforeEach(async () => {
  await db.query('DELETE FROM artifacts');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  const run = await createRun(db, { prompt: 'build an android app', engine: 'scripted' });
  runId = run.id;
  fs.rmSync(artifactsRoot(), { recursive: true, force: true });
});

describe('naming', () => {
  test('takes the basename of an agent-supplied path', () => {
    assert.equal(artifactName('app/build/outputs/apk/debug/app-debug.apk'), 'app-debug.apk');
    assert.equal(artifactName('C:\\builds\\release.aab'), 'release.aab');
    assert.equal(artifactName('  /tmp/out.zip  '), 'out.zip');
  });

  test('refuses a path with nothing usable in it', () => {
    assert.equal(artifactName(''), null);
    assert.equal(artifactName('   '), null);
    assert.equal(artifactName('/'), null);
    assert.equal(artifactName('../..'), null);
  });

  test('maps well-known extensions to content types', () => {
    assert.equal(mimeFor('app-debug.apk'), 'application/vnd.android.package-archive');
    assert.equal(mimeFor('bundle.tar.gz'), 'application/gzip');
    assert.equal(mimeFor('report.pdf'), 'application/pdf');
    assert.equal(mimeFor('mystery.bin'), 'application/octet-stream');
  });
});

describe('the record', () => {
  test('records a produced file, once per path', async () => {
    const first = await recordArtifact(db, runId, 'app/build/outputs/apk/debug/app-debug.apk');
    const again = await recordArtifact(db, runId, 'app/build/outputs/apk/debug/app-debug.apk');

    assert.ok(first);
    assert.equal(first.name, 'app-debug.apk');
    assert.equal(first.mime, 'application/vnd.android.package-archive');
    assert.equal(again?.id, first.id, 'the same path must not produce a second row');

    const all = await listArtifacts(db, runId);
    assert.equal(all.length, 1);
  });

  test('records two different files from the same mission', async () => {
    await recordArtifact(db, runId, '/tmp/app-debug.apk');
    await recordArtifact(db, runId, '/tmp/workspace.zip');

    const names = (await listArtifacts(db, runId)).map((a) => a.name).sort();
    assert.deepEqual(names, ['app-debug.apk', 'workspace.zip']);
  });

  test('starts with no bytes attached', async () => {
    const artifact = await recordArtifact(db, runId, '/tmp/app-debug.apk');
    assert.equal(artifact?.storageKey, null);
    assert.equal(artifact?.size, null);
    assert.equal((await getArtifact(db, artifact?.id ?? ''))?.sha256, null);
  });

  test('ignores a file path it cannot name', async () => {
    assert.equal(await recordArtifact(db, runId, '   '), null);
    assert.equal(await listArtifacts(db, runId).then((a) => a.length), 0);
  });

  test('prunes old rows and their cached files', async () => {
    const artifact = await recordArtifact(db, runId, '/tmp/app-debug.apk');
    const cached = path.join(artifactsRoot(), artifact?.id ?? 'x', 'app-debug.apk');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, 'bytes');
    await db.query(`UPDATE artifacts SET storage_key = $2, created_at = now() - interval '30 days' WHERE id = $1`, [
      artifact?.id,
      path.join(artifact?.id ?? 'x', 'app-debug.apk'),
    ]);

    assert.equal(await pruneArtifacts(db, 7), 1);
    assert.equal(fs.existsSync(cached), false, 'the cached bytes go with the row');
    assert.equal(await listArtifacts(db, runId).then((a) => a.length), 0);
  });
});

describe('the bytes', () => {
  /** Build a real tar.gz the way the sandbox snapshot arrives. */
  function makeArchive(files: Record<string, string>): Buffer {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-art-'));
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    // The archive is written beside the staging directory, never inside it —
    // tar fails with "file changed as we read it" otherwise.
    const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tar-')), 'snapshot.tgz');
    execFileSync('tar', ['-czf', archive, '-C', staging, '.']);
    return fs.readFileSync(archive);
  }

  function fakeDownload(body: Buffer | null, status = 200): typeof fetch {
    return (async () =>
      body
        ? new Response(new Uint8Array(body), { status })
        : new Response('gone', { status })) as unknown as typeof fetch;
  }

  test('extracts the requested file out of a snapshot', async () => {
    const archive = makeArchive({
      'app/build/outputs/apk/debug/app-debug.apk': 'APK-BYTES',
      'app/src/main.js': 'console.log(1)',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extract-'));
    const archivePath = path.join(dir, 'snapshot.tgz');
    fs.writeFileSync(archivePath, archive);

    await extractArchive(archivePath, path.join(dir, 'out'));

    const found = findFileByBasename(path.join(dir, 'out'), 'app-debug.apk');
    assert.ok(found, 'the file should be found by basename');
    assert.equal(fs.readFileSync(found as string, 'utf-8'), 'APK-BYTES');
  });

  test('does not find a file that is not in the archive', async () => {
    const archive = makeArchive({ 'app/src/main.js': 'x' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extract-'));
    const archivePath = path.join(dir, 'snapshot.tgz');
    fs.writeFileSync(archivePath, archive);
    await extractArchive(archivePath, path.join(dir, 'out'));

    assert.equal(findFileByBasename(path.join(dir, 'out'), 'app-debug.apk'), null);
  });

  test('a traversal attempt in the requested name finds nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-root-'));
    fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'not yours');

    // Only the basename is ever used, so climbing out is not merely blocked —
    // there is nothing to climb with.
    assert.equal(findFileByBasename(root, '../../secret.txt'), null);
    assert.equal(findFileByBasename(root, '..'), null);
  });

  test('downloads, extracts and caches on the first request', async () => {
    const archive = makeArchive({ 'out/app-release.apk': 'RELEASE' });
    const artifact = await recordArtifact(db, runId, '/workspace/out/app-release.apk');
    assert.ok(artifact);

    const result = await materializeArtifact(
      { db, apiKey: 'test-key', environmentId: 'env_1', fetchImpl: fakeDownload(archive) },
      artifact,
    );

    assert.ok(result, 'the artifact should materialize');
    assert.equal(fs.readFileSync(result.absolutePath, 'utf-8'), 'RELEASE');
    assert.equal(result.fetched, true);
    assert.equal(result.size, 7);

    const stored = await getArtifact(db, artifact.id);
    assert.ok(stored?.storageKey, 'the row remembers where the bytes went');
    assert.equal(stored?.size, 7);
    assert.match(stored?.sha256 ?? '', /^[0-9a-f]{64}$/);
  });

  test('the second request is served from the cache, not the sandbox', async () => {
    const archive = makeArchive({ 'out/app-release.apk': 'RELEASE' });
    const artifact = await recordArtifact(db, runId, '/workspace/out/app-release.apk');
    assert.ok(artifact);
    const options = { db, apiKey: 'k', environmentId: 'env_1' };

    await materializeArtifact({ ...options, fetchImpl: fakeDownload(archive) }, artifact);

    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(new Uint8Array(archive), { status: 200 });
    }) as unknown as typeof fetch;

    const second = await materializeArtifact({ ...options, fetchImpl: counting }, artifact);
    assert.ok(second);
    assert.equal(second.fetched, false);
    assert.equal(calls, 0, 'a cached artifact must not re-download the workspace');
  });

  test('an expired sandbox is a null, not an exception', async () => {
    const artifact = await recordArtifact(db, runId, '/workspace/out/app-debug.apk');
    assert.ok(artifact);

    const result = await materializeArtifact(
      { db, apiKey: 'k', environmentId: 'env_gone', fetchImpl: fakeDownload(null, 404) },
      artifact,
    );
    assert.equal(result, null);
  });

  test('a file recorded but never built yields nothing, honestly', async () => {
    const archive = makeArchive({ 'src/index.js': 'nothing to see' });
    const artifact = await recordArtifact(db, runId, '/workspace/out/app-debug.apk');
    assert.ok(artifact);

    const result = await materializeArtifact(
      { db, apiKey: 'k', environmentId: 'env_1', fetchImpl: fakeDownload(archive) },
      artifact,
    );
    assert.equal(result, null, 'a missing file must not be invented');
  });

  test('with no key or environment there is nothing to fetch from', async () => {
    const artifact = await recordArtifact(db, runId, '/workspace/out/app-debug.apk');
    assert.ok(artifact);

    assert.equal(await materializeArtifact({ db, apiKey: '', environmentId: 'env_1' }, artifact), null);
    assert.equal(await materializeArtifact({ db, apiKey: 'k', environmentId: '' }, artifact), null);
  });
});
