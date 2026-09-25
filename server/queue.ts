/**
 * The queue's pump: when the slot frees, the next task starts.
 *
 * There is one agent, one API key and one daily allowance, so exactly one task
 * runs at a time — that guard is not going away. What changed is the answer to
 * the second ask: it used to be a refusal ("another task is already running"),
 * which loses the thought the operator had the moment they had it. Now the task
 * is recorded, charged and parked, and this file is what starts it.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. **One at a time, still.** A promotion claims the slot by moving the row
 *      out of 'waiting' into 'queued', which is the state the partial unique
 *      index covers. If two promotions ever raced — a settle and a retry, say —
 *      the database refuses the loser and the loser does nothing. The guard is
 *      the index, never this code.
 *   2. **First come, first served.** The line is read oldest-first, ordered by
 *      the moment each task was *asked for*. `started_at` is rewritten to the
 *      moment work actually began, so the run timer reports work, not waiting.
 *   3. **Nothing is silently lost.** A task that cannot start is failed with a
 *      sentence and the reason (`queue_stalled`), never left holding a place in
 *      the line; the next pump moves past it.
 */
import type { Db } from './db.js';
import type { RunExecutor } from './executor.js';
import { launchRun, type AcceptDeps } from './accept.js';
import { looksComplex } from './planning.js';
import { stripAttachmentSummary } from './attachments.js';
import { claimWaitingRun, getActiveRun, getRun, listWaitingRuns, setRunStatus, type Run } from './runs.js';

export interface PumpResult {
  /** The task that was started, or null when there was nothing to start. */
  started: Run | null;
  /** Why nothing started. */
  reason?: 'slot_busy' | 'line_empty' | 'claim_lost' | 'start_failed';
}

/**
 * Start the oldest waiting task, if the slot is free.
 *
 * Safe to call at any time and from anywhere: it is a no-op when a task is
 * already active or the line is empty, and the claim itself is atomic.
 */
export async function pumpQueue(
  deps: AcceptDeps & { executor: RunExecutor },
  options: { log?: (message: string) => void } = {},
): Promise<PumpResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const { db } = deps;

  // Reentrancy guard, not the real guard: two settles a millisecond apart would
  // both see a free slot here, and the index would refuse the second claim.
  if (await getActiveRun(db)) return { started: null, reason: 'slot_busy' };

  const [next] = await listWaitingRuns(db);
  if (!next) return { started: null, reason: 'line_empty' };

  // Claim it in one statement: out of the line, clock restarted, slot taken.
  // Zero rows means somebody else got there first; a unique violation means
  // another task took the slot in the same instant. Both are the guard working.
  let claimed = false;
  try {
    claimed = await claimWaitingRun(db, next.id);
  } catch (err) {
    log(`[queue] ${next.id} lost the slot to another task (${(err as Error).message})`);
    return { started: null, reason: 'claim_lost' };
  }
  if (!claimed) {
    log(`[queue] ${next.id} was already promoted or cancelled`);
    return { started: null, reason: 'claim_lost' };
  }

  const claim = (await getRun(db, next.id)) ?? next;
  // The run's own stream says what just happened. A waiting task that starts
  // without a word looks, from the card the operator is watching, exactly like
  // a task that was never going to start at all.
  await deps.executor.announce(next.id, 'run.queued', {
    position: 1,
    started: true,
    waitedMs: Math.max(0, Date.now() - new Date(next.startedAt).getTime()),
  });

  try {
    // The same question the first acceptance asked, asked of the operator's
    // own words: a task that would have been planned had the slot been free
    // must still be planned when it comes out of the line.
    const words = stripAttachmentSummary(claim.prompt);
    await launchRun(deps, claim, claim.kind === 'chat' && looksComplex(words));
  } catch (err) {
    // A task that cannot start must not hold the slot — that is what a stalled
    // queue looks like from the outside: nothing running, nothing starting.
    await setRunStatus(db, next.id, 'failed', {
      errorType: 'queue_stalled',
      errorMessage: `This task could not start (${(err as Error).message.slice(0, 300)}). Run it again.`,
    }).catch(() => {});
    log(`[queue] ${next.id} could not start: ${(err as Error).message}`);
    return { started: null, reason: 'start_failed' };
  }

  log(`[queue] ${next.id} promoted out of the line and started`);
  return { started: claim };
}
