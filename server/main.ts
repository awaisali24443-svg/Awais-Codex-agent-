/**
 * Server entry point.
 *
 * Boot order matters: validate config, connect to Postgres, apply migrations,
 * prune, recover orphans, then listen. On Render's free tier there is no shell
 * and no one-off jobs, so schema setup must happen here on every boot.
 */
import { loadConfig, type AppConfig } from './config.js';
import { createDb, markOrphanedRuns, pruneRunEvents, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createApp } from './app.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';
import type { Engine } from './engine/types.js';

/**
 * Pick the engine. Failing loudly here is deliberate: silently falling back to
 * the scripted engine in production would look like the agent working while
 * nothing real ever ran.
 */
function createEngine(config: AppConfig): Engine {
  if (config.engineName === 'antigravity') {
    throw new Error(
      'ENGINE=antigravity is not implemented yet — the Antigravity client arrives in the next phase. ' +
        'Leave ENGINE unset (or ENGINE=scripted) until then.',
    );
  }
  return new ScriptedEngine();
}

async function boot(): Promise<void> {
  const startedAt = Date.now();
  const config: AppConfig = loadConfig();

  console.log('[boot] Awais Codex v2');
  console.log(`[boot] env=${config.nodeEnv} port=${config.port} budget=${config.dailyRunBudget}/day`);

  const db: Db = await createDb(config.databaseUrl);
  console.log(`[boot] database: ${db.dialect === 'pg' ? 'Postgres' : 'PGlite (dev/test)'}`);

  const migration = await migrate(db);
  console.log(`[boot] migrations: ${migration.applied.length} applied, ${migration.skipped.length} present`);

  const pruned = await pruneRunEvents(db, config.eventRetentionDays);
  if (pruned > 0) console.log(`[boot] pruned ${pruned} run event(s) older than ${config.eventRetentionDays}d`);

  // Every in-flight run at boot is orphaned by definition: the process that
  // owned it is gone, and a mission cannot be resumed from a different process.
  // The age window is set to zero so a run left behind seconds ago does not
  // block new missions for the next hour.
  const orphaned = await markOrphanedRuns(db, 0);
  if (orphaned > 0) console.log(`[boot] recovered ${orphaned} orphaned run(s)`);

  // The poller is deliberately not started here yet: it arrives with the
  // WhatsApp platform adapter. The flag is validated now so a misconfigured
  // deployment fails at boot rather than silently spinning.
  const poller: 'disabled' | 'running' | 'error' =
    config.pollerEnabled && config.whatsappToken ? 'running' : 'disabled';
  if (config.pollerEnabled && !config.whatsappToken) {
    // loadConfig already rejects this, but keep the runtime honest.
    throw new Error('POLLER_ENABLED is set without WHATSAPP_TOKEN');
  }

  const bus = new EventBus();
  const executor = new RunExecutor({ db, bus, engine: createEngine(config) });
  console.log(`[boot] engine: ${config.engineName}`);

  const app = createApp({
    config,
    db,
    bus,
    executor,
    status: { startedAt, migrationsApplied: migration.applied.length, orphanedRuns: orphaned, poller },
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] listening on http://0.0.0.0:${config.port}`);
    console.log(`[boot] health: /healthz   readiness: /readyz   poller: ${poller}`);
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
