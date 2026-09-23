/**
 * Accepting a task — the one path every channel goes through.
 *
 * Before this existed, the rules for starting a task lived inside the
 * `POST /api/runs` handler. The moment a second channel appeared (WhatsApp),
 * that became a fork: two places checking the one-active-run rule, two places
 * spending the daily budget, and eventually two slightly different answers to
 * "may this task run?". So the rules moved here and both callers use them:
 *
 *   1. refuse if a task is already in flight (the unique index is the real
 *      enforcement; the pre-check only exists to produce a good message)
 *   2. insert the run
 *   3. claim one run from today's budget atomically
 *   4. if the budget refuses, close the run immediately so it cannot cost
 *      anything and cannot block the next task
 *
 * The return value is a discriminated result, not an HTTP status: a caller
 * that speaks JSON and a caller that speaks WhatsApp both need to explain the
 * same outcome in their own language.
 */
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { RunExecutor } from './executor.js';
import { BudgetExceededError, consumeRunBudget, peekBudget, type BudgetBucket } from './budget.js';
import { RunConflictError, createRun, getActiveRun, setRunStatus, type Run, type RunKind } from './runs.js';

export const BUCKET_FOR_KIND: Record<RunKind, BudgetBucket> = {
  chat: 'web',
  whatsapp: 'whatsapp',
  api: 'api',
};

export interface AcceptDeps {
  db: Db;
  executor: RunExecutor;
  config: AppConfig;
}

export interface AcceptInput {
  prompt: string;
  kind: RunKind;
  conversationId?: string | null;
  /** The branch the run's messages belong to. Defaults to the main branch. */
  branchId?: string | null;
  /** Start a fresh sandbox instead of continuing the conversation's last one. */
  fresh?: boolean;
  /** Opt-in: one WhatsApp "done" ping when a web-started run finishes. */
  notifyWhatsapp?: boolean;
  /** Deep-research mode: chain engine passes until the time budget is spent. */
  deepResearch?: boolean;
  /** Whole minutes of wall-clock research budget. */
  researchBudgetMinutes?: number | null;
}

export type AcceptResult =
  | { ok: true; run: Run; remaining: number; bucket: BudgetBucket }
  | { ok: false; reason: 'in_progress'; active: Run }
  | {
      ok: false;
      reason: 'budget';
      message: string;
      used: number;
      limit: number;
      resetsAt: string;
    };

/**
 * The budget window is UTC midnight, which is not when the engine's own quota
 * resets. This is the honest answer for *our* guard, and the only one we can
 * compute without asking the provider.
 */
export function budgetResetsAt(now = Date.now()): string {
  const next = new Date(now + 86_400_000).toISOString().slice(0, 10);
  return `${next}T00:00:00Z`;
}

/**
 * Take a task and start it, or explain why it did not start.
 *
 * Never throws for the two ordinary refusals — in-progress and out-of-budget —
 * because both are normal outcomes that deserve a friendly explanation rather
 * than a 500.
 */
export async function acceptRun(deps: AcceptDeps, input: AcceptInput): Promise<AcceptResult> {
  const { db, executor, config } = deps;
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('acceptRun: prompt is empty');

  const bucket = BUCKET_FOR_KIND[input.kind];

  // Optimisation for a readable message — the partial unique index is what
  // actually prevents two tasks from running at once.
  const active = await getActiveRun(db);
  if (active) return { ok: false, reason: 'in_progress', active };

  let run: Run;
  try {
    run = await createRun(db, {
      prompt,
      kind: input.kind,
      engine: config.engineName,
      conversationId: input.conversationId ?? null,
      branchId: input.branchId ?? null,
      fresh: input.fresh ?? false,
      notifyWhatsapp: input.notifyWhatsapp ?? false,
      deepResearch: input.deepResearch === true,
      researchBudgetMinutes: input.deepResearch === true ? (input.researchBudgetMinutes ?? null) : null,
    });
  } catch (err) {
    if (err instanceof RunConflictError) {
      const winner = await getActiveRun(db);
      // The row we lost to may not be readable a millisecond later; fall back
      // to a stub so the caller can still name the task in flight.
      return {
        ok: false,
        reason: 'in_progress',
        active:
          winner ??
          ({
            id: err.activeRunId ?? 'unknown',
            prompt: 'Another task',
          } as Run),
      };
    }
    throw err;
  }

  // Spend only once the run exists. A refused task is closed immediately, so
  // the engine never sees the prompt and the day is not charged.
  try {
    const used = await consumeRunBudget(db, bucket, config.dailyRunBudget);
    const remaining = Math.max(0, config.dailyRunBudget - used);
    executor.start(run);
    console.log(`[run] ${run.id} queued (${input.kind}, ${remaining} left today)`);
    return { ok: true, run, remaining, bucket };
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await setRunStatus(db, run.id, 'failed', {
        errorType: 'budget_exceeded',
        errorMessage: err.message,
      });
      return {
        ok: false,
        reason: 'budget',
        message: err.message,
        used: err.used,
        limit: err.limit,
        resetsAt: budgetResetsAt(),
      };
    }
    throw err;
  }
}

/** Today's remaining runs for a channel, without spending anything. */
export async function remainingRuns(deps: AcceptDeps, kind: RunKind): Promise<number> {
  const bucket = BUCKET_FOR_KIND[kind];
  const used = await peekBudget(deps.db, bucket);
  return Math.max(0, deps.config.dailyRunBudget - used);
}
