/**
 * Artifact routes.
 *
 *   GET /api/runs/:id/artifacts      what this mission produced (the record)
 *   GET /api/artifacts/:id/download  the bytes, fetched from the sandbox on demand
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
import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { getArtifact, listArtifacts, materializeArtifact } from '../artifacts.js';
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

  return router;
}
