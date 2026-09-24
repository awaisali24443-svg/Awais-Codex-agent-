-- 023_run_direction.sql — a page is built in a direction the operator can see
-- and change before a single file exists.
--
-- The direction used to be picked inside the executor, invisibly, from the
-- brief — so the plan the operator approved said nothing about the look of the
-- page they were about to get. It is now proposed on the plan card (the chosen
-- direction plus three alternates and "let WAIS choose") and stored here when
-- the operator answers, so the choice outranks the automatic pick and survives
-- the approval: the plan and the build cannot disagree.
--
-- NULL means "nobody chose", which is the ordinary case for a task that is not
-- building a UI at all, and for every run accepted before this column existed.
-- The executor then falls back to what the brief points at.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS direction text;
