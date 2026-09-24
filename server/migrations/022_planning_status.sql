-- 022_planning_status.sql — the planning pass is a visible state, not a hang.
--
-- The root cause of "a couple of minutes with no live stream": a complex web
-- task made the *accepting* request wait for a separate, non-streamed planning
-- call (up to 60s, abort-after), and only then did the run start and the client
-- attach to the stream. During that minute nothing existed to watch.
--
-- The pass now runs in the background under its own status, so the client
-- attaches immediately and the planning itself is streamed (steps appearing as
-- the model announces them, the engine's own heartbeat while it is silent).
-- 'planning' therefore has to be a real status, and it holds the single-active
-- slot exactly like 'queued' and 'awaiting_plan' do.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('queued', 'planning', 'running', 'paused', 'awaiting_plan',
                    'completed', 'failed', 'cancelled'));

-- The predicate of a partial index cannot be altered; recreate it. Without this
-- line a second task could be accepted while the first was still planning.
DROP INDEX IF EXISTS runs_single_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS runs_single_active_idx
  ON runs ((true))
  WHERE status IN ('queued', 'planning', 'running', 'paused', 'awaiting_plan');
