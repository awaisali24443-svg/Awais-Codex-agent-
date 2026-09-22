/**
 * Run → phone.
 *
 * A task sent from WhatsApp is answered in the same chat: one "on it"
 * acknowledgement, optionally one progress line if the work is slow, then the
 * answer. The answer is read from Postgres rather than from memory, because the
 * terminal event is written before the status flips — so observing a terminal
 * status proves the whole output is already readable. That is also what makes
 * this safe across the case that matters on a free tier: the agent working for
 * ten minutes while nothing is watching.
 *
 * The relay never throws. A WhatsApp failure must not affect the run, and the
 * run is the thing that cannot be recreated.
 */
import type { Db } from '../db.js';
import type { EventBus, StreamEvent } from '../events.js';
import { TERMINAL_STATUSES, getRun, readEvents } from '../runs.js';
import type { Run } from '../runs.js';
import type { WhatsAppSender } from './sender.js';
import { toWhatsAppText } from './format.js';

export interface RelayDeps {
  db: Db;
  bus: EventBus;
  send: WhatsAppSender;
  /** Send one "still working" line if the run is slower than this. */
  progressAfterMs?: number;
  /** Give up watching after this long; the run itself continues. */
  maxWaitMs?: number;
  now?: () => number;
}

export type RelayOutcome = 'completed' | 'failed' | 'cancelled' | 'detached';

export interface RelayResult {
  outcome: RelayOutcome;
  text: string;
}

const DEFAULT_PROGRESS_AFTER_MS = 90_000;
const DEFAULT_MAX_WAIT_MS = 45 * 60_000;

/** The last persisted full-text snapshot; the durable answer for a run. */
export async function finalTextOf(db: Db, runId: string): Promise<string> {
  const rows = await db.query<{ text: string | null }>(
    `SELECT payload->>'text' AS text
       FROM run_events
      WHERE run_id = $1 AND type = 'text.snapshot'
      ORDER BY seq DESC
      LIMIT 1`,
    [runId],
  );
  return rows[0]?.text ?? '';
}

/** Human-readable progress from the durable log, for the "still working" line. */
function milestoneFrom(event: StreamEvent): string | null {
  if (event.type === 'tool.call') {
    const name = String(event.payload.name ?? '').trim();
    return name ? `running \`${name}\`` : null;
  }
  if (event.type === 'log') {
    const message = String(event.payload.message ?? '').trim();
    return message ? message.slice(0, 160) : null;
  }
  return null;
}

function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Compose the closing message for a terminal run.
 *
 * The agent answers in Markdown and WhatsApp does not speak it, so the answer
 * is converted on the way out (`format.ts`). Our own prefixes are plain text
 * and deliberately pass through untouched — converting them would be a no-op at
 * best and a mangled emoji-laden line at worst.
 */
export function closingMessage(
  outcome: RelayOutcome,
  text: string,
  errorMessage: string | null,
): string {
  const body = toWhatsAppText(text);
  switch (outcome) {
    case 'completed':
      // A mission can legitimately produce no prose (it built something and
      // said nothing), and an empty bubble is worse than saying so.
      return body || '✅ Done — the agent finished without a written answer.';
    case 'cancelled':
      return body ? `🛑 Cancelled. Partial answer:\n\n${body}` : '🛑 Cancelled.';
    case 'failed':
      return body
        ? `❌ Failed${errorMessage ? `: ${errorMessage}` : ''}\n\nPartial answer:\n\n${body}`
        : `❌ Failed${errorMessage ? `: ${errorMessage}` : ''}`;
    default:
      return body;
  }
}

/**
 * Follow a run to its end and send the result.
 *
 * Called after the run exists, so the common case — a run that finishes in
 * milliseconds — is handled by the same code path as a slow one.
 */
export async function relayRun(deps: RelayDeps, run: Run): Promise<RelayResult> {
  const progressAfterMs = deps.progressAfterMs ?? DEFAULT_PROGRESS_AFTER_MS;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const current = (await getRun(deps.db, run.id)) ?? run;

  if (TERMINAL_STATUSES.includes(current.status)) {
    const text = await finalTextOf(deps.db, run.id);
    const outcome = current.status as RelayOutcome;
    await deps.send.send(closingMessage(outcome, text, current.errorMessage));
    await reportError(deps, current);
    return { outcome, text };
  }

  let latest = (await finalTextOf(deps.db, run.id)) || '';
  let milestone: string | null = null;

  return await new Promise<RelayResult>((resolve) => {
    let settled = false;
    let progressSent = false;
    const startedAt = (deps.now ?? Date.now)();

    const finish = async (outcome: RelayOutcome): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(progressTimer);
      clearTimeout(waitTimer);
      unsubscribe();

      const text = (await finalTextOf(deps.db, run.id)) || latest;
      const finished = await getRun(deps.db, run.id);
      await deps.send.send(closingMessage(outcome, text, finished?.errorMessage ?? null));
      await reportError(deps, finished);
      resolve({ outcome, text });
    };

    const unsubscribe = deps.bus.subscribe(run.id, (event) => {
      if (settled) return;

      if (event.type === 'text.snapshot' && typeof event.payload.text === 'string') {
        latest = event.payload.text;
        return;
      }
      const next = milestoneFrom(event);
      if (next) milestone = next;

      if (event.type === 'run.completed') void finish('completed');
      else if (event.type === 'run.cancelled') void finish('cancelled');
      else if (event.type === 'run.failed') void finish('failed');
    });

    const progressTimer = setTimeout(() => {
      if (settled || progressSent) return;
      progressSent = true;
      const waited = elapsed((deps.now ?? Date.now)() - startedAt);
      const detail = milestone ? ` — ${milestone}` : '';
      void deps.send.send(`⏳ Still working (${waited})${detail}.`, { previewUrl: false });
    }, progressAfterMs);
    progressTimer.unref?.();

    // A run that outlives this is not lost: it keeps going, it is in the
    // database, and the web UI still shows it. Watching forever would leak a
    // subscriber per stuck run.
    const waitTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(progressTimer);
      unsubscribe();
      console.warn(`[wa] stopped watching ${run.id} after ${elapsed(maxWaitMs)}; the run continues`);
      resolve({ outcome: 'detached', text: latest });
    }, maxWaitMs);
    waitTimer.unref?.();

    // A run cancelled between the status check and the subscribe would never
    // publish again, so re-check once the listener is attached.
    void getRun(deps.db, run.id).then((fresh) => {
      if (fresh && TERMINAL_STATUSES.includes(fresh.status)) void finish(fresh.status as RelayOutcome);
    });
  });
}

/** Tell the phone when a run ended because of something worth fixing. */
async function reportError(deps: RelayDeps, run: Run | null): Promise<void> {
  if (!run || run.status !== 'failed') return;
  const type = run.errorType ?? '';
  const notes: Record<string, string> = {
    quota_exceeded: 'The engine reports the daily quota is spent. Try again after the reset.',
    auth_failed: 'The engine key was rejected — check GEMINI_API_KEY on the server.',
    agent_unavailable: 'The configured agent id is not available to this key.',
    budget_exceeded: 'The daily task budget for today is used up.',
  };
  const note = notes[type];
  if (note) await deps.send.send(`ℹ️ ${note}`);
}

/** Events of a finished run, for the admin/debug path. */
export async function runTranscript(db: Db, runId: string, limit = 500): Promise<string> {
  const events = await readEvents(db, runId, 0, limit);
  return events.map((e) => `#${e.seq} ${e.type}`).join('\n');
}
