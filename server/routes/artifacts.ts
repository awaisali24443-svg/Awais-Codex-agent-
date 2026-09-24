/**
 * Artifact routes.
 *
 *   GET /api/runs/:id/artifacts      what this mission produced (the record)
 *   GET /api/artifacts/:id/download  the bytes, fetched from the sandbox on demand
 *   GET /api/artifacts/:id/preview   a website artifact, rendered live (the
 *                                    HTML entry page plus its relative assets)
 *   POST /api/artifacts/:id/pin      keep the bytes in the database, forever
 *   POST /api/artifacts/:id/unpin    let it age out again
 *   POST /api/artifacts/:id/share    mint a public download link for the file
 *   GET /a/:token                    the public download itself — no session.
 *                                    Texted to the phone, WhatsApp auto-links
 *                                    the URL, so a build output like an APK
 *                                    reaches the phone without the web UI.
 *
 * The download is lazy on purpose. Pulling a whole workspace snapshot when
 * nobody has asked for the file wastes bandwidth, disk and time — and on the
 * free tier all three are scarce. First request materialises it; every request
 * after that is served from the local copy.
 *
 * When the bytes cannot be produced the route says why, in words, with a 404.
 * A missing artifact is a fact about the world (the sandbox expired, the build
 * never ran), not a server error, and definitely not an empty file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { SecretsStore } from '../settings.js';
import type { Artifact } from '../artifacts.js';
import {
  artifactsRoot,
  getArtifact,
  getArtifactByShareToken,
  isHtmlArtifactName,
  listArtifacts,
  materializeArtifact,
  mimeFor,
  pinArtifact,
  pinnedBytes,
  setArtifactShareToken,
  unpinArtifact,
} from '../artifacts.js';
import { getRun } from '../runs.js';
import { artifactShareUrl, canShareRun, newShareToken } from '../share.js';

export interface ArtifactRouteDeps {
  db: Db;
  config: AppConfig;
  /**
   * Read at request time, never captured. A key rotated in Settings must work
   * for downloads immediately — resolving it here keeps the route store-first
   * with the env var as fallback, exactly like the engine in main.ts. Kept
   * optional so existing callers (tests) that pass only config keep working;
   * the real wiring in app.ts always passes it.
   */
  secrets?: SecretsStore;
  /** Injected in tests, which point the sandbox download at a local fake. */
  fetchImpl?: typeof fetch;
}

/** Content-Disposition needs a filename that cannot break the header. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'artifact';
}

/**
 * Send bytes this process already holds (a pinned copy).
 *
 * Same headers the disk path sets, so a client — including the Android
 * download manager — cannot tell the two apart.
 */
function sendBytes(res: Response, artifact: Artifact, bytes: Buffer, mime: string | null): void {
  res.setHeader('Content-Type', artifact.mime ?? mime ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(artifact.name)}"`);
  res.send(bytes);
}

export function createArtifactRoutes({ db, config, secrets, fetchImpl }: ArtifactRouteDeps): Router {
  const router = Router();

  // Store-first, env fallback — the same resolution the engine uses, so a key
  // rotated in Settings applies to downloads without a restart.
  const resolveApiKey = () =>
    secrets ? secrets.get('gemini_api_key') : config.geminiApiKey;

  router.get('/runs/:id/artifacts', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }

    const artifacts = await listArtifacts(db, run.id);
    res.json({
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        mime: artifact.mime,
        size: artifact.size,
        createdAt: artifact.createdAt,
        downloadUrl: `/api/artifacts/${artifact.id}/download`,
        /**
         * Public download link, once minted via POST …/share. Null until
         * then — the UI mints on demand so links are never created by
         * accident.
         */
        shareUrl: artifact.shareToken ? artifactShareUrl(config, artifact.shareToken) : null,
        /**
         * A website the mission built: the UI renders this one live in a
         * sandboxed iframe instead of offering only a download. Named from
         * the file, not the recorded mime, so rows written before the
         * recorder knew about HTML still preview.
         */
        previewable: isHtmlArtifactName(artifact.name),
        previewUrl: isHtmlArtifactName(artifact.name)
          ? `/api/artifacts/${artifact.id}/preview/`
          : null,
        /** False until someone has downloaded it once. */
        stored: artifact.storageKey !== null,
        /** Kept in the database: survives a wipe of the disk *and* the sandbox. */
        pinned: artifact.pinned,
        // The sandbox is the only source of the bytes, so this is what makes a
        // download possible at all.
        environmentId: run.environmentId,
      })),
    });
  });

  router.get('/artifacts/:id/download', async (req: Request, res: Response) => {
    const artifact = await getArtifact(db, req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact_not_found' });
      return;
    }

    // A pinned copy outranks every other source: it is the one the operator
    // asked to keep, and the only one that survives a redeploy.
    const pinned = await pinnedBytes(db, artifact.id);
    if (pinned) {
      sendBytes(res, artifact, pinned.bytes, pinned.mime);
      return;
    }

    const run = await getRun(db, artifact.runId);
    const materialized = await materializeArtifact(
      {
        db,
        apiKey: resolveApiKey(),
        environmentId: run?.environmentId ?? '',
        fetchImpl,
      },
      artifact,
    );

    if (!materialized) {
      res.status(404).json({
        error: 'artifact_unavailable',
        message: run?.environmentId
          ? `"${artifact.name}" is recorded for this mission but is not in the sandbox snapshot any more. ` +
            'Remote environments expire, and a file that was never built cannot be collected.'
          : `"${artifact.name}" is recorded, but the mission that produced it no longer has a sandbox to read it from.`,
        artifact: { id: artifact.id, name: artifact.name, path: artifact.path },
      });
      return;
    }

    res.setHeader('Content-Type', artifact.mime ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(materialized.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename(artifact.name)}"`,
    );
    res.sendFile(materialized.absolutePath, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'artifact_read_failed' });
      }
    });
  });

  /**
   * Render a website artifact in the UI: the HTML entry page, plus whatever
   * relative assets it was produced with (style.css, app.js, images/…).
   *
   * Served inline — never as a download — so the page actually runs. The
   * entry lives at /preview exactly; relative URLs inside the page resolve
   * against /preview/, which is why the wildcard route serves the assets.
   *
   * Framing is locked to this app: the global middleware forbids framing via
   * X-Frame-Options: SAMEORIGIN, but a sandboxed iframe has an opaque origin
   * and fails that check, so the preview would render as a blank box.
   * `frame-ancestors 'self'` is the precise replacement — only this app may
   * embed the page — and the UI sandboxes the iframe on top (scripts run, no
   * parent access, no top navigation).
   */
  const servePreview = async (req: Request, res: Response) => {
    const artifact = await getArtifact(db, req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact_not_found' });
      return;
    }
    if (!isHtmlArtifactName(artifact.name)) {
      res.status(404).json({
        error: 'not_previewable',
        message: `"${artifact.name}" is not a website — only HTML pages can be previewed.`,
      });
      return;
    }

    // Express 4 hands the wildcard tail to req.params[0]; the exact /preview
    // route has none, and a bare trailing slash arrives as an empty string.
    const tail = (req.params as Record<string, string | undefined>)[0];
    const relative = tail && tail.length > 0 ? tail : artifact.name;
    if (!isSafeRelativePath(relative)) {
      res.status(404).json({ error: 'preview_asset_missing' });
      return;
    }

    const run = await getRun(db, artifact.runId);
    const materialized = await materializeArtifact(
      {
        db,
        apiKey: resolveApiKey(),
        environmentId: run?.environmentId ?? '',
        fetchImpl,
      },
      artifact,
    );

    if (!materialized) {
      res.status(404).json({
        error: 'artifact_unavailable',
        message: run?.environmentId
          ? `"${artifact.name}" is recorded for this mission but is not in the sandbox snapshot any more. ` +
            'Remote environments expire, and a file that was never built cannot be collected.'
          : `"${artifact.name}" is recorded, but the mission that produced it no longer has a sandbox to read it from.`,
        artifact: { id: artifact.id, name: artifact.name, path: artifact.path },
      });
      return;
    }

    // The bytes live in the artifact's own cache directory; the entry page's
    // siblings were copied in beside it when it materialized. Nothing outside
    // that directory is servable, whatever the URL asks for.
    const dir = path.resolve(path.join(artifactsRoot(), artifact.id));
    const absolute = path.resolve(dir, relative);
    if (absolute !== dir && !absolute.startsWith(dir + path.sep)) {
      res.status(404).json({ error: 'preview_asset_missing' });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      res.status(404).json({ error: 'preview_asset_missing' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'preview_asset_missing' });
      return;
    }

    res.setHeader('Content-Type', mimeFor(path.basename(absolute)));
    res.setHeader('Content-Length', String(stat.size));
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.sendFile(absolute, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'artifact_read_failed' });
      }
    });
  };

  router.get('/artifacts/:id/preview', servePreview);
  router.get('/artifacts/:id/preview/*', servePreview);

  /**
   * Mint a public download link for a file a mission produced. Same gate as
   * mission replays: only a finished run's files get a link, and minting is
   * idempotent — the token survives, so an existing link never breaks.
   */
  /**
   * Keep a file. The bytes move into the database, and retention stops touching
   * the row — this is the difference between "I downloaded it once" and "it is
   * still there next month".
   */
  router.post('/artifacts/:id/pin', async (req: Request, res: Response) => {
    const artifact = await getArtifact(db, req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact_not_found' });
      return;
    }
    const run = await getRun(db, artifact.runId);
    const result = await pinArtifact(db, artifact.id, {
      db,
      apiKey: resolveApiKey(),
      environmentId: run?.environmentId ?? '',
      fetchImpl,
    });

    if (!result.ok) {
      res.status(result.reason === 'not_found' ? 404 : 409).json({
        error: result.reason,
        message: result.message,
        ...(result.size === undefined ? {} : { size: result.size }),
      });
      return;
    }

    res.json({
      ok: true,
      artifact: {
        id: result.artifact.id,
        name: result.artifact.name,
        size: result.size,
        pinned: result.artifact.pinned,
        downloadUrl: `/api/artifacts/${result.artifact.id}/download`,
      },
    });
  });

  /** Stop keeping it: the pinned copy goes, and normal retention resumes. */
  router.post('/artifacts/:id/unpin', async (req: Request, res: Response) => {
    const artifact = await getArtifact(db, req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact_not_found' });
      return;
    }
    const updated = await unpinArtifact(db, artifact.id);
    res.json({
      ok: true,
      artifact: updated
        ? { id: updated.id, name: updated.name, pinned: updated.pinned }
        : { id: artifact.id, name: artifact.name, pinned: false },
    });
  });

  router.post('/artifacts/:id/share', async (req: Request, res: Response) => {
    const artifact = await getArtifact(db, req.params.id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact_not_found' });
      return;
    }
    const run = await getRun(db, artifact.runId);
    if (!run || !canShareRun(run)) {
      res.status(400).json({
        error: 'not_finished',
        message: 'Only a finished mission\u2019s files can get a public link',
      });
      return;
    }
    const token = artifact.shareToken ?? newShareToken();
    if (!artifact.shareToken) await setArtifactShareToken(db, artifact.id, token);

    // A public link is a promise to a phone that may open it next week, and the
    // sandbox behind it expires on its own schedule. So sharing keeps the file:
    // best effort, because a link that works today beats a 500 about storage.
    let durable = artifact.pinned;
    if (!durable) {
      const result = await pinArtifact(db, artifact.id, {
        db,
        apiKey: resolveApiKey(),
        environmentId: run.environmentId ?? '',
        fetchImpl,
      });
      durable = result.ok;
    }

    res.json({ url: artifactShareUrl(config, token), token, durable });
  });

  return router;
}

/**
 * Public artifact downloads — mounted with no session, next to /share/:token.
 * The token IS the auth (unguessable by construction); unknown, malformed or
 * revoked tokens 404 with no hint about which. A link for a run that was
 * resumed after sharing 404s until the run finishes again, exactly like
 * replays.
 */
export function createPublicArtifactRoutes({
  db,
  config,
  secrets,
  fetchImpl,
}: ArtifactRouteDeps): Router {
  const router = Router();

  const resolveApiKey = () =>
    secrets ? secrets.get('gemini_api_key') : config.geminiApiKey;

  router.get('/a/:token', async (req: Request, res: Response) => {
    const token = req.params.token ?? '';
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const artifact = await getArtifactByShareToken(db, token);
    if (!artifact) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const run = await getRun(db, artifact.runId);
    if (!run || !canShareRun(run)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }

    // The public link is a promise made to a phone; a pinned copy is what keeps
    // it after the sandbox has expired and the disk has been wiped.
    const pinned = await pinnedBytes(db, artifact.id);
    if (pinned) {
      sendBytes(res, artifact, pinned.bytes, pinned.mime);
      return;
    }

    const materialized = await materializeArtifact(
      {
        db,
        apiKey: resolveApiKey(),
        environmentId: run.environmentId ?? '',
        fetchImpl,
      },
      artifact,
    );

    if (!materialized) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }

    res.setHeader('Content-Type', artifact.mime ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(materialized.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename(artifact.name)}"`,
    );
    res.sendFile(materialized.absolutePath, (err) => {
      if (err && !res.headersSent) {
        res.status(500).type('text/plain').send('Not found');
      }
    });
  });

  return router;
}

/**
 * A preview asset path may name siblings or subdirectories, never climb.
 * Decoded by Express before it reaches us, so %2e%2e tricks land here as
 * literal ".." segments and are rejected with everything else.
 */
function isSafeRelativePath(relative: string): boolean {
  if (!relative || relative.startsWith('/') || relative.includes('\\')) return false;
  return relative
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
