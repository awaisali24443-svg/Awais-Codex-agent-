-- 024_run_queue.sql — the second ask waits its turn.
--
-- The guard that keeps one task in flight exists for a real reason: there is one
-- API key, one daily allowance and one agent, so two tasks running at once would
-- race for the same quota. But the answer used to be a refusal — "another task
-- is already running" — which is a dead end for the operator: the thought is
-- gone by the time the current task ends.
--
-- 'waiting' is therefore a real status: the ask is accepted, recorded, charged
-- to the day, and parked in line. The next one starts when the slot frees.
--
-- Two properties matter, and both are enforced here rather than in application
-- code:
--
--   1. 'waiting' is NOT part of the single-active predicate. Any number of
--      tasks may wait; exactly one may hold the slot.
--   2. The line is read oldest-first, so waiting runs are ordered by
--      `started_at` at insert time. Promotion rewrites `started_at` to the
--      moment the task actually began, which is what the run timer reports:
--      time spent waiting is not time spent working.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('queued', 'waiting', 'planning', 'running', 'paused', 'awaiting_plan',
                    'completed', 'failed', 'cancelled'));

-- The predicate of a partial index cannot be altered; recreate it without
-- 'waiting', or the first queued task would block the second from queueing.
DROP INDEX IF EXISTS runs_single_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS runs_single_active_idx
  ON runs ((true))
  WHERE status IN ('queued', 'planning', 'running', 'paused', 'awaiting_plan');

-- The line is always read the same way — oldest waiting run first — so index it
-- the way it is read.
CREATE INDEX IF NOT EXISTS runs_waiting_idx
  ON runs (started_at)
  WHERE status = 'waiting';
