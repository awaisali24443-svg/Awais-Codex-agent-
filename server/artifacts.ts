/**
 * Artifacts — the files a mission produced.
 *
 * v2 recorded nothing: the engine noticed an `.apk` in a tool call, wrote a log
 * line, and the file itself was unreachable. This module closes that gap in two
 * halves, because they fail for different reasons and must be separable:
 *
 *   THE RECORD  (`artifacts` table)
 *     What a mission says it built. Written from the durable event stream, so
 *     it survives the process that produced it and is readable while the run is
 *     still going.
 *
 *   THE BYTES   (the sandbox tarball)
 *     The remote environment is the only place the file actually exists. It is
 *     fetched lazily, on the first download, because pulling a whole workspace
 *     snapshot for a run nobody asks about is pure waste — and a snapshot can
 *     be hundreds of megabytes.
 *
 * A record without bytes is a normal, explainable state: the sandbox expired,
 * or the build never ran. The download route says exactly that instead of
 * serving an empty file, which is the v1 behaviour worth keeping.
 *
 * Path handling is deliberately paranoid. The only thing a caller supplies is
 * an artifact *id* and, indirectly, a basename that came from the agent; the
 * search walks the extracted directory for that basename and then re-checks
 * that the result is still inside the extraction root.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { Db } from './db.js';
import { newId } from './runs.js';

const run = promisify(execFile);

export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** A workspace snapshot can be large; the read timeout has to allow for it. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface Artifact {
  id: string;
  runId: string;
  name: string;
  path: string | null;
  mime: string | null;
  size: number | null;
  sha256: string | null;
  storageKey: string | null;
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  name: string;
  path: string | null;
  mime: string | null;
  size: string | number | null;
  sha256: string | null;
  storage_key: string | null;
  created_at: Date | string;
}

const ARTIFACT_COLUMNS = 'id, run_id, name, path, mime, size, sha256, storage_key, created_at';

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    path: row.path,
    mime: row.mime,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    sha256: row.sha256,
    storageKey: row.storage_key,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

/** Where extracted sandbox snapshots live, on the ephemeral disk. */
export function artifactsRoot(): string {
  return path.join(process.cwd(), 'data', 'artifacts');
}

/** Content type for the download route. Anything unknown is a binary stream. */
export function mimeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.apk')) return 'application/vnd.android.package-archive';
  if (lower.endsWith('.aab')) return 'application/octet-stream';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.tar')) return 'application/x-tar';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'application/gzip';
  if (lower.endsWith('.ipa')) return 'application/octet-stream';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

/** Basename of an agent-supplied path, normalised. Null when there is none. */
export function artifactName(filePath: string): string | null {
  const cleaned = String(filePath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned) return null;
  const name = cleaned.slice(cleaned.lastIndexOf('/') + 1);
  if (!name || name === '.' || name === '..') return null;
  return name;
}

/**
 * Remember that a mission produced a file.
 *
 * Idempotent per (run, path): the agent can mention the same output on every
 * build step, and the table should hold one row, not fifteen.
 */
export async function recordArtifact(
  db: Db,
  runId: string,
  filePath: string,
): Promise<Artifact | null> {
  const name = artifactName(filePath);
  if (!name) return null;
  const normalisedPath = String(filePath).trim().replace(/\\/g, '/');

  const existing = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE run_id = $1 AND path = $2 LIMIT 1`,
    [runId, normalisedPath],
  );
  if (existing[0]) return mapArtifact(existing[0]);

  const rows = await db.query<ArtifactRow>(
    `INSERT INTO artifacts (id, run_id, name, path, mime)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
       RETURNING ${ARTIFACT_COLUMNS}`,
    [newId('art'), runId, name, normalisedPath, mimeFor(name)],
  );

  if (rows[0]) return mapArtifact(rows[0]);

  // A concurrent insert of the same path won; read it back.
  const raced = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE run_id = $1 AND path = $2 LIMIT 1`,
    [runId, normalisedPath],
  );
  return raced[0] ? mapArtifact(raced[0]) : null;
}

export async function listArtifacts(db: Db, runId: string): Promise<Artifact[]> {
  const rows = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId],
  );
  return rows.map(mapArtifact);
}

export async function getArtifact(db: Db, id: string): Promise<Artifact | null> {
  const rows = await db.query<ArtifactRow>(
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapArtifact(rows[0]) : null;
}

async function markStored(
  db: Db,
  id: string,
  stored: { size: number; sha256: string; storageKey: string },
): Promise<void> {
  await db.query(
    `UPDATE artifacts SET size = $2, sha256 = $3, storage_key = $4 WHERE id = $1`,
    [id, stored.size, stored.sha256, stored.storageKey],
  );
}

/**
 * Retention: files live on an ephemeral disk, so this is hygiene rather than
 * real storage. Rows older than the window go, and their cached bytes with
 * them — `ARTIFACT_RETENTION_DAYS` finally means something.
 */
export async function pruneArtifacts(db: Db, keepDays = 7): Promise<number> {
  const rows = await db.query<{ id: string; storage_key: string | null }>(
    `DELETE FROM artifacts
      WHERE created_at < now() - ($1 || ' days')::interval
      RETURNING id, storage_key`,
    [String(Math.max(0, keepDays))],
  );

  for (const row of rows) {
    if (row.storage_key) {
      try {
        fs.rmSync(path.join(artifactsRoot(), row.storage_key), { force: true });
      } catch {
        /* best effort: the row is gone, which is what matters */
      }
    }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// the bytes
// ---------------------------------------------------------------------------

export interface DownloadDeps {
  apiKey: string;
  environmentId: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Stream the environment's workspace snapshot to a local file.
 *
 * Streamed rather than buffered: a snapshot is a whole Linux workspace, and
 * reading it into a Buffer is how a 512 MB instance dies. Returns the local
 * path, or null when the sandbox is gone — an expired environment answers 404
 * and that is an ordinary outcome, not an error to shout about.
 */
export async function downloadEnvironmentArchive(
  deps: DownloadDeps,
  targetPath: string,
): Promise<string | null> {
  const base = (deps.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const url = `${base}/files/environment-${encodeURIComponent(deps.environmentId)}:download?alt=media`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const response = await fetchImpl(url, {
    headers: { 'x-goog-api-key': deps.apiKey },
    signal: AbortSignal.timeout(deps.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) return null;

  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(targetPath));
  return targetPath;
}

/**
 * Extract an archive with the system `tar`, which auto-detects gzip.
 *
 * Shelling out is deliberate: the alternative is a tar implementation in this
 * repository, and every one of those has had a path-traversal CVE. `tar -xf`
 * into an empty directory is the boring, correct choice.
 */
export async function extractArchive(archivePath: string, intoDir: string): Promise<void> {
  fs.mkdirSync(intoDir, { recursive: true });
  await run('tar', ['-xf', archivePath, '-C', intoDir], { timeout: 120_000, maxBuffer: 1024 * 1024 });
}

/**
 * Find a file by basename anywhere in the extracted tree.
 *
 * Only the basename is ever used, so a path from the agent cannot climb out of
 * the extraction root; the prefix check afterwards is belt and braces.
 */
export function findFileByBasename(root: string, basename: string): string | null {
  const wanted = path.basename(basename).toLowerCase();
  if (!wanted || wanted === '.' || wanted === '..') return null;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.toLowerCase() !== wanted) continue;

      const resolved = path.resolve(full);
      const rootResolved = path.resolve(root);
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) continue;
      return resolved;
    }
  }
  return null;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export interface MaterializeDeps extends DownloadDeps {
  db: Db;
}

export interface MaterializeResult {
  absolutePath: string;
  size: number;
  /** True when the bytes were copied out of a fresh sandbox download. */
  fetched: boolean;
}

/**
 * Get an artifact's bytes onto this disk, from cache or from the sandbox.
 *
 * Cache first: the second download of a file from the same environment must not
 * pull the whole workspace again.
 */
export async function materializeArtifact(
  deps: MaterializeDeps,
  artifact: Artifact,
): Promise<MaterializeResult | null> {
  const root = artifactsRoot();

  // Re-read the row first. Callers hold whatever they loaded before the
  // previous download wrote `storage_key`, and trusting that stale copy makes
  // the cache invisible — which turns every second request into another
  // workspace download.
  const fresh = (await getArtifact(deps.db, artifact.id)) ?? artifact;

  if (fresh.storageKey) {
    const cached = path.join(root, fresh.storageKey);
    if (fs.existsSync(cached)) {
      return { absolutePath: cached, size: fs.statSync(cached).size, fetched: false };
    }
  }

  const environmentId = deps.environmentId?.trim();
  if (!environmentId || !deps.apiKey) return null;

  const envDir = path.join(root, environmentId);
  const archivePath = path.join(envDir, 'snapshot.tar');
  const extractDir = path.join(envDir, 'extracted');

  try {
    if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) {
      const downloaded = await downloadEnvironmentArchive(deps, archivePath);
      if (!downloaded) return null;
    }
    if (!fs.existsSync(extractDir)) await extractArchive(archivePath, extractDir);

    const found = findFileByBasename(extractDir, fresh.name);
    if (!found) return null;

    // Copy into a per-artifact location so the cache key is the artifact, not
    // a path inside a tree that a later extraction may replace.
    const storageKey = path.join(fresh.id, fresh.name);
    const target = path.join(root, storageKey);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(found, target);

    const size = fs.statSync(target).size;
    await markStored(deps.db, fresh.id, { size, sha256: sha256(target), storageKey });
    return { absolutePath: target, size, fetched: true };
  } catch (err) {
    console.warn(`[artifacts] could not materialize ${fresh.name}:`, (err as Error).message);
    return null;
  }
}
