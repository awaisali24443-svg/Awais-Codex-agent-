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
    super(`Daily ${bucket} run budget exhausted (${used}/${limit})`);
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
 * @throws BudgetExceededError when nothing is left today.
 */
export async function consumeRunBudget(
  db: Db,
  bucket: BudgetBucket,
  limit: number,
): Promise<number> {
  const rows = await db.query<{ count: number }>(
    `INSERT INTO budgets (day, bucket, count)
          VALUES (CURRENT_DATE, $1, 1)
     ON CONFLICT (day, bucket)
     DO UPDATE SET count = budgets.count + 1
           WHERE budgets.count < $2
      RETURNING count`,
    [bucket, limit],
  );

  if (rows.length === 0) {
    const used = await peekBudget(db, bucket);
    throw new BudgetExceededError(bucket, used, limit);
  }
  return rows[0].count;
}

/** Read today's usage without spending anything. */
export async function peekBudget(db: Db, bucket: BudgetBucket): Promise<number> {
  const rows = await db.query<{ count: number }>(
    'SELECT count FROM budgets WHERE day = CURRENT_DATE AND bucket = $1',
    [bucket],
  );
  return rows[0]?.count ?? 0;
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

  return buckets.map((bucket) => {
    const row = byBucket.get(bucket);
    const used = row?.count ?? 0;
    return {
      day: row?.day ?? new Date().toISOString().slice(0, 10),
      bucket,
      used,
      limit,
      remaining: Math.max(0, limit - used),
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
