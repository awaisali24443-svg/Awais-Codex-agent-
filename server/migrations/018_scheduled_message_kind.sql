-- Message-only scheduled tasks: a schedule whose kind is 'message' never runs
-- the agent. When it fires it just sends the prompt text to WhatsApp as a
-- direct send — zero runs created, zero daily budget touched.
ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task'
  CHECK (kind IN ('task', 'message'));
