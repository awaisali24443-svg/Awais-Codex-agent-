-- 009_mission_steps.sql — durable, cost-capped missions.
--
-- Why this exists: a mission that dies mid-stream (deploy, crash, Render
-- sleep) used to be unrecoverable — main.ts marked it failed and the work
-- was gone. Now every "Step k/N" announcement the agent makes is checkpointed
-- here, so a restart resumes from the last completed step instead of dying.
-- token_budget on runs is the per-mission cost cap: the executor watches a
-- token proxy as the answer streams and pauses the mission when it is spent.

CREATE TABLE IF NOT EXISTS mission_steps (
  id             text PRIMARY KEY,
  run_id         text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  total          integer NOT NULL,
  label          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'doing', 'done', 'failed', 'skipped')),
  result_summary text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS mission_steps_run_idx ON mission_steps (run_id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_budget integer;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS resume_from_step integer;
