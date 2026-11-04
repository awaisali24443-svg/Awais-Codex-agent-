-- 024_conversation_queue.sql — per-conversation message queue.
--
-- A message sent to a conversation that already has a run in flight is no
-- longer refused: it waits, and starts automatically when the current run
-- completes. The waiting state must NOT hold the single-active slot, or the
-- queue could never exist — the run it waits for occupies that slot. So
-- 'waiting' joins the status CHECK but is deliberately kept OUT of the
-- runs_single_active_idx predicate: a waiting run is not an active run.
-- Promotion (waiting -> queued) is what takes the slot, and the index is
-- what makes that promotion safe against races.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('queued', 'planning', 'running', 'paused', 'awaiting_plan',
                    'waiting', 'completed', 'failed', 'cancelled'));

-- runs_single_active_idx intentionally unchanged: its predicate
-- ('queued', 'planning', 'running', 'paused', 'awaiting_plan') already
-- excludes 'waiting', which is the whole design.
