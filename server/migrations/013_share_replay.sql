-- 013_share_replay.sql — shareable mission replays.
--
-- A finished run can be shared as a public read-only page via an unguessable
-- link. The token IS the auth (unguessable by construction), so it lives on
-- the run row and the public page is served with no session. Revoking clears
-- it. Postgres unique indexes allow multiple NULLs, so unshared runs (the
-- common case) never collide.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS share_token text;
CREATE UNIQUE INDEX IF NOT EXISTS runs_share_token_idx ON runs (share_token);
