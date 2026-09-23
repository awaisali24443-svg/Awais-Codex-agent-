-- 010_plan_preview.sql — plan preview before execution.
--
-- A complex web mission now pauses in 'awaiting_plan' after a planning pass:
-- the engine's step-by-step plan is stored on the run as plan_json, the
-- operator reviews it in the web UI (Approve / Edit), and only the approval
-- lets the mission execute. The pre-execution state holds the single-active
-- slot like any other in-flight run — a plan waiting for approval is still a
-- mission in flight, so two missions can never overlap.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS plan_json jsonb;

-- The status CHECK constraint predates the new pre-execution state.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('queued', 'running', 'paused', 'awaiting_plan',
                    'completed', 'failed', 'cancelled'));

-- The predicate of a partial index cannot be altered; recreate it.
DROP INDEX IF EXISTS runs_single_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS runs_single_active_idx
  ON runs ((true))
  WHERE status IN ('queued', 'running', 'paused', 'awaiting_plan');
