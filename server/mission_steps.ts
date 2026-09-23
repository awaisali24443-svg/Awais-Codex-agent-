/**
 * Durable mission checkpoints. The agent announces its plan as
 * "Step 1/N: ..." lines and "Step k/N done: ..." lines (see planning.ts);
 * each one lands here the moment it is announced, so a crash or a deploy
 * mid-mission loses nothing that was already finished.
 *
 * Resume reuses the same run row: boot (or the Resume button) requeues the
 * run with resume_from_step set, and the executor prepends the done summaries
 * to the mission so the engine continues where it left off.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import type { Milestone } from './planning.js';

export interface MissionStep {
  seq: number;
  total: number;
  label: string;
  status: 'pending' | 'doing' | 'done' | 'failed' | 'skipped';
  resultSummary: string | null;
}

function newStepId(): string {
  return `mst_${randomBytes(9).toString('base64url')}`;
}

/**
 * File one announced milestone. "Step k/N: label" creates/updates the row;
 * "Step k/N done: outcome" marks it done with the outcome as the summary.
 * Idempotent: a re-announced step updates rather than duplicates.
 */
export async function recordMissionStep(db: Db, runId: string, milestone: Milestone): Promise<void> {
  const rows = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM mission_steps WHERE run_id = $1 AND seq = $2`,
    [runId, milestone.index],
  );
  if (milestone.done) {
    if (rows[0]) {
      await db.query(
        `UPDATE mission_steps
            SET status = 'done', result_summary = $2, label = $3, total = $4, updated_at = now()
          WHERE id = $1 AND status <> 'done'`,
        [rows[0].id, milestone.label.slice(0, 500), milestone.label.slice(0, 140), milestone.total],
      );
      // A step re-done after a resume keeps its summary: only fill when empty.
      await db.query(
        `UPDATE mission_steps SET result_summary = $2, updated_at = now()
          WHERE id = $1 AND result_summary IS NULL`,
        [rows[0].id, milestone.label.slice(0, 500)],
      );
    } else {
      await db.query(
        `INSERT INTO mission_steps (id, run_id, seq, total, label, status, result_summary)
         VALUES ($1, $2, $3, $4, $5, 'done', $6)`,
        [newStepId(), runId, milestone.index, milestone.total, milestone.label.slice(0, 140), milestone.label.slice(0, 500)],
      );
    }
  } else if (rows[0]) {
    await db.query(
      `UPDATE mission_steps SET label = $2, total = $3, updated_at = now() WHERE id = $1`,
      [rows[0].id, milestone.label.slice(0, 140), milestone.total],
    );
  } else {
    await db.query(
      `INSERT INTO mission_steps (id, run_id, seq, total, label, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [newStepId(), runId, milestone.index, milestone.total, milestone.label.slice(0, 140)],
    );
  }
}

export async function getMissionSteps(db: Db, runId: string): Promise<MissionStep[]> {
  const rows = await db.query<{
    seq: number;
    total: number;
    label: string;
    status: string;
    result_summary: string | null;
  }>(`SELECT seq, total, label, status, result_summary FROM mission_steps
      WHERE run_id = $1 ORDER BY seq ASC`, [runId]);
  return rows.map((r) => ({
    seq: r.seq,
    total: r.total,
    label: r.label,
    status: r.status as MissionStep['status'],
    resultSummary: r.result_summary,
  }));
}

/** First step that is not done/skipped, or null when the plan is complete. */
export async function firstPendingStep(db: Db, runId: string): Promise<number | null> {
  const rows = await db.query<{ seq: number }>(
    `SELECT seq FROM mission_steps WHERE run_id = $1 AND status NOT IN ('done', 'skipped')
     ORDER BY seq ASC LIMIT 1`,
    [runId],
  );
  return rows[0]?.seq ?? null;
}

/**
 * The step a resumed mission continues from: the first unfinished step when
 * one was announced, otherwise the step after the highest finished one
 * (steps are numbered sequentially), otherwise step 1.
 */
export async function resumeFromStep(db: Db, runId: string): Promise<number> {
  const pending = await firstPendingStep(db, runId);
  if (pending != null) return pending;
  const rows = await db.query<{ max_done: number | null }>(
    `SELECT MAX(seq) AS max_done FROM mission_steps WHERE run_id = $1 AND status = 'done'`,
    [runId],
  );
  return rows[0]?.max_done != null ? rows[0].max_done + 1 : 1;
}

/**
 * The context a resumed engine needs: which steps finished and what came of
 * them, so it continues from step K instead of redoing the mission. Plain
 * words — this rides on the wire like the planning contract.
 */
export async function buildResumePreamble(db: Db, runId: string, fromStep: number): Promise<string> {
  const steps = await getMissionSteps(db, runId);
  const done = steps.filter((s) => s.status === 'done');
  const lines = done.map(
    (s) => `- Step ${s.seq}/${s.total} done: ${s.resultSummary || s.label}`,
  );
  return (
    `[You are RESUMING an interrupted mission — the server restarted while it was running. ` +
    `Do not redo finished steps; their results are below. Continue from step ${fromStep}.\n` +
    (lines.length > 0 ? `Finished steps:\n${lines.join('\n')}\n` : `No steps had finished yet.\n`) +
    `]\n\n`
  );
}

/**
 * Crash-resume triage for one orphaned run. Returns 'resume' when the run has
 * finished steps worth continuing (young enough to matter), 'fail' otherwise.
 * The 24h cutoff: a day-old partial mission is stale context, and resuming it
 * would confuse more than it saves.
 */
export function triageOrphan(doneSteps: number, startedAt: Date | string): 'resume' | 'fail' {
  const ageMs = Date.now() - new Date(startedAt).getTime();
  if (doneSteps > 0 && ageMs < 24 * 3600_000) return 'resume';
  return 'fail';
}

/**
 * Token-budget guard. The engine reports exact token counts only at the end,
 * so mid-run the executor watches a proxy: streamed characters / 4. Rough,
 * but a rough cap that pauses is better than an exact bill with no cap.
 * Returns true when the budget is spent.
 */
export function isTokenBudgetSpent(streamedChars: number, tokenBudget: number | null): boolean {
  if (tokenBudget == null || tokenBudget <= 0) return false;
  return streamedChars / 4 >= tokenBudget;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}
