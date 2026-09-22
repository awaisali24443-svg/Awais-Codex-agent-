/**
 * The morning briefing: a read-only summary of what the agent has been doing.
 *
 * No scheduling, no sending, no pings — this endpoint only *answers* when
 * asked. The point is review, not interruption: after a night of autonomous
 * work, one call shows what ran, what broke, what it cost in tokens, and
 * which reminders are still pending.
 */
import type { Db } from './db.js';

export interface BriefingRun {
  id: string;
  status: string;
  kind: string;
  prompt: string;
  startedAt: string;
  finishedAt: string | null;
  errorType: string | null;
}

export interface Briefing {
  since: string;
  windowHours: number;
  runs: BriefingRun[];
  counts: { total: number; completed: number; failed: number; cancelled: number };
  tokens: { in: number; out: number };
  reminders: { pending: number; nextDue: string | null };
}

const MAX_PROMPT_CHARS = 160;

interface RunRow {
  id: string;
  status: string;
  kind: string;
  prompt: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  error_type: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getBriefing(db: Db, windowHours = 12): Promise<Briefing> {
  const since = new Date(Date.now() - windowHours * 3_600_000);

  const rows = await db.query<RunRow>(
    `SELECT id, status, kind, prompt, started_at, finished_at, error_type,
            tokens_in, tokens_out
       FROM runs
      WHERE started_at >= $1
      ORDER BY started_at DESC
      LIMIT 50`,
    [since.toISOString()],
  );

  const runs: BriefingRun[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    kind: row.kind,
    prompt:
      row.prompt.length > MAX_PROMPT_CHARS
        ? `${row.prompt.slice(0, MAX_PROMPT_CHARS)}…`
        : row.prompt,
    startedAt: toIso(row.started_at) as string,
    finishedAt: toIso(row.finished_at),
    errorType: row.error_type,
  }));

  const counts = { total: runs.length, completed: 0, failed: 0, cancelled: 0 };
  let tokensIn = 0;
  let tokensOut = 0;
  for (const row of rows) {
    if (row.status === 'completed') counts.completed++;
    else if (row.status === 'failed') counts.failed++;
    else if (row.status === 'cancelled') counts.cancelled++;
    tokensIn += row.tokens_in ?? 0;
    tokensOut += row.tokens_out ?? 0;
  }

  const reminders = await db.query<{ pending: string; next_due: Date | string | null }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            MIN(run_at) FILTER (WHERE status = 'pending') AS next_due
       FROM reminders`,
  );

  return {
    since: since.toISOString(),
    windowHours,
    runs,
    counts,
    tokens: { in: tokensIn, out: tokensOut },
    reminders: {
      pending: Number(reminders[0]?.pending ?? 0),
      nextDue: toIso(reminders[0]?.next_due ?? null),
    },
  };
}
