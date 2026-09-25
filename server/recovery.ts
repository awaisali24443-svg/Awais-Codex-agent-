/**
 * Crash-resume on boot. A run left 'running' (or 'queued') by a restart used
 * to be failed outright and its partial work lost. Now:
 *
 * - A run left in 'planning' is failed as 'interrupted': the planning pass was
 *   an in-flight engine call that died with the process, and there is no plan
 *   to approve yet. Retrying re-drafts it; leaving it would hold the single
 *   active slot until the hour-long staleness sweep noticed.
 *
 * - 'paused' runs are left alone. Nothing pauses a run automatically any more
 *   — the per-task token cap that used to is gone — so a 'paused' row is either
 *   an operator pause or a leftover from before that change, and resuming it
 *   unasked would be wrong either way.
 * - The newest orphan with finished checkpoints resumes automatically, from
 *   its first unfinished step. One at a time: the rest wait for the operator.
 * - Every other orphan is failed as 'interrupted' — resumable by tap, not
 *   silently dropped. A day-old partial mission is stale context, so it is
 *   failed rather than resumed (see triageOrphan).
 */
import type { Db } from './db.js';
import { getRun, type Run } from './runs.js';
import { resumeFromStep, triageOrphan } from './mission_steps.js';

export interface RecoveryResult {
  resumed: number;
  failed: number;
  resumedRunId: string | null;
}

interface OrphanRow {
  id: string;
  status: string;
  started_at: Date | string;
  done_steps: string;
}

export async function recoverOrphanedRuns(
  db: Db,
  executor: { start(run: Run): void },
): Promise<RecoveryResult> {
  const result: RecoveryResult = { resumed: 0, failed: 0, resumedRunId: null };
  // 'waiting' is deliberately absent: a parked task is not an orphan. It
  // never started, so there is nothing to resume and nothing to fail — it is
  // simply still in line, and the queue's pump will reach it. Failing it here
  // would throw away the operator's ask on every deploy, which is the worst
  // possible moment to lose it.
  const orphans = await db.query<OrphanRow>(
    `SELECT r.id, r.status, r.started_at,
            (SELECT COUNT(*)::text FROM mission_steps s
              WHERE s.run_id = r.id AND s.status = 'done') AS done_steps
       FROM runs r
      WHERE r.status IN ('queued', 'running', 'planning')
      ORDER BY r.started_at DESC`,
  );
  let autoResumed = false;
  for (const orphan of orphans) {
    // A planning orphan has nothing to resume: it never started executing.
    // Failing it frees the slot immediately and the operator's Retry re-drafts
    // the plan — which is exactly what was happening when the process died.
    if (orphan.status === 'planning') {
      await db.query(
        `UPDATE runs
            SET status = 'failed',
                error_type = 'interrupted',
                error_message = 'The server restarted while the plan was being drafted. Run it again.',
                finished_at = now()
          WHERE id = $1`,
        [orphan.id],
      );
      result.failed += 1;
      console.log(`[boot] ${orphan.id} was still planning — failed as interrupted`);
      continue;
    }
    const doneSteps = Number(orphan.done_steps ?? 0);
    const verdict = !autoResumed ? triageOrphan(doneSteps, orphan.started_at) : 'fail';
    if (verdict === 'resume') {
      const fromStep = await resumeFromStep(db, orphan.id);
      await db.query(
        `UPDATE runs
            SET status = 'queued', resume_from_step = $2,
                error_type = NULL, error_message = NULL
          WHERE id = $1`,
        [orphan.id, fromStep],
      );
      const run = await getRun(db, orphan.id);
      if (run) {
        executor.start(run);
        autoResumed = true;
        result.resumed += 1;
        result.resumedRunId = orphan.id;
        console.log(`[boot] resuming ${orphan.id} from step ${fromStep} (${doneSteps} step(s) done)`);
      } else {
        result.failed += 1;
      }
    } else {
      await db.query(
        `UPDATE runs
            SET status = 'failed',
                error_type = 'interrupted',
                error_message = 'Server restarted while this run was in flight. Its finished steps are checkpointed — resume it from the chat to continue.',
                finished_at = now()
          WHERE id = $1`,
        [orphan.id],
      );
      result.failed += 1;
      console.log(`[boot] orphan ${orphan.id} marked interrupted (${doneSteps} step(s) done, resumable by tap)`);
    }
  }
  return result;
}
