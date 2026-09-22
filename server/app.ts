/**
 * Express application factory.
 *
 * Exported separately from the listen call so tests can drive it without
 * binding a port. Routes are thin: parse, validate, delegate, respond.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';

import type { AppConfig } from './config.js';
import { findDir } from './paths.js';
import type { Db } from './db.js';
import type { EventBus } from './events.js';
import type { RunExecutor } from './executor.js';
import { DISABLED_HEALTH, type PollerHealth } from './whatsapp/poller.js';
import { createRunRoutes } from './routes/runs.js';
import { createMemoryRoutes } from './routes/memory.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { createSettingsRoutes } from './routes/settings.js';
import type { SecretsStore, SettingsStore } from './settings.js';
import {
  checkAccessKey,
  claimAccessKey,
  clearedSessionCookie,
  createSession,
  requireSession,
  sessionCookie,
} from './auth.js';
import path from 'node:path';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  /** In-process event fan-out for the live stream. */
  bus: EventBus;
  /** Owns the lifecycle of in-flight runs. */
  executor: RunExecutor;
  /**
   * Live settings and credentials. Read at request time, never captured: the
   * whole point of the store is that a change applies without a restart.
   */
  settings: SettingsStore;
  secrets: SecretsStore;
  /**
   * Called after a credential is stored or removed, so whatever consumes it can
   * react — for the WhatsApp token, that means starting or stopping the poller
   * rather than waiting for a restart. Failures here must not fail the save.
   */
  onCredentialChanged?: (name: string) => Promise<void> | void;
  /** Runtime status, filled in by the boot sequence. */
  status: {
    startedAt: number;
    migrationsApplied: number;
    orphanedRuns: number;
    /**
     * Read at request time, not captured at boot: whether the WhatsApp poller
     * is healthy is exactly the thing an operator checks when messages stop
     * being answered, so a value frozen at startup would be worse than useless.
     */
    poller?: () => PollerHealth;
  };
}

export function createApp(deps: AppDeps): Express {
  const { config, db, status } = deps;
  const pollerHealth = (): PollerHealth => status.poller?.() ?? DISABLED_HEALTH;
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

    checks.poller = pollerHealth().state;
    // The stored key counts: readiness should answer "can a mission run", not
    // "did the environment happen to contain a key at boot".
    const apiKey = deps.secrets.get('gemini_api_key');
    checks.engine =
      config.engineName === 'scripted'
        ? 'scripted (no key needed)'
        : apiKey
          ? `key present (${deps.secrets.source('gemini_api_key')})`
          : 'no key configured';

    res.status(ready ? 200 : 503).json({
      ok: ready,
      checks,
      migrationsApplied: status.migrationsApplied,
      orphanedRunsRecovered: status.orphanedRuns,
    });
  });

  // The sign-in screen. Same secret as the ?k= link — one key, three ways to
  // present it (form, link, header) — so there is only ever one thing to
  // rotate or get wrong.
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const provided = (req.body as { key?: unknown; password?: unknown } | undefined);
    const value = provided?.key ?? provided?.password;

    if (!checkAccessKey(value, config.accessKey)) {
      console.warn('[auth] a sign-in attempt used the wrong key');
      res.status(401).json({ error: 'invalid_key', message: 'That key is not right.' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(createSession(config.sessionSecret), config.isProduction));
    res.json({ ok: true });
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
      poller: pollerHealth(),
      engine: config.engineName,
      agent: config.antigravityAgent,
      authMode: config.authMode,
      activeRuns: deps.executor.activeCount,
      openStreams: deps.bus.channelCount,
      dailyRunBudget: config.dailyRunBudget,
      eventRetentionDays: config.eventRetentionDays,
      nodeEnv: config.nodeEnv,
      // Whether a WhatsApp key is configured at all. The PWA uses this to
      // decide whether to offer the "done" ping — a send needs no poller, so
      // the poller state is the wrong signal.
      whatsappConfigured: deps.secrets.get('whatsapp_token') !== '',
    });
  });

  app.use('/api', createRunRoutes({ db, bus: deps.bus, executor: deps.executor, config }));
  app.use('/api', createMemoryRoutes({ db }));
  app.use('/api', createArtifactRoutes({ db, config }));
  app.use(
    '/api',
    createSettingsRoutes({
      settings: deps.settings,
      secrets: deps.secrets,
      pollerHealth,
      onCredentialChanged: deps.onCredentialChanged,
    }),
  );

  // ---- the app itself -----------------------------------------------------

  const webRoot = locateWebRoot();
  if (webRoot) {
    app.use(
      express.static(webRoot, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          // The service worker must never be cached, or an update can be
          // pinned for a year by a CDN or by the browser itself. The scope
          // header lets /sw.js control the whole origin.
          if (filePath.endsWith('sw.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Service-Worker-Allowed', '/');
            return;
          }
          if (filePath.endsWith('manifest.json')) {
            res.setHeader('Content-Type', 'application/manifest+json');
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    // Any other GET is the single-page app. /api is excluded so a typo in an
    // endpoint still returns JSON rather than a page of HTML.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api') || req.path === '/healthz' || req.path === '/readyz') {
        return next();
      }
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

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

/**
 * Find the UI directory.
 *
 * Two layouts to satisfy: `tsx server/main.ts` runs from the repo root with
 * `web/` next to it, while the bundled `dist/server.cjs` runs from `dist/`.
 * Both are checked rather than assuming one, because guessing wrong produces a
 * blank page and no obvious error.
 */
function locateWebRoot(): string | null {
  return findDir(['web'], 'index.html');
}
