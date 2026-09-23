/**
 * The WhatsApp poll loop.
 *
 * One long poll per agent, forever, with a cursor that is only advanced after a
 * batch has been handled. The rules this file exists to keep:
 *
 *   NOTHING IS LOST
 *     A message is written to `wa_updates` before anything else happens, and
 *     marked read only after that. Marking read deletes it from the platform's
 *     buffer, so doing it first would mean a crash loses the task outright. The
 *     cursor moves only after the batch is handled, so a crash re-reads it —
 *     and the wamid primary key makes that replay harmless.
 *
 *   NOTHING IS DONE TWICE
 *     `wa_updates.wamid` is unique. A replayed offset, a restarted process and
 *     a reset cursor all converge on "already recorded" instead of a second
 *     task. When a run was started but the reply never went out, `run_id` is
 *     already set, so the retry resumes that run instead of starting another.
 *
 *   ONE POLLER
 *     A second poll for the same agent replaces the first (409). That is not
 *     retried into a storm: the loop backs off, reports the condition through
 *     /api/status, and keeps trying, because the usual cause is a stale local
 *     process that will go away.
 *
 *   POLLING IS NOT WORK
 *     The web app is the place to watch a task. This loop acknowledges, hands
 *     the run to a detached relay, and goes straight back to polling, so a
 *     ten-minute task never blocks the next message.
 */
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { EventBus } from '../events.js';
import type { RunExecutor } from '../executor.js';
import type { AcceptInput, AcceptResult } from '../accept.js';
import { remainingRuns } from '../accept.js';
import { TERMINAL_STATUSES, getActiveRun, getRun, type Run } from '../runs.js';
import { WhatsAppError, type InboundMessage, type Updates, type WhatsAppClient } from './api.js';
import { relayRun } from './relay.js';
import type { WhatsAppSender } from './sender.js';
import {
  getScheduledTask,
  listScheduledTasks,
  setTaskEnabled,
} from '../scheduler.js';
import {
  attachRun,
  countUnprocessed,
  latestWhatsappConversation,
  loadCursor,
  markProcessed,
  noteError,
  recordMessage,
  saveCreatorId,
  saveCursor,
} from './store.js';

export type PollerState = 'disabled' | 'running' | 'error';

export interface PollerHealth {
  state: PollerState;
  /**
   * Why polling is not happening, in words. `disabled` on its own cannot tell
   * "switched off on purpose" from "the key was deleted", and those need
   * different fixes.
   */
  detail?: string | null;
  agentId: string | null;
  offset: number | null;
  lastPollAt: string | null;
  lastError: string | null;
  /** Messages handled since boot, and replayed ones skipped. */
  handled: number;
  duplicates: number;
  receipts: number;
  /** Runs currently being watched for their answer. */
  watching: number;
}

export const DISABLED_HEALTH: PollerHealth = {
  state: 'disabled',
  agentId: null,
  offset: null,
  lastPollAt: null,
  lastError: null,
  handled: 0,
  duplicates: 0,
  receipts: 0,
  watching: 0,
};

export interface PollerDeps {
  db: Db;
  bus: EventBus;
  client: WhatsAppClient;
  sender: WhatsAppSender;
  executor: RunExecutor;
  config: AppConfig;
  /** Same acceptance path the web UI uses — one set of rules, two channels. */
  accept: (input: AcceptInput) => Promise<AcceptResult>;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  now?: () => number;
  /** Seconds to hold each poll open (platform max: 25). */
  pollTimeoutSeconds?: number;
  /**
   * Floor on the gap between two polls.
   *
   * A real long poll already takes 25 seconds, so this normally never applies.
   * It bites when the platform answers *instantly* — a 204 that comes straight
   * back, or a proxy closing the connection — and without it the loop would
   * hammer the endpoint at ~60 requests a minute against a documented cap of 15
   * and earn a 429 for its trouble. Four seconds keeps us comfortably under.
   */
  minPollIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Test hook: how long to wait after a 409 before polling again. */
  replacedBackoffMs?: number;
}

const HELP = [
  'Send me a task and I will run it on the agent.',
  '',
  '/status — what is running right now',
  '/cancel — stop the current task',
  '/new <task> — start a fresh sandbox, with no memory of before',
  '/schedules — list recurring scheduled tasks',
  '/schedule-off <id> — pause a scheduled task',
  '/schedule-on <id> — resume a scheduled task',
  '/help — this message',
].join('\n');

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function formatElapsed(startedAt: string, now: number): string {
  const ms = now - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** How long to wait after a failure, and whether it is worth shouting about. */
function planBackoff(err: unknown, attempt: number, min: number, max: number, replaced: number): number {
  if (err instanceof WhatsAppError) {
    switch (err.kind) {
      case 'poll_replaced':
        return replaced;
      case 'auth':
      case 'forbidden':
        // A bad token will not fix itself in seconds; a redeploy will.
        return 300_000;
      case 'rate_limited':
        return err.retryAfterMs ?? 5_000;
      case 'invalid':
      case 'not_found':
        return 60_000;
      default:
        break;
    }
  }
  return Math.min(min * 2 ** Math.min(attempt, 6), max);
}

export class WhatsAppPoller {
  private stopping = false;
  private running = false;
  private state: PollerState = 'disabled';
  private cursor: { agentId: string; offset: number } | null = null;
  private agentId: string | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private handled = 0;
  private duplicates = 0;
  private receipts = 0;
  private watching = 0;
  private abort = new AbortController();
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;
  private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.log = deps.log ?? ((message, level = 'info') => console.log(message));
    this.now = deps.now ?? Date.now;
  }

  get isRunning(): boolean {
    return this.running;
  }

  health(): PollerHealth {
    return {
      state: this.state,
      detail: null,
      agentId: this.agentId ?? this.cursor?.agentId ?? null,
      offset: this.cursor?.offset ?? null,
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      lastError: this.lastError,
      handled: this.handled,
      duplicates: this.duplicates,
      receipts: this.receipts,
      watching: this.watching,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.state = 'running';
    this.loopDone = this.loop();
    this.log('[wa] poller started');
  }

  /** Stop polling, aborting a long poll in flight rather than waiting it out. */
  async stop(timeoutMs = 5_000): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.abort.abort();
    this.wake?.();

    const done = this.loopDone;
    if (done) {
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    }
    this.running = false;
    this.state = 'disabled';
    this.log('[wa] poller stopped');
  }

  /**
   * Finish whatever the last process was doing when it died.
   *
   * Runs at boot, after orphans have been closed. A row whose `processed_at` is
   * still NULL is a message the user has not been told about yet: either its
   * run never started (handle it now, from the stored payload — the platform's
   * buffer may already have forgotten it), or it started and died with the
   * process (send the outcome).
   */
  async reconcile(): Promise<number> {
    const rows = await this.deps.db.query<{
      wamid: string;
      payload: InboundMessage;
      run_id: string | null;
    }>(
      `SELECT wamid, payload, run_id
         FROM wa_updates
        WHERE processed_at IS NULL
        ORDER BY received_at ASC
        LIMIT 25`,
    );

    for (const row of rows) {
      try {
        if (!row.run_id) {
          this.log(`[wa] resuming ${row.wamid} — it was recorded but never started`);
          await this.handleMessage(row.payload, { replay: true });
          continue;
        }

        const run = await getRun(this.deps.db, row.run_id);
        if (!run) {
          await markProcessed(this.deps.db, row.wamid, 'run vanished');
          continue;
        }
        if (TERMINAL_STATUSES.includes(run.status)) {
          this.log(`[wa] delivering the outcome of ${run.id} that died with the last process`);
          this.watch(run, row.wamid, row.payload.from);
          continue;
        }
        this.log(`[wa] still watching ${run.id}`);
        this.watch(run, row.wamid, row.payload.from);
      } catch (err) {
        this.log(`[wa] could not reconcile ${row.wamid}: ${(err as Error).message}`, 'error');
      }
    }
    return rows.length;
  }

  /** One poll. Throws on failure; the loop decides how long to wait. */
  async pollOnce(): Promise<'updates' | 'empty'> {
    if (!this.cursor) this.cursor = await loadCursor(this.deps.db);

    // A deployment with no stored cursor deliberately starts at the head: the
    // platform can replay 30 days of backlog, and answering all of it would
    // burn the day's quota on tasks the operator has long forgotten.
    const offset = this.cursor?.offset ?? null;

    const updates = await this.deps.client.getUpdates({
      offset,
      timeoutSeconds: this.deps.pollTimeoutSeconds ?? 25,
      signal: this.abort.signal,
    });
    this.lastPollAt = this.now();

    if (!updates) return 'empty'; // 204: no next_offset, so the same offset again

    this.applyAgent(updates);
    for (const status of updates.statuses) {
      this.receipts += 1;
      this.log(`[wa] receipt ${status.status} for ${status.id}`);
    }

    // Learn the creator's platform id from inbound traffic. The done-ping
    // needs it as the explicit `to` on a proactive send, and the platform
    // only accepts the `user:<id>` it gave us — never a phone number.
    if (this.cursor) {
      const from = updates.messages.find((m) => m.from)?.from;
      if (from) {
        await saveCreatorId(this.deps.db, this.cursor.agentId, from).catch(() => undefined);
      }
    }

    for (const message of updates.messages) {
      try {
        await this.handleMessage(message);
      } catch (err) {
        // One bad message must not stall the rest of the batch, and it must
        // not stop the cursor from advancing past messages that did work.
        this.log(`[wa] failed to handle ${message.id}: ${(err as Error).message}`, 'error');
        await noteError(this.deps.db, message.id, (err as Error).message).catch(() => undefined);
      }
    }

    // Advancing after the batch — never before — is what makes a crash re-read
    // instead of skip. Replays are free: the wamid primary key absorbs them.
    if (this.cursor) await saveCursor(this.deps.db, this.cursor.agentId, updates.nextOffset);
    this.cursor = this.cursor
      ? { agentId: this.cursor.agentId, offset: updates.nextOffset }
      : this.cursor;
    return 'updates';
  }

  private applyAgent(updates: Updates): void {
    if (!updates.agentId) return;
    const known = this.cursor?.agentId ?? this.agentId;
    if (known && known !== updates.agentId) {
      // A different agent behind the same token: its offsets are its own, so
      // start this one at its head rather than resuming a foreign sequence.
      this.log(`[wa] agent changed ${known} → ${updates.agentId}; starting at its head`, 'warn');
      this.cursor = { agentId: updates.agentId, offset: updates.nextOffset };
    } else if (this.cursor) {
      this.cursor = { agentId: updates.agentId, offset: this.cursor.offset };
    } else {
      this.cursor = { agentId: updates.agentId, offset: updates.nextOffset };
    }
    this.agentId = updates.agentId;
  }

  private async loop(): Promise<void> {
    const min = this.deps.minBackoffMs ?? 2_000;
    const max = this.deps.maxBackoffMs ?? 60_000;
    const replaced = this.deps.replacedBackoffMs ?? 60_000;

    const minInterval = this.deps.minPollIntervalMs ?? 4_000;

    while (!this.stopping) {
      try {
        const startedAt = this.now();
        await this.pollOnce();
        this.failures = 0;
        this.lastError = null;
        this.state = 'running';

        const elapsed = this.now() - startedAt;
        if (elapsed < minInterval) await this.sleep(minInterval - elapsed);
      } catch (err) {
        if (this.stopping || (err instanceof WhatsAppError && err.kind === 'aborted')) break;
        this.failures += 1;
        this.state = 'error';
        this.lastError = (err as Error).message;

        const wait = planBackoff(err, this.failures - 1, min, max, replaced);
        const kind = err instanceof WhatsAppError ? err.kind : 'unknown';
        const hint =
          kind === 'poll_replaced'
            ? ' — another poller is using this agent; is a second instance or a local run still up?'
            : '';
        this.log(`[wa] poll failed (${kind}): ${(err as Error).message}${hint}`, 'error');
        await this.sleep(wait);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // ---- handling -----------------------------------------------------------

  async handleMessage(message: InboundMessage, options: { replay?: boolean } = {}): Promise<void> {
    const recorded = await recordMessage(this.deps.db, message);

    if (!recorded.fresh) {
      this.duplicates += 1;
      if (recorded.processedAt) {
        this.log(`[wa] ignoring replayed ${message.id} — already handled`);
        return;
      }
      if (recorded.runId) {
        // A run exists for this message but the user was never told. reconcile()
        // owns this case; reaching it here means a duplicate in the same batch.
        this.log(`[wa] ${message.id} already has run ${recorded.runId}; not starting another`);
        return;
      }
      if (!options.replay) this.log(`[wa] recovering ${message.id} from an interrupted start`);
    }

    const text = (message.text ?? '').trim();
    const who = message.profileName ? ` from ${message.profileName}` : '';

    if (!text) {
      this.log(`[wa] inbound ${message.type}${who} is not text — asking for text`);
      await this.reply(
        message,
        `I can only take tasks as text right now — this one arrived as ${message.type}.`,
      );
      return;
    }

    this.log(`[wa] inbound text${who}: ${truncate(text, 160)}`);

    if (text.startsWith('/')) {
      await this.command(message, text);
      return;
    }

    await this.startTask(message, text, false);
  }

  private async command(message: InboundMessage, text: string): Promise<void> {
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rest.join(' ').trim();

    switch (command) {
      case '/help':
      case '/start':
        await this.reply(message, HELP);
        return;

      case '/new':
        if (!argument) {
          await this.reply(message, 'Give me the task after /new, like:\n/new build me a landing page');
          return;
        }
        await this.startTask(message, argument, true);
        return;

      case '/status':
        await this.status(message);
        return;

      case '/cancel':
        await this.cancel(message);
        return;

      case '/schedules':
        await this.schedules(message);
        return;

      case '/schedule-off':
      case '/schedule-on': {
        if (!argument) {
          await this.reply(message, `Give me the task id, like:\n${command} sch_abc123\n\nSee /schedules for the ids.`);
          return;
        }
        await this.scheduleToggle(message, argument, command === '/schedule-on');
        return;
      }

      default:
        await this.reply(message, `I do not know ${rawCommand}.\n\n${HELP}`);
    }
  }

  private async status(message: InboundMessage): Promise<void> {
    const active = await getActiveRun(this.deps.db);
    const left = await remainingRuns({ db: this.deps.db, executor: this.deps.executor, config: this.deps.config }, 'whatsapp');

    if (!active) {
      await this.reply(message, `Nothing is running.\n\nTasks left today: ${left}/${this.deps.config.dailyRunBudget}`);
      return;
    }

    await this.reply(
      message,
      [
        `"${truncate(active.prompt, 160)}"`,
        `Status: ${active.status} (${formatElapsed(active.startedAt, this.now())})`,
        `Tasks left today: ${left}/${this.deps.config.dailyRunBudget}`,
        '',
        'Send /cancel to stop it.',
      ].join('\n'),
    );
  }

  private async cancel(message: InboundMessage): Promise<void> {
    const active = await getActiveRun(this.deps.db);
    if (!active) {
      await this.reply(message, 'Nothing to cancel — no task is running.');
      return;
    }

    const signalled = this.deps.executor.cancel(active.id);
    if (!signalled) {
      // No executor attached: the process that owned it is gone. Close it here
      // so it stops blocking new tasks, and say so.
      const { setRunStatus } = await import('../runs.js');
      await setRunStatus(this.deps.db, active.id, 'cancelled', {
        errorType: 'orphaned',
        errorMessage: 'Cancelled from WhatsApp while no executor was attached',
      });
      await this.reply(message, `Stopped "${truncate(active.prompt, 100)}" — it was already orphaned.`);
      return;
    }
    await this.reply(message, `Stopping "${truncate(active.prompt, 100)}"…`);
  }

  private describeCadence(task: {
    cadence: string;
    intervalMinutes: number | null;
    timeOfDay: string | null;
    weekday: number | null;
  }): string {
    if (task.cadence === 'interval') return `every ${task.intervalMinutes} min`;
    const at = task.timeOfDay ?? '';
    if (task.cadence === 'daily') return `daily at ${at}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[task.weekday ?? 0]}s at ${at}`;
  }

  private async schedules(message: InboundMessage): Promise<void> {
    const tasks = await listScheduledTasks(this.deps.db);
    if (tasks.length === 0) {
      await this.reply(
        message,
        'No scheduled tasks. Create one in the web app — the Scheduled section of the drawer.',
      );
      return;
    }
    const lines = tasks.map(
      (t) =>
        `${t.enabled ? '●' : '○'} ${t.name} — ${this.describeCadence(t)} → ${t.deliver}\n  ${t.id}`,
    );
    await this.reply(message, `Scheduled tasks:\n\n${lines.join('\n\n')}`);
  }

  private async scheduleToggle(
    message: InboundMessage,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    const task = await getScheduledTask(this.deps.db, id);
    if (!task) {
      await this.reply(message, `No scheduled task with id ${id}. See /schedules for the ids.`);
      return;
    }
    await setTaskEnabled(this.deps.db, id, enabled);
    await this.reply(message, `"${task.name}" is now ${enabled ? 'on' : 'paused'}.`);
  }

  private async startTask(message: InboundMessage, prompt: string, fresh: boolean): Promise<void> {
    // One rolling thread per phone: a follow-up continues the previous sandbox,
    // so the agent still has the project open. `/new` opts out.
    const conversationId = fresh ? null : await latestWhatsappConversation(this.deps.db);
    const result = await this.deps.accept({ prompt, kind: 'whatsapp', fresh, conversationId });

    if (!result.ok && result.reason === 'in_progress') {
      await this.reply(
        message,
        `⏳ I am still on this one:\n"${truncate(result.active.prompt, 140)}"\n\nSend /status to check it, or /cancel to stop.`,
      );
      return;
    }

    if (!result.ok) {
      await this.reply(
        message,
        `🚫 ${result.message}\n\nTasks left today: ${Math.max(0, result.limit - result.used)}/${result.limit}\nResets at ${result.resetsAt}.`,
      );
      return;
    }

    // Bind the run to the message *before* the reply: if the process dies
    // between here and the acknowledgement, the retry finds the run and
    // resumes rather than starting a second task.
    await attachRun(this.deps.db, message.id, result.run.id);

    // Only now is it safe to mark read — the message is durable, a run exists
    // for it, and nothing depends on the platform's buffer any more.
    await this.deps.sender.markRead(message.id, { typing: true });

    const ack = fresh
      ? `🆕 On it — "${truncate(result.run.prompt, 140)}"\n\nFresh sandbox: this task starts with no memory of earlier ones. I will reply here when it is done.`
      : `On it — "${truncate(result.run.prompt, 140)}"\n\nI will reply here when it is done. (${result.remaining} tasks left today)`;
    // Deliberately not marked processed here: "done" means the user has been
    // told the *outcome*, and that only happens when the relay sends the
    // closing message. Marking it on the acknowledgement would quietly lose
    // every answer if the process died while the task was still running.
    await this.reply(message, ack, { markProcessed: false });

    // Detached on purpose: watching a long task must not block the next poll,
    // and the relay writes the closing message itself.
    this.watch(result.run, message.id, message.from);
  }

  /** Follow a run to its end and deliver the result, without blocking the loop. */
  private watch(run: Run, wamid: string, to: string): void {
    this.watching += 1;
    void relayRun({ db: this.deps.db, bus: this.deps.bus, send: this.deps.sender, to }, run)
      .then(async (result) => {
        if (result.outcome === 'detached') {
          // Still running; the next boot's reconcile picks it up if it dies.
          return;
        }
        await markProcessed(this.deps.db, wamid, result.outcome === 'failed' ? result.outcome : null);
        this.handled += 1;
      })
      .catch((err: unknown) => {
        this.log(`[wa] relay for ${run.id} failed: ${(err as Error).message}`, 'error');
      })
      .finally(() => {
        this.watching -= 1;
      });
  }

  private async reply(
    message: InboundMessage,
    text: string,
    options: { replyTo?: string | null; markProcessed?: boolean } = {},
  ): Promise<boolean> {
    const delivered = await this.deps.sender.send(text, {
      replyTo: options.replyTo === null ? null : message.id,
      // The platform requires an explicit `to` on every send — even on
      // replies. The inbound `from` is the `user:<id>` to send back to.
      to: message.from,
    });
    if (delivered && options.markProcessed !== false) {
      await markProcessed(this.deps.db, message.id, null);
    } else if (!delivered) {
      // Left unprocessed so the next boot tries again rather than going quiet.
      await noteError(this.deps.db, message.id, 'reply could not be delivered');
    }
    return delivered;
  }

  /** Diagnostics for the boot log. */
  async pending(): Promise<number> {
    return countUnprocessed(this.deps.db);
  }
}
