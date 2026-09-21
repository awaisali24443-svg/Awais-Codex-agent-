/**
 * Express application factory.
 *
 * Exported separately from the listen call so tests can drive it without
 * binding a port. Routes are thin: parse, validate, delegate, respond.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';

import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { EventBus } from './events.js';
import type { RunExecutor } from './executor.js';
import { createRunRoutes } from './routes/runs.js';
import { claimAccessKey, clearedSessionCookie, requireSession } from './auth.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  /** In-process event fan-out for the live stream. */
  bus: EventBus;
  /** Owns the lifecycle of in-flight runs. */
  executor: RunExecutor;
  /** Runtime status, filled in by the boot sequence. */
  status: {
    startedAt: number;
    migrationsApplied: number;
    orphanedRuns: number;
    poller: 'disabled' | 'running' | 'error';
  };
}

export function createApp(deps: AppDeps): Express {
  const { config, db, status } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us

  // Per-route size limits beat one global 50 MB: prompts are small at this
  // point in the build, and attachments get their own limit later.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Turn ?k=<access key> into a year-long session before anything else looks at
  // the request, so a bookmarked link works on any route.
  app.use(claimAccessKey(config));

  // Security headers (helmet-equivalent, no dependency).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  });

  // Request id + one-line access log. Secrets never reach the log.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = crypto.randomBytes(6).toString('hex');
    (req as Request & { id?: string }).id = id;
    res.setHeader('X-Request-Id', id);

    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      // Skip the pinger's noise so the log stays readable.
      if (req.path === '/healthz' || req.path === '/readyz') return;
      console.log(
        `[http] ${id} ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`,
      );
    });
    next();
  });

  // ---- public endpoints ---------------------------------------------------

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'awais-codex',
      version: 2,
      startedAt: new Date(status.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - status.startedAt) / 1000),
    });
  });

  app.get('/readyz', async (_req: Request, res: Response) => {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      await db.query('SELECT 1');
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${(err as Error).message}`;
      ready = false;
    }

    checks.poller = status.poller;
    checks.engine = config.geminiApiKey ? 'key present' : 'no key configured';

    res.status(ready ? 200 : 503).json({
      ok: ready,
      checks,
      migrationsApplied: status.migrationsApplied,
      orphanedRunsRecovered: status.orphanedRuns,
    });
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', clearedSessionCookie());
    res.json({ ok: true });
  });

  app.get('/api/auth/session', (req: Request, res: Response) => {
    // requireSession runs first, so reaching here means authenticated (or that
    // the deployment is in open mode, which the client is told about).
    res.json({
      authenticated: true,
      authMode: config.authMode,
      requestId: (req as Request & { id?: string }).id,
    });
  });

  // ---- authenticated API --------------------------------------------------

  app.use('/api', requireSession(config));

  app.get('/api/status', (_req: Request, res: Response) => {
    res.json({
      service: 'awais-codex',
      version: 2,
      startedAt: new Date(status.startedAt).toISOString(),
      migrationsApplied: status.migrationsApplied,
      poller: status.poller,
      engine: config.engineName,
      agent: config.antigravityAgent,
      authMode: config.authMode,
      activeRuns: deps.executor.activeCount,
      openStreams: deps.bus.channelCount,
      dailyRunBudget: config.dailyRunBudget,
      eventRetentionDays: config.eventRetentionDays,
      nodeEnv: config.nodeEnv,
    });
  });

  app.use('/api', createRunRoutes({ db, bus: deps.bus, executor: deps.executor, config }));

  // ---- fallthrough --------------------------------------------------------

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).type('text/plain').send(`Not found: ${req.method} ${req.path}`);
  });

  // Error handler: never leak stack traces to the client.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const id = (req as Request & { id?: string }).id ?? 'unknown';
    console.error(`[error] ${id} ${req.method} ${req.path}:`, err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', requestId: id });
  });

  return app;
}
