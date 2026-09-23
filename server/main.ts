/**
 * Server entry point.
 *
 * Boot order matters: validate config, connect to Postgres, apply migrations,
 * prune, recover orphans, then listen. On Render's free tier there is no shell
 * and no one-off jobs, so schema setup must happen here on every boot.
 */
import { loadConfig, type AppConfig } from './config.js';
import { createDb, pruneRunEvents, type Db } from './db.js';
import { pruneArtifacts } from './artifacts.js';
import { createStores, type SecretsStore } from './settings.js';
import { migrate } from './migrate.js';
import { createApp } from './app.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';
import { AntigravityEngine } from './engine/antigravity.js';
import type { Engine } from './engine/types.js';
import { acceptRun } from './accept.js';
import { WhatsAppService } from './whatsapp/lifecycle.js';
import { sendDonePing } from './whatsapp/doneping.js';
import { claimDueReminders, markReminderFired, releaseReminder } from './reminders.js';
import { fireDueScheduledTasks, nextDaily } from './scheduler.js';
import { recoverOrphanedRuns } from './recovery.js';
import {
  DIGEST_TIME,
  DIGEST_TIMEZONE,
  maybeSendMorningDigest,
} from './whatsapp/morningdigest.js';
import { maybeSendBreakageAlerts } from './whatsapp/alerts.js';

/**
 * Pick the engine.
 *
 * There is no silent fallback in either direction: the operator always knows
 * which one is running, because the difference between them is the difference
 * between a real agent and a convincing demo.
 */
function createEngine(config: AppConfig, secrets: SecretsStore): Engine {
  if (config.engineName === 'scripted') {
    console.warn('[boot] ENGINE=scripted — missions will not reach the real agent');
    return new ScriptedEngine();
  }

  console.log(`[boot] agent: ${config.antigravityAgent}`);
  if (config.antigravityMaxTokens > 0) {
    console.log(`[boot] token ceiling per interaction: ${config.antigravityMaxTokens}`);
  }
  return new AntigravityEngine({
    // Deferred on purpose: both values are resolved per request, so a key
    // stored in Settings or a newer agent id takes effect without a restart.
    apiKey: () => secrets.get('gemini_api_key'),
    agent: () => config.antigravityAgent,
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

  // Crash-resume happens after the executor exists, because the newest
  // orphan with finished checkpoints is restarted, not failed. 'paused'
  // runs are left alone — pausing was a decision, not a crash.
  let orphaned = 0;

  // ---- settings & secrets ------------------------------------------------
  // Loaded after migrations (the tables must exist) and before anything reads
  // a credential or a limit, so `config` is fully overridden by the time the
  // app, the executor and the poller see it.
  const { settings, secrets } = createStores(db, config);
  const settingsLoaded = await settings.load();
  if (settingsLoaded.applied > 0) {
    console.log(`[boot] settings: ${settingsLoaded.applied} override(s) applied from the database`);
  }
  if (settingsLoaded.rejected.length > 0) {
    console.warn(`[boot] settings: ignoring invalid row(s): ${settingsLoaded.rejected.join(', ')}`);
  }

  const secretsLoaded = await secrets.load();
  if (secretsLoaded.loaded > 0) {
    console.log(
      `[boot] secrets: ${secretsLoaded.loaded} loaded from the encrypted store ` +
        `(${secretsLoaded.loaded === 1 ? '1 credential' : 'credentials'})`,
    );
  }
  if (!secrets.encryptionAvailable && config.isProduction) {
    // config.ts already refuses a production boot without MASTER_KEY; this is
    // the belt-and-braces case where the key exists but is unusable.
    console.warn('[boot] MASTER_KEY is not usable — stored credentials are unavailable');
  }

  const bus = new EventBus();
  const executor = new RunExecutor({
    db,
    bus,
    engine: createEngine(config, secrets),
    // Google reads: sealed token + client credentials for the executor's
    // read-request loop. Absent in tests, where the capability stays off.
    masterKey: config.masterKey,
    secrets,
    // The WhatsApp "done" ping for web-started runs. Fire-and-forget: the
    // module never throws, and the executor guards the hook anyway.
    onTerminal: (run, outcome) => {
      void sendDonePing({ db, secrets }, run, outcome);
    },
  });
  console.log(`[boot] engine: ${config.engineName}`);

  const recovery = await recoverOrphanedRuns(db, executor);
  orphaned = recovery.resumed + recovery.failed;
  if (orphaned > 0) {
    console.log(
      `[boot] orphans: ${recovery.resumed} resumed, ${recovery.failed} marked interrupted`,
    );
  }

  // ---- WhatsApp -----------------------------------------------------------
  // Polling is driven by the credential, not by a variable: the service starts
  // the loop when a token exists and stops it when one is removed, so pasting
  // the agent's API key WhatsApp generated is the entire setup.
  const whatsapp = new WhatsAppService({
    db,
    bus,
    executor,
    config,
    secrets,
    accept: (input) => acceptRun({ db, executor, config }, input),
  });

  const app = createApp({
    config,
    db,
    bus,
    executor,
    settings,
    secrets,
    // A stored credential must take effect on the connection that uses it —
    // that is the difference between a settings screen and a settings file.
    onCredentialChanged: async () => {
      await whatsapp.sync('credential changed');
    },
    status: {
      startedAt,
      migrationsApplied: migration.applied.length,
      orphanedRuns: orphaned,
      poller: () => whatsapp.health(),
    },
  });

  const whatsappSync = await whatsapp.sync('boot');
  if (whatsappSync === 'unchanged' && !whatsapp.health().detail && !whatsapp.running) {
    // Nothing to say: either polling is on, or it is off on purpose.
  } else if (!whatsapp.running) {
    console.log(`[boot] whatsapp: ${whatsapp.health().detail}`);
  }

  // ---- reminders ----------------------------------------------------------
  // Opt-in twice over: the table and the API exist regardless, but the loop
  // that turns a due reminder into a run only exists with REMINDERS_ENABLED.
  // A firing reminder spends one daily run through the normal acceptance path,
  // so an in-flight task or a spent budget just defers it to the next tick.
  if (config.remindersEnabled) {
    const fireDue = async (): Promise<void> => {
      try {
        const due = await claimDueReminders(db);
        for (const reminder of due) {
          const result = await acceptRun(
            { db, executor, config },
            { prompt: `Reminder: ${reminder.text}`, kind: 'api' },
          );
          if (result.ok) {
            await markReminderFired(db, reminder.id, result.run.id);
            console.log(`[reminders] fired ${reminder.id} as ${result.run.id}`);
          } else {
            await releaseReminder(db, reminder.id);
            console.log(
              `[reminders] deferred ${reminder.id} (${result.reason}); retrying next tick`,
            );
          }
        }
      } catch (err) {
        console.error('[reminders] tick failed:', (err as Error).message);
      }
    };
    const timer = setInterval(() => void fireDue(), 60_000);
    timer.unref?.();
    void fireDue();
    console.log('[boot] reminders: scheduler on (60s tick)');
  } else {
    console.log('[boot] reminders: scheduler off — set REMINDERS_ENABLED=true to fire reminders');
  }

  // ---- scheduled tasks ------------------------------------------------------
  // Recurring jobs. Each fire goes through the normal acceptance path (one run
  // at a time, daily budget), so a busy agent or a spent budget defers the
  // task to the next tick instead of dropping it. Overnight firing relies on
  // the self-ping below keeping the process awake on the free tier.
  if (config.schedulerEnabled) {
    const tickScheduled = (): Promise<void> =>
      fireDueScheduledTasks({ db, executor, config }, (m) => console.log(m)).then(() => {});
    const scheduledTimer = setInterval(() => void tickScheduled(), 60_000);
    scheduledTimer.unref?.();
    void tickScheduled();
    console.log('[boot] scheduler: on (60s tick)');
  } else {
    console.log('[boot] scheduler: off — set SCHEDULER_ENABLED=true to fire scheduled tasks');
  }

  // ---- morning digest -------------------------------------------------------
  // One WhatsApp message at 07:30 Asia/Karachi: what ran overnight, what
  // failed, what is waiting. A direct send, never a run — it costs zero of
  // the daily task budget. Silent until the WhatsApp token is connected.
  // The tick lives in this process like every other scheduler: the one-poller
  // rule means no second process may own the timing.
  if (config.morningDigestEnabled) {
    let nextDigestAt = nextDaily(new Date(), DIGEST_TIME, DIGEST_TIMEZONE);
    const tickDigest = async (): Promise<void> => {
      try {
        if (new Date() < nextDigestAt) return;
        await maybeSendMorningDigest({ db, secrets, config });
        nextDigestAt = nextDaily(new Date(), DIGEST_TIME, DIGEST_TIMEZONE);
      } catch (err) {
        // The digest never takes anything else down with it.
        console.error('[digest] tick failed:', (err as Error).message);
      }
    };
    const digestTimer = setInterval(() => void tickDigest(), 60_000);
    digestTimer.unref?.();
    void tickDigest();
    console.log('[boot] morning digest: on (daily 07:30 Asia/Karachi)');
  } else {
    console.log('[boot] morning digest: off — set MORNING_DIGEST=true to get the 07:30 summary');
  }

  // ---- breakage alerts ------------------------------------------------------
  // A WhatsApp message the moment something important breaks: the poller dies
  // or stops unexpectedly, the engine API key is rejected, or the day's task
  // budget is spent. One message per incident per day, a direct send, never a
  // run — it costs zero of the daily task budget. Silent until the WhatsApp
  // token is connected. The tick lives in this process like every other
  // scheduler: the one-poller rule means no second process may own the
  // timing.
  if (config.breakageAlertsEnabled) {
    const tickAlerts = async (): Promise<void> => {
      try {
        await maybeSendBreakageAlerts({ db, config, secrets, whatsapp });
      } catch (err) {
        // The alert never takes anything else down with it.
        console.error('[alerts] tick failed:', (err as Error).message);
      }
    };
    const alertsTimer = setInterval(() => void tickAlerts(), 60_000);
    alertsTimer.unref?.();
    void tickAlerts();
    console.log('[boot] breakage alerts: on (60s tick)');
  } else {
    console.log('[boot] breakage alerts: off — set BREAKAGE_ALERTS=true to get WhatsApp breakage alerts');
  }

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] listening on http://0.0.0.0:${config.port}`);
    console.log(
      `[boot] health: /healthz   readiness: /readyz   poller: ${
        whatsapp.isPolling ? 'running' : 'stopped'
      }`,
    );
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
    if (config.engineName === 'antigravity') {
      const keySource = secrets.source('gemini_api_key');
      if (keySource === 'missing') {
        console.warn(
          '[boot] no API key — agent runs will be refused until one is set in the ' +
            'environment or in Settings',
        );
      }
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
    await whatsapp.shutdown();

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
