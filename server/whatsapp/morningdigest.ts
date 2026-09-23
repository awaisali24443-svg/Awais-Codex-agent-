/**
 * The morning digest: one WhatsApp message at 07:30 Asia/Karachi summarising
 * the night — what ran, what failed, what's waiting.
 *
 * The anti-spam rules, all in this file:
 *
 *   - Silent without a token. No `whatsapp_token` means no digest, no error,
 *     no log line worth waking up for.
 *   - One message per morning. The day is claimed in `morning_digest_log`
 *     *before* sending; a restart, a redeploy, or a slow send can never
 *     produce a second message for the same day.
 *   - A failed send still claims the day. Retrying every 60 seconds until it
 *     works would be notification spam; the owner asked for one ritual line,
 *     not a retry loop.
 *   - Never throws. The digest is decoration — a send failure must not touch
 *     anything else in the process.
 *   - Never a run. This is a direct send, like the done ping — it costs zero
 *     of the daily task budget.
 *
 * The recipient is the same learned creator id the done ping uses
 * (`whatsapp_to` override or the id learned from inbound traffic).
 */
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { SecretsStore } from '../settings.js';
import { WhatsAppClient } from './api.js';
import { WhatsAppSender } from './sender.js';
import { resolveRecipient } from './doneping.js';

/** When the digest fires, every morning. */
export const DIGEST_TIME = '07:30';
/** The owner's wall-clock timezone. */
export const DIGEST_TIMEZONE = 'Asia/Karachi';
/** How far back "overnight" reaches. */
export const DIGEST_WINDOW_HOURS = 12;

export interface DigestDeps {
  db: Db;
  config: Pick<AppConfig, 'morningDigestEnabled'>;
  /** The secrets store; `whatsapp_token` and `whatsapp_to` are read. */
  secrets: Pick<SecretsStore, 'get'>;
  /** Test seam: replaces the HTTP layer. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Test seam: the "now" the digest reasons about. */
  now?: () => Date;
}

export interface DigestRun {
  id: string;
  status: string;
  kind: string;
  prompt: string;
  errorType: string | null;
  errorMessage: string | null;
}

export interface DigestDraft {
  id: string;
  snippet: string;
}

export interface DigestSchedule {
  id: string;
  name: string;
  /** Next firing, as a wall-clock HH:MM in Asia/Karachi. */
  at: string;
}

export interface DigestData {
  /** YYYY-MM-DD in Asia/Karachi — the morning being reported. */
  date: string;
  /** Runs that finished inside the window. */
  finished: DigestRun[];
  /** Runs still in flight right now (queued/running/paused/awaiting_plan). */
  active: DigestRun[];
  /** LinkedIn drafts still waiting for Publish. */
  drafts: DigestDraft[];
  /** Enabled schedules firing later today. */
  dueToday: DigestSchedule[];
}

interface RunRow {
  id: string;
  status: string;
  kind: string;
  prompt: string;
  error_type: string | null;
  error_message: string | null;
}

function titleOf(prompt: string, max = 60): string {
  const oneLine = prompt.trim().replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine || 'Untitled task';
}

function errorOf(run: DigestRun): string | null {
  const raw = run.errorMessage || run.errorType;
  if (!raw) return null;
  const oneLine = raw.trim().replace(/\s+/g, ' ');
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
}

/** YYYY-MM-DD of `date` on the owner's wall clock. */
export function karachiDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DIGEST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Start and end instants of the current Asia/Karachi calendar day. */
export function karachiDayBounds(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DIGEST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 1);
  // Asia/Karachi has no DST, but probe the offset anyway so the bounds stay
  // honest for any zone this is ever pointed at.
  const probe = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), 12, 0, 0));
  const wall = new Intl.DateTimeFormat('en-US', {
    timeZone: DIGEST_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const w: Record<string, string> = {};
  for (const p of wall.formatToParts(probe)) w[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(w.year),
    Number(w.month) - 1,
    Number(w.day),
    Number(w.hour) % 24,
    Number(w.minute),
    Number(w.second),
  );
  const offsetMs = asUtc - probe.getTime();
  const start = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), 0, 0, 0) - offsetMs);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** HH:MM of an instant on the owner's wall clock. */
function karachiTime(instant: Date | string): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DIGEST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

function mapRun(row: RunRow): DigestRun {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    prompt: row.prompt,
    errorType: row.error_type,
    errorMessage: row.error_message,
  };
}

/**
 * Everything the message needs, in three cheap queries. Pure reads — the
 * digest never writes anything except its own one-row-per-day log.
 */
export async function collectDigestData(db: Db, now: Date = new Date()): Promise<DigestData> {
  const since = new Date(now.getTime() - DIGEST_WINDOW_HOURS * 3_600_000).toISOString();

  const finishedRows = await db.query<RunRow>(
    `SELECT id, status, kind, prompt, error_type, error_message
       FROM runs
      WHERE finished_at >= $1
        AND status IN ('completed', 'failed', 'cancelled')
      ORDER BY finished_at DESC
      LIMIT 50`,
    [since],
  );

  const activeRows = await db.query<RunRow>(
    `SELECT id, status, kind, prompt, error_type, error_message
       FROM runs
      WHERE status IN ('queued', 'running', 'paused', 'awaiting_plan')
      ORDER BY started_at DESC
      LIMIT 10`,
    [],
  );

  const draftRows = await db.query<{ id: string; snippet: string }>(
    `SELECT id, LEFT(text, 80) AS snippet
       FROM linkedin_drafts
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 10`,
    [],
  );

  const { start, end } = karachiDayBounds(now);
  const scheduleRows = await db.query<{
    id: string;
    name: string;
    next_run_at: Date | string;
  }>(
    `SELECT id, name, next_run_at
       FROM scheduled_tasks
      WHERE enabled AND next_run_at >= $1 AND next_run_at < $2
      ORDER BY next_run_at ASC
      LIMIT 20`,
    [start.toISOString(), end.toISOString()],
  );

  return {
    date: karachiDateString(now),
    finished: finishedRows.map(mapRun),
    active: activeRows.map(mapRun),
    drafts: draftRows.map((r) => ({ id: r.id, snippet: r.snippet })),
    dueToday: scheduleRows.map((r) => ({
      id: r.id,
      name: r.name,
      at: karachiTime(r.next_run_at),
    })),
  };
}

/**
 * The message itself. Plain text, no markdown tables — this is read on a
 * phone. Short enough to arrive as one message; a quiet night is one line,
 * because the point is the ritual, not the report.
 */
export function composeMorningDigest(data: DigestData): string {
  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: DIGEST_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${data.date}T12:00:00+05:00`));
  const header = `🌅 Morning digest — ${dateLabel}`;

  const completed = data.finished.filter((r) => r.status === 'completed').length;
  const failed = data.finished.filter((r) => r.status === 'failed');
  const cancelled = data.finished.filter((r) => r.status === 'cancelled').length;
  const plansAwaiting = data.active.filter((r) => r.status === 'awaiting_plan');

  const lines: string[] = [header];

  if (data.finished.length > 0) {
    const parts = [`${completed} done`];
    if (failed.length > 0) parts.push(`${failed.length} failed`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    lines.push('', `Overnight: ${data.finished.length} ran · ${parts.join(' · ')}`);
  }

  for (const run of failed) {
    const reason = errorOf(run);
    lines.push(`❌ "${titleOf(run.prompt)}"${reason ? ` — ${reason}` : ''}`);
  }

  for (const run of data.active) {
    if (run.status === 'awaiting_plan') continue; // counted below, with its ask
    lines.push(`🟢 Still going: "${titleOf(run.prompt)}" (${run.status})`);
  }

  const waiting: string[] = [];
  for (const run of plansAwaiting) {
    waiting.push(`• 1 plan to approve — "${titleOf(run.prompt)}"`);
  }
  if (data.drafts.length > 0) {
    waiting.push(
      `• ${data.drafts.length} LinkedIn draft${data.drafts.length === 1 ? '' : 's'} to publish` +
        (data.drafts.length === 1 ? ` — "${titleOf(data.drafts[0].snippet, 50)}"` : ''),
    );
  }
  if (waiting.length > 0) {
    lines.push('', '⏳ Waiting on you');
    lines.push(...waiting);
  }

  if (data.dueToday.length > 0) {
    lines.push('', '📅 Due today');
    for (const s of data.dueToday) lines.push(`• ${s.at} — ${s.name}`);
  }

  const busy =
    data.finished.length > 0 ||
    data.active.length > 0 ||
    data.drafts.length > 0 ||
    data.dueToday.length > 0;
  if (!busy) {
    lines.push('', 'Quiet night — nothing ran and nothing is waiting. ☕');
  }

  return lines.join('\n');
}

/**
 * Claim this morning (in the digest log), then send. The claim happens first:
 * a second tick, a restart, or a slow send can never double the message, and
 * a failed send does not turn into a 60-second retry loop.
 *
 * Resolves true only when a message was accepted by the platform. Never
 * throws — a digest failure must not affect anything else in the process.
 */
export async function maybeSendMorningDigest(deps: DigestDeps): Promise<boolean> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ? deps.now() : new Date();
  try {
    if (!deps.config.morningDigestEnabled) return false;

    const token = deps.secrets.get('whatsapp_token');
    if (!token) return false;

    const to = await resolveRecipient(
      { db: deps.db, secrets: deps.secrets },
      (message, level) =>
        level === 'error' ? console.error(`[digest] ${message}`) : console.log(`[digest] ${message}`),
    );
    if (!to) return false;

    const dateKey = karachiDateString(now);
    const claimed = await deps.db.query<{ sent_date: string }>(
      `INSERT INTO morning_digest_log (sent_date) VALUES ($1)
       ON CONFLICT (sent_date) DO NOTHING
       RETURNING sent_date`,
      [dateKey],
    );
    if (claimed.length === 0) return false; // already sent (or attempted) this morning

    const data = await collectDigestData(deps.db, now);
    const message = composeMorningDigest(data);

    const client = new WhatsAppClient({
      token,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
    });
    const sender = new WhatsAppSender(client, (message_, level) =>
      level === 'error' ? console.error(`[digest] ${message_}`) : console.log(`[digest] ${message_}`),
    );
    const ok = await sender.send(message, { to });
    if (ok) log(`[digest] morning digest sent for ${dateKey}`);
    else log(`[digest] morning digest send failed for ${dateKey}: ${sender.error ?? 'unknown'}`, 'warn');
    return ok;
  } catch (err) {
    log(`[digest] morning digest failed: ${(err as Error).message}`, 'warn');
    return false;
  }
}
