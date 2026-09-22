-- Deep-research mode: time-boxed, multi-pass research missions.
-- Set at run creation; the executor reads it to chain engine passes on the
-- same mission until the wall-clock budget is spent, then synthesises.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS deep_research boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS research_budget_minutes integer;
