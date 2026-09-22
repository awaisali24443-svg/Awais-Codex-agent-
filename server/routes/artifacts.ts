/**
 * Artifact routes.
 *
 *   GET /api/runs/:id/artifacts      what this mission produced (the record)
 *   GET /api/artifacts/:id/download  the bytes, fetched from the sandbox on demand
 *   GET /api/artifacts/:id/preview   a website artifact, rendered live (the
 *                                    HTML entry page plus its relative assets)
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
import {
  artifactsRoot,
  getArtifact,
  isHtmlArtifactName,
  listArtifacts,
  materializeArtifact,
  mimeFor,
} from '../artifacts.js';
import { getRun } from '../runs.js';

export interface ArtifactRouteDeps {
  db: Db;
  config: AppConfig;
  /** Injected in tests, which point the sandbox download at a local fake. */
  fetchImpl?: typeof fetch;
}

/** Content-Disposition needs a filename that cannot break the header. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'artifact';
}

export function createArtifactRoutes({ db, config, fetchImpl }: ArtifactRouteDeps): Router {
  const router = Router();

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

    const run = await getRun(db, artifact.runId);
    const materialized = await materializeArtifact(
      {
        db,
        apiKey: config.geminiApiKey,
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
        apiKey: config.geminiApiKey,
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
