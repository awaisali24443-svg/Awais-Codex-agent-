-- 011_verification.sql — prove-it's-done results on the run.
--
-- Before a mission is marked done, the executor re-checks the output against
-- the durable record (answer produced, all steps done, announced files
-- recorded). The per-check results land here as JSON so the finish card can
-- show the proof lines; null means the mission had nothing checkable and
-- verification was skipped.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS verification_json jsonb;
