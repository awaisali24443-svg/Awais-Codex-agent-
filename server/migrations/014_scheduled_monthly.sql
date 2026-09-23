-- Scheduled tasks: monthly cadence. Day-of-month is capped at 28 so every
-- month has the day (no February edge cases, no skipped months).
ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS day_of_month integer NULL
    CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28);
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_cadence_check;
ALTER TABLE scheduled_tasks
  ADD CONSTRAINT scheduled_tasks_cadence_check
    CHECK (cadence IN ('interval', 'daily', 'weekly', 'monthly'));
