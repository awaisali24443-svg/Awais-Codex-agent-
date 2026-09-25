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
import type { SecretsStore } from './settings.js';
import { BudgetExceededError, consumeRunBudget, peekDayTotal, refundRunBudget, type BudgetBucket } from './budget.js';
import { looksComplex } from './planning.js';
import { looksLikeUiMission } from './design.js';
import { directionPayload } from './design/directions.js';
import {
  attachmentSummary,
  imageSummary,
  parseImages,
  withAttachments,
  withImageNote,
  type Attachment,
  type ImageAttachment,
} from './attachments.js';
import { maybeAskPlanApproval } from './whatsapp/approvals.js';
import {
  RunConflictError,
  createRun,
  getActiveRun,
  getRun,
  saveRunPlan,
  setRunStatus,
  waitingPosition,
  type Run,
  type RunKind,
} from './runs.js';

export const BUCKET_FOR_KIND: Record<RunKind, BudgetBucket> = {
  chat: 'web',
  whatsapp: 'whatsapp',
  api: 'api',
};

export interface AcceptDeps {
  db: Db;
  executor: RunExecutor;
  config: AppConfig;
  /**
   * Optional: when present, a run that pauses in 'awaiting_plan' also asks
   * the owner on WhatsApp (one ask, silent without a token, never throws).
   * Callers that cannot approve over WhatsApp simply omit it.
   */
  secrets?: Pick<SecretsStore, 'get'>;
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
  /**
   * Title for the auto-created conversation, when no conversationId is given.
   * Scheduled tasks use this so a fired run is visibly theirs in the sidebar.
   */
  conversationTitle?: string | null;
  /**
   * Files the operator attached in the composer. Already validated by
   * `parseAttachments`; their text goes to the engine only.
   */
  attachments?: Attachment[];
  /** Pictures that arrived with the task, already validated by parseImages. */
  images?: ImageAttachment[];
}

export type AcceptResult =
  | {
      ok: true;
      run: Run;
      remaining: number;
      bucket: BudgetBucket;
      /**
       * Resolves when the background planning pass has settled (plan saved, or
       * the run handed to the executor, or failed). Callers do not await this —
       * that is the point: the request returns the moment the run exists. Tests
       * await it so an assertion can be made about the outcome.
       */
      planning?: Promise<void>;
      /**
       * Set when the task was parked rather than started. `ahead` is the task
       * holding the slot, so the operator is told what they are waiting behind
       * instead of being told to try later.
       */
      queue?: { position: number; ahead: Run };
    }
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
 * Draft the plan without holding the request, the run slot or the operator.
 *
 * Every event it produces goes on the run's own stream, so the card the
 * operator is already watching fills itself in: the model's steps as it names
 * them, the engine's waiting and retrying lines, and finally the plan to
 * approve. A cancelled run is respected between every step — the pass stops,
 * nothing starts, and the run is left as the cancellation made it.
 */
async function draftPlan(deps: AcceptDeps, run: Run): Promise<void> {
  const { db, executor } = deps;
  const current = async (): Promise<Run | null> => getRun(db, run.id);

  try {
    const steps = await executor.planMission(run, (event) => {
      // Fire-and-forget: a slow database must not stall the planning pass.
      void executor.announce(run.id, event.type, event.payload);
    });
    // The milestones are on the stream before the plan that supersedes them.
    await executor.flushAnnouncements(run.id);

    const fresh = await current();
    // Cancelled, failed, or otherwise closed while planning: say nothing and
    // start nothing. The operator's stop is the last word.
    if (!fresh || fresh.status !== 'planning') return;

    if (steps.length > 0) {
      await saveRunPlan(db, run.id, steps);
      await setRunStatus(db, run.id, 'awaiting_plan');
      // A page is built in a direction, and the direction is chosen here —
      // while the run is stopped for approval anyway, so asking costs no extra
      // interruption and the plan the operator approves states the look of the
      // page instead of leaving it to be discovered afterwards. The three
      // alternates ride along so the card can offer them without a round trip.
      const direction = looksLikeUiMission(run.prompt) ? directionPayload(run.prompt) : null;
      await executor.announce(run.id, 'run.plan_ready', { plan: steps, direction });
      const held = await current();
      console.log(`[run] ${run.id} awaiting plan approval (${steps.length} steps)`);
      // The owner may be on the phone, not the web app: one WhatsApp ask,
      // answered with YES / NO / CHANGE. Fire-and-forget — it never throws.
      if (deps.secrets) {
        void maybeAskPlanApproval({ db, secrets: deps.secrets }, held ?? run, steps);
      }
      return;
    }

    // A plan that never arrived must not strand the task: execute, loudly.
    console.log(`[run] ${run.id} planning pass came back empty — executing directly`);
    executor.start(fresh);
  } catch (err) {
    // The acceptance promise has already been kept, so this is the only place
    // left that can free the single-active slot. A run left in 'planning' would
    // refuse every future task, which is exactly what a broken queue looks
    // like from the outside.
    await setRunStatus(db, run.id, 'failed', {
      errorType: 'accept_failed',
      errorMessage: (err as Error).message,
    });
    await refundRunBudget(db, BUCKET_FOR_KIND[run.kind]);
    console.error(`[run] ${run.id} planning pass failed:`, (err as Error).message);
  }
}

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
 * Hand an accepted run to the executor, or start its planning pass.
 *
 * Shared by the two ways a run can become the active one: it was accepted into
 * an empty slot, or it was promoted out of the queue when the task in front of
 * it settled. The decision — plan first, or start — must be the same in both
 * paths, or a promoted task would quietly skip the approval step the operator
 * gets on every other complex ask.
 */
export async function launchRun(
  deps: AcceptDeps,
  run: Run,
  /**
   * Whether this task earns a planning pass. Passed in rather than derived
   * here, because the run's `prompt` is the *wire* text — the operator's
   * sentence with file contents and an attachment notice folded in — and
   * "is this a complex task?" must be asked of the sentence, not the files.
   */
  planFirst = false,
): Promise<void> {
  const { db, executor } = deps;
  if (planFirst) {
    // A promoted task is already 'running' (it is what holds the slot); the
    // planning pass turns it into the visible 'planning' state the client
    // already knows how to draw.
    await setRunStatus(db, run.id, 'planning');
    await executor.announce(run.id, 'run.plan_started', {});
    const held = await getRun(db, run.id);
    void draftPlan(deps, { ...(held ?? run), images: run.images });
    console.log(`[run] ${run.id} planning pass started in the background`);
    return;
  }
  executor.start(run);
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

  // One task holds the single-active slot; everything else waits in line. The
  // partial unique index is what actually enforces it — this read is for the
  // answer, not for the guard.
  const active = await getActiveRun(db);
  const parked = active !== null;

  const attachments = input.attachments ?? [];
  const images = input.images ?? [];

  let run: Run;
  try {
    run = await createRun(db, {
      // A second ask is parked, not refused: the status is decided here, at the
      // insert, so the row exists in the line from the moment the operator
      // presses send and the single-active guard never has to be argued with.
      queued: parked,
      // The thread shows the operator's words plus a line naming the files; the
      // engine gets the words plus the files themselves.
      prompt: prompt + attachmentSummary(attachments) + imageSummary(images),
      enginePrompt: withImageNote(withAttachments(prompt, attachments), images),
      images,
      kind: input.kind,
      engine: config.engineName,
      conversationId: input.conversationId ?? null,
      branchId: input.branchId ?? null,
      fresh: input.fresh ?? false,
      notifyWhatsapp: input.notifyWhatsapp ?? false,
      deepResearch: input.deepResearch === true,
      researchBudgetMinutes: input.deepResearch === true ? (input.researchBudgetMinutes ?? null) : null,
      conversationTitle: input.conversationTitle ?? null,
    });
  } catch (err) {
    if (!(err instanceof RunConflictError)) throw err;
    // Between our read and our insert, another request took the slot — the
    // race the partial unique index exists to catch. The ask is not refused for
    // being a millisecond late: it is parked, exactly as a task that arrived a
    // second later would have been. (The insert is transactional, so the failed
    // attempt left nothing behind but the conflict.)
    try {
      run = await createRun(db, {
        prompt: prompt + attachmentSummary(attachments) + imageSummary(images),
        enginePrompt: withImageNote(withAttachments(prompt, attachments), images),
        images,
        kind: input.kind,
        engine: config.engineName,
        conversationId: input.conversationId ?? null,
        branchId: input.branchId ?? null,
        fresh: input.fresh ?? false,
        notifyWhatsapp: input.notifyWhatsapp ?? false,
        deepResearch: input.deepResearch === true,
        researchBudgetMinutes: input.deepResearch === true ? (input.researchBudgetMinutes ?? null) : null,
        conversationTitle: input.conversationTitle ?? null,
        queued: true,
      });
    } catch (retryErr) {
      if (retryErr instanceof RunConflictError) {
        const winner = await getActiveRun(db);
        return {
          ok: false,
          reason: 'in_progress',
          active: winner ?? ({ id: err.activeRunId ?? 'unknown', prompt: 'Another task' } as Run),
        };
      }
      throw retryErr;
    }
  }

  // Spend only once the run exists. A refused task is closed immediately, so
  // the engine never sees the prompt and the day is not charged. A parked task
  // is charged like any other: it is a real task that will run today, and
  // discovering the day's limit at promotion time — after the operator has
  // walked away — would be a worse moment to find out.
  try {
    const used = await consumeRunBudget(db, bucket, config.dailyRunBudget);
    const remaining = Math.max(0, config.dailyRunBudget - used);

    // Parked behind the task that holds the slot. Nothing else happens here:
    // the executor pumps the line when that task settles, which is the only
    // place that knows the slot is free.
    if (run.status === 'waiting') {
      const position = await waitingPosition(db, run.id);
      const ahead = active ?? (await getActiveRun(db));
      console.log(`[queue] ${run.id} waiting (position ${position}, ${remaining} left today)`);
      return { ok: true, run, remaining, bucket, queue: { position, ahead: ahead ?? run } };
    }

    // Complex web missions pause for plan approval. One short planning pass
    // asks the engine for its step-by-step plan; the run then waits in
    // 'awaiting_plan' and the mission executes only after the operator
    // approves (or edits then approves). WhatsApp and API missions have no
    // approval UI, so they keep the direct path; simple questions never pay
    // for a planning call.
    if (input.kind === 'chat' && looksComplex(prompt)) {
      // The root of "it takes minutes and shows nothing": this used to be an
      // awaited, non-streamed engine call *inside* the request. The operator
      // waited up to a minute for an HTTP response, had nothing to attach to,
      // and therefore saw nothing. The pass runs in the background instead, its
      // own progress and the model's own milestones streaming as they happen.
      await setRunStatus(db, run.id, 'planning');
      // Through the executor, so this event and every later milestone share one
      // serialised writer: the stream can never show the plan before it.
      await executor.announce(run.id, 'run.plan_started', {});
      const held = await getRun(db, run.id);
      // The planning pass is handed the images too: a screenshot decides what
      // the plan should be, and asking for a plan about a picture it cannot see
      // is how a plan comes back about the wrong thing.
      const planning = draftPlan(deps, { ...(held ?? run), images: run.images });
      console.log(`[run] ${run.id} planning pass started in the background`);
      return { ok: true, run: held ?? run, remaining, bucket, planning };
    }

    await launchRun(deps, run, input.kind === 'chat' && looksComplex(prompt));
    // `run.prompt` now holds the wire prompt, file contents and all. Nothing
    // outside this process should ever see that, so the caller gets the row.
    run = (await getRun(db, run.id)) ?? run;
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
    // A run that never started must never keep holding the single-active
    // slot: a 'queued' run stranded here refuses every future mission with
    // "another mission is already running" until the next restart, which is
    // exactly what a broken queue looks like from the outside. Fail it, hand
    // back the budget it never spent, then let the original error propagate.
    // Both cleanups are best-effort — the caller's error is what matters.
    await setRunStatus(db, run.id, 'failed', {
      errorType: 'accept_failed',
      errorMessage: (err as Error).message,
    }).catch(() => {});
    await refundRunBudget(db, bucket).catch(() => {});
    throw err;
  }
}

/**
 * Pre-flight cost estimate for a mission, shown in the composer before the
 * run starts. Two ingredients: the operator's own history (average tokens of
 * their recent completed missions — their usage, not a global guess) and the
 * shape of this mission (deep-research chains passes, so it costs passes).
 * Falls back to a flat 8k when there is no history yet. An estimate, labelled
 * as one — the engine reports exact tokens only when the run finishes.
 */
export interface CostEstimate {
  estimatedTokens: number;
  /** Where the number came from: 'history' or 'fallback'. */
  basis: 'history' | 'fallback';
  missionsSampled: number;
}

export async function estimateRunCost(
  db: Db,
  input: { prompt: string; deepResearch?: boolean; researchBudgetMinutes?: number | null },
): Promise<CostEstimate> {
  const rows = await db.query<{ avg_tokens: string | null; n: string }>(
    `SELECT AVG(tokens_in + tokens_out)::text AS avg_tokens, COUNT(*)::text AS n
       FROM (SELECT tokens_in, tokens_out FROM runs
              WHERE status = 'completed'
                AND tokens_in IS NOT NULL AND tokens_out IS NOT NULL
              ORDER BY finished_at DESC LIMIT 20) recent`,
  );
  const avg = Number(rows[0]?.avg_tokens ?? NaN);
  const n = Number(rows[0]?.n ?? 0);
  let estimated = Number.isFinite(avg) && avg > 0 ? Math.round(avg) : 8000;
  const basis: CostEstimate['basis'] = Number.isFinite(avg) && avg > 0 ? 'history' : 'fallback';
  if (input.deepResearch) {
    // Each 15-minute research pass costs roughly one mission.
    const passes = Math.max(1, Math.ceil((input.researchBudgetMinutes ?? 15) / 15));
    estimated = estimated * passes;
  }
  return { estimatedTokens: estimated, basis, missionsSampled: n };
}

/**
 * Today's remaining runs, without spending anything.
 *
 * The day TOTAL, not one channel's count: `consumeRunBudget` refuses a run when
 * the sum of today's rows reaches the cap, so a per-channel number would tell
 * the operator "79 left" while the next message is refused. What the phone
 * reports and what the gate enforces must be the same number.
 */
export async function remainingRuns(deps: AcceptDeps): Promise<number> {
  const used = await peekDayTotal(deps.db);
  return Math.max(0, deps.config.dailyRunBudget - used);
}
