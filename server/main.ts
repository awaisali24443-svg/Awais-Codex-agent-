/**
 * Server entry point.
 *
 * Boot order matters: validate config, connect to Postgres, apply migrations,
 * prune, recover orphans, then listen. On Render's free tier there is no shell
 * and no one-off jobs, so schema setup must happen here on every boot.
 */
import { loadConfig, type AppConfig } from './config.js';
import { DISABLED_HEALTH } from './whatsapp/poller.js';
import { createDb, markOrphanedRuns, pruneRunEvents, type Db } from './db.js';
import { pruneArtifacts } from './artifacts.js';
import { migrate } from './migrate.js';
import { createApp } from './app.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';
import { AntigravityEngine } from './engine/antigravity.js';
import type { Engine } from './engine/types.js';
import { acceptRun } from './accept.js';
import { WhatsAppClient } from './whatsapp/api.js';
import { WhatsAppPoller } from './whatsapp/poller.js';
import { WhatsAppSender } from './whatsapp/sender.js';

/**
 * Pick the engine.
 *
 * There is no silent fallback in either direction: the operator always knows
 * which one is running, because the difference between them is the difference
 * between a real agent and a convincing demo.
 */
function createEngine(config: AppConfig): Engine {
  if (config.engineName === 'scripted') {
    console.warn('[boot] ENGINE=scripted — missions will not reach the real agent');
    return new ScriptedEngine();
  }

  console.log(`[boot] agent: ${config.antigravityAgent}`);
  if (config.antigravityMaxTokens > 0) {
    console.log(`[boot] token ceiling per interaction: ${config.antigravityMaxTokens}`);
  }
  return new AntigravityEngine({
    apiKey: config.geminiApiKey,
    agent: config.antigravityAgent,
    apiBase: config.antigravityApiBase || undefined,
    maxTotalTokens: config.antigravityMaxTokens || undefined,
  });
}

async function boot(): Promise<void> {
  const startedAt = Date.now();
  const config: AppConfig = loadConfig();

  console.log('[boot] Awais Codex v2');
  // Only the public case deserves a banner. A development box with no access
  // key is open too, but nobody deployed it to the internet by accident, and
  // config.ts has already said so once.
  if (config.authMode === 'open' && config.isProduction) {
    console.warn('[boot] **********************************************************');
    console.warn('[boot] AUTH_MODE=open — this deployment is PUBLIC.');
    console.warn('[boot] Anyone with the URL can run missions on your quota.');
    console.warn('[boot] **********************************************************');
  }
  console.log(`[boot] env=${config.nodeEnv} port=${config.port} budget=${config.dailyRunBudget}/day`);

  const db: Db = await createDb(config.databaseUrl);
  console.log(`[boot] database: ${db.dialect === 'pg' ? 'Postgres' : 'PGlite (dev/test)'}`);

  const migration = await migrate(db);
  console.log(`[boot] migrations: ${migration.applied.length} applied, ${migration.skipped.length} present`);

  const pruned = await pruneRunEvents(db, config.eventRetentionDays);
  if (pruned > 0) console.log(`[boot] pruned ${pruned} run event(s) older than ${config.eventRetentionDays}d`);

  // Artifact files live on the ephemeral disk, so this is hygiene rather than
  // storage management — but a disk that fills up takes the service with it.
  const prunedArtifacts = await pruneArtifacts(db, config.artifactRetentionDays);
  if (prunedArtifacts > 0) {
    console.log(`[boot] pruned ${prunedArtifacts} artifact(s) older than ${config.artifactRetentionDays}d`);
  }

  // Every in-flight run at boot is orphaned by definition: the process that
  // owned it is gone, and a mission cannot be resumed from a different process.
  // The age window is set to zero so a run left behind seconds ago does not
  // block new missions for the next hour.
  const orphaned = await markOrphanedRuns(db, 0);
  if (orphaned > 0) console.log(`[boot] recovered ${orphaned} orphaned run(s)`);

  const bus = new EventBus();
  const executor = new RunExecutor({ db, bus, engine: createEngine(config) });
  console.log(`[boot] engine: ${config.engineName}`);

  // ---- WhatsApp -----------------------------------------------------------
  // One long-poll loop talks to the phone; the same acceptance path the web UI
  // uses decides whether a task may run. The flag was already validated above
  // so a misconfigured deployment fails here, at boot, rather than at 3am.
  let poller: WhatsAppPoller | null = null;
  if (config.pollerEnabled && config.whatsappToken) {
    const client = new WhatsAppClient({
      token: config.whatsappToken,
      baseUrl: config.whatsappApiBase || undefined,
    });
    poller = new WhatsAppPoller({
      db,
      bus,
      client,
      executor,
      config,
      sender: new WhatsAppSender(client, (message, level) =>
        level === 'error' ? console.error(`[wa] ${message}`) : console.log(`[wa] ${message}`),
      ),
      accept: (input) => acceptRun({ db, executor, config }, input),
      log: (message, level) =>
        level === 'error' ? console.error(message) : console.log(message),
    });
  } else if (config.pollerEnabled) {
    throw new Error('POLLER_ENABLED is set without WHATSAPP_TOKEN');
  }

  const app = createApp({
    config,
    db,
    bus,
    executor,
    status: {
      startedAt,
      migrationsApplied: migration.applied.length,
      orphanedRuns: orphaned,
      poller: () => poller?.health() ?? DISABLED_HEALTH,
    },
  });

  if (poller) {
    try {
      const resumed = await poller.reconcile();
      if (resumed > 0) console.log(`[boot] whatsapp: resumed ${resumed} unfinished message(s)`);
    } catch (err) {
      // A broken reconcile must not stop the server: the web app still works,
      // and the rows stay queued for the next boot.
      console.error('[boot] whatsapp reconcile failed:', (err as Error).message);
    }
    poller.start();
  }

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] listening on http://0.0.0.0:${config.port}`);
    console.log(`[boot] health: /healthz   readiness: /readyz   poller: ${poller ? 'running' : 'disabled'}`);
    if (config.authMode === 'open') {
      console.log('[boot] access: open — no key needed (set ACCESS_KEY to require one)');
    } else {
      console.log('[boot] access: your saved ?k=... link, or the x-access-key header');
      // APP_URL is only useful for exactly this, so keep it honest: a real,
      // clickable link rather than a description of where to find one.
      if (config.appUrl) {
        console.log(`[boot] your link: ${config.appUrl.replace(/\/+$/, '')}/?k=<ACCESS_KEY>`);
      }
    }
    if (!config.geminiApiKey) {
      console.warn('[boot] GEMINI_API_KEY is not set — agent runs will be refused until configured');
    }
  });

  // Graceful shutdown: stop accepting, drain, close the pool. A clean exit is
  // what lets the WhatsApp poll cursor and in-flight run state stay consistent.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining`);

    server.close(() => console.log('[shutdown] http server closed'));

    // Stop the long poll first: it holds a request open for up to 25 seconds,
    // and a message arriving during shutdown belongs to the next boot's
    // reconcile rather than to a half-dead process.
    if (poller) await poller.stop();

    // Abort runs before closing the pool. Each cancellation writes a terminal
    // event, which also lets its SSE stream end on its own — otherwise those
    // connections would hold the server open until Render's kill timer fires,
    // and the last thing a mission produced would be lost.
    await executor.shutdown();

    // Give the terminal frames a moment to leave the socket, then stop waiting
    // on anything still connected (EventSource clients reconnect on their own).
    await new Promise((resolve) => setTimeout(resolve, 250));
    server.closeAllConnections?.();

    try {
      await db.close();
      console.log('[shutdown] database pool closed');
    } catch (err) {
      console.error('[shutdown] error closing database:', (err as Error).message);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection:', reason);
  });
}

boot().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[boot] failed:', message);
  process.exit(1);
});
