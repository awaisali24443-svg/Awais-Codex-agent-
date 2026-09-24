-- Pinned artifacts: a file the operator asked to keep.
--
-- Why the bytes live in Postgres rather than on disk: the web service's disk is
-- ephemeral (a deploy wipes it) and the sandbox an artifact came from expires on
-- its own schedule. The one piece of durable storage this deployment already has
-- is the database, so "Keep" writes the bytes there — no object store, no new
-- credential, and it survives both a redeploy and an expired sandbox.
--
-- Size is capped in code (PINNED_MAX_BYTES) because the free tier's Postgres is
-- 0.5 GB for everything; pinning is for documents and build outputs, not media
-- libraries.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

CREATE TABLE IF NOT EXISTS artifact_blobs (
  artifact_id text PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  bytes       bytea NOT NULL,
  mime        text,
  size        bigint NOT NULL,
  sha256      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
