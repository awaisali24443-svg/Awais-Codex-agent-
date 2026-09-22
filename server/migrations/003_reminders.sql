-- Reminders: opt-in scheduled tasks. The firing scheduler only runs when
-- REMINDERS_ENABLED=true (default off), so creating a reminder never makes a
-- sound on its own.
CREATE TABLE IF NOT EXISTS reminders (
  id text PRIMARY KEY,
  text text NOT NULL,
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'fired', 'cancelled')),
  run_id text NULL REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, run_at);
