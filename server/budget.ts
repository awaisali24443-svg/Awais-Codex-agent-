/**
 * Daily run budget.
 *
 * The free tier allows roughly 100 agent runs a day, and a run that starts is a
 * run that is spent. So the decision to spend must be one atomic database
 * operation, not a read followed by a write — otherwise two simultaneous
 * requests both see "under budget" and both spend.
 *
 * `consume` therefore does the check and the increment in a single statement.
 * The `WHERE` clause on `DO UPDATE` is what makes it safe: when the cap is
 * reached the update matches nothing, no row is returned, and the caller knows
 * the budget was refused rather than merely suspected.
 *
 * The cap is ONE shared counter for the whole day. Per-channel rows still
 * exist, but they are bookkeeping for display only: without the shared gate,
 * web, whatsapp and api would each get the full daily limit and the day could
 * spend three times the quota.
 */
import type { Db } from './db.js';

export type BudgetBucket = 'web' | 'whatsapp' | 'api' | 'engine';

export interface BudgetSnapshot {
  day: string;
  bucket: BudgetBucket;
  used: number;
  limit: number;
  remaining: number;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly bucket: BudgetBucket,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Daily run budget exhausted (${used}/${limit})`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Atomically claim one run from today's budget.
 *
 * The day boundary is UTC. That does not line up perfectly with the engine's
 * own reset, so the guard is deliberately conservative: it can refuse a run the
 * engine would still have allowed, and can never allow one past the cap.
 *
 * The gate is the day's TOTAL across every channel: the WHERE clause compares
 * the sum of today's rows against the limit, so web, whatsapp and api share
 * one allowance instead of each getting a full one. The per-channel row is
 * still incremented, so display code can report usage per channel.
 *
 * @returns the day's total usage after the claim.
 * @throws BudgetExceededError when nothing is left today.
 */
export async function consumeRunBudget(
  db: Db,
  bucket: BudgetBucket,
  limit: number,
): Promise<number> {
  // The gate has to cover the INSERT path too: for a channel with no row
  // today there is no conflict, so a WHERE only on DO UPDATE would let a new
  // channel spend past the cap. Hence INSERT..SELECT..WHERE plus the guarded
  // DO UPDATE.
  //
  // The decision to spend is this one statement. The day total is read back
  // afterwards for display: a subquery in RETURNING would not see this
  // command's own insertion (verified against PGlite), so it cannot report
  // the post-claim total.
  const rows = await db.query<{ one: number }>(
    `INSERT INTO budgets (day, bucket, count)
     SELECT CURRENT_DATE, $1, 1
      WHERE (SELECT COALESCE(SUM(count), 0) FROM budgets WHERE day = CURRENT_DATE) < $2
     ON CONFLICT (day, bucket)
     DO UPDATE SET count = budgets.count + 1
           WHERE (SELECT COALESCE(SUM(count), 0) FROM budgets WHERE day = CURRENT_DATE) < $2
      RETURNING 1`,
    [bucket, limit],
  );

  if (rows.length === 0) {
    const used = await peekDayTotal(db);
    throw new BudgetExceededError(bucket, used, limit);
  }
  return peekDayTotal(db);
}

/** Read one channel's usage without spending anything (display only). */
export async function peekBudget(db: Db, bucket: BudgetBucket): Promise<number> {
  const rows = await db.query<{ count: number }>(
    'SELECT count FROM budgets WHERE day = CURRENT_DATE AND bucket = $1',
    [bucket],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Read the day's total usage across every channel — the number the gate enforces. */
export async function peekDayTotal(db: Db): Promise<number> {
  const rows = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(count), 0) AS total FROM budgets WHERE day = CURRENT_DATE',
  );
  return Number(rows[0]?.total ?? 0);
}

export async function budgetSnapshot(
  db: Db,
  buckets: BudgetBucket[],
  limit: number,
): Promise<BudgetSnapshot[]> {
  // Deliberately unfiltered. `bucket = ANY($1)` needs the driver to serialise a
  // JS array as a Postgres array, and PGlite and node-postgres do not agree on
  // that — the query silently returned nothing under test. A day's budget table
  // has at most one row per channel, so reading them all and mapping in code is
  // both simpler and driver-proof.
  const rows = await db.query<{ bucket: BudgetBucket; count: number; day: string }>(
    `SELECT bucket, count, to_char(day, 'YYYY-MM-DD') AS day
       FROM budgets
      WHERE day = CURRENT_DATE`,
  );
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  // `used` stays per channel (display only); `remaining` comes off the shared
  // day total, because that is the counter the spending gate enforces.
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);

  return buckets.map((bucket) => {
    const row = byBucket.get(bucket);
    const used = Number(row?.count ?? 0);
    return {
      day: row?.day ?? new Date().toISOString().slice(0, 10),
      bucket,
      used,
      limit,
      remaining: Math.max(0, limit - total),
    };
  });
}

/**
 * Release a claimed run. Used when a run is refused *after* the claim (for
 * example the one-mission-at-a-time rule rejected it) so a failed attempt never
 * counts against the day.
 */
export async function refundRunBudget(db: Db, bucket: BudgetBucket): Promise<void> {
  await db.query(
    `UPDATE budgets
        SET count = GREATEST(0, count - 1)
      WHERE day = CURRENT_DATE AND bucket = $1`,
    [bucket],
  );
}
