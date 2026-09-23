-- Scheduled tasks: recurring jobs. The firing scheduler only runs when
-- SCHEDULER_ENABLED=true (default on), and each fire goes through the normal
-- acceptance path (one run at a time, daily budget), so a busy agent or a
-- spent budget just defers the task to the next tick instead of failing it.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id text PRIMARY KEY,
  name text NOT NULL,
  prompt text NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('interval', 'daily', 'weekly')),
  interval_minutes integer NULL
    CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 5 AND 10080),
  time_of_day text NULL
    CHECK (time_of_day IS NULL OR time_of_day ~ '^[0-2][0-9]:[0-5][0-9]$'),
  weekday integer NULL CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  timezone text NOT NULL DEFAULT 'Asia/Karachi',
  deliver text NOT NULL DEFAULT 'web' CHECK (deliver IN ('web', 'whatsapp')),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz NULL,
  last_run_id text NULL REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks (enabled, next_run_at);
