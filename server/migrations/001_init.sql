-- 001_init.sql — Awais Codex v2 core schema
--
-- Target: PostgreSQL (Neon free tier, and PGlite for tests/CI).
-- Conventions:
--   * text ids generated in application code (no extension dependency)
--   * timestamptz everywhere
--   * jsonb for open-ended payloads
--   * run_events is append-only; retention is handled by pruneRunEvents()

-- ---------------------------------------------------------------------------
-- migration bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- conversations & runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id         text PRIMARY KEY,
  title      text NOT NULL,
  source     text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'whatsapp', 'api')),
  pinned     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id                      text PRIMARY KEY,
  conversation_id         text REFERENCES conversations(id) ON DELETE SET NULL,
  kind                    text NOT NULL CHECK (kind IN ('chat', 'whatsapp', 'api')),
  prompt                  text NOT NULL,
  status                  text NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  engine                  text NOT NULL,
  environment_id          text,
  interaction_id          text,
  previous_interaction_id text,
  error_type              text,
  error_message           text,
  tokens_in               integer,
  tokens_out              integer,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz
);

-- Only in-flight runs are ever scanned on boot (orphan recovery), so index just those.
CREATE INDEX IF NOT EXISTS runs_inflight_idx
  ON runs (status, started_at)
  WHERE status IN ('running', 'paused');

CREATE INDEX IF NOT EXISTS runs_conversation_idx
  ON runs (conversation_id, started_at DESC);

-- Enforces the "one mission at a time" quota rule at the database level.
-- A partial unique index on a constant expression allows at most one active row.
CREATE UNIQUE INDEX IF NOT EXISTS runs_single_active_idx
  ON runs ((true))
  WHERE status IN ('queued', 'running', 'paused');

-- ---------------------------------------------------------------------------
-- run_events — the replayable event log (source of truth for the UI)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_events (
  run_id  text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq     integer NOT NULL,
  type    text NOT NULL,
  payload jsonb NOT NULL,
  at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

-- Retention sweeps delete by age, not by run.
CREATE INDEX IF NOT EXISTS run_events_at_idx ON run_events (at);

-- ---------------------------------------------------------------------------
-- messages / artifacts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id          text REFERENCES runs(id) ON DELETE SET NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id           text PRIMARY KEY,
  run_id       text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name         text NOT NULL,
  path         text,
  mime         text,
  size         bigint,
  sha256       text,
  storage_key  text,
  wa_media_id  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id);

-- ---------------------------------------------------------------------------
-- persistent memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id               text PRIMARY KEY,
  category         text NOT NULL CHECK (category IN ('preference', 'fact', 'project', 'instruction', 'learning')),
  key              text,
  content          text NOT NULL,
  source           text NOT NULL DEFAULT 'auto_extracted'
                     CHECK (source IN ('web', 'whatsapp', 'manual', 'auto_extracted')),
  tags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  access_count     integer NOT NULL DEFAULT 0,
  last_recalled_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Dedup rule from v1: same key OR identical content.
CREATE UNIQUE INDEX IF NOT EXISTS memories_key_uniq
  ON memories (lower(key)) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS memories_content_uniq
  ON memories (lower(content));

-- Single-row profile table.
CREATE TABLE IF NOT EXISTS memory_profile (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name                text,
  role                text,
  preferred_language  text,
  preferred_frameworks jsonb NOT NULL DEFAULT '[]'::jsonb,
  environment         text,
  custom_directives   jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- quota accounting — enforced, not decorative
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  day    date NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('web', 'whatsapp', 'api', 'engine')),
  count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);

-- ---------------------------------------------------------------------------
-- WhatsApp Agent Platform state
-- ---------------------------------------------------------------------------
-- The poll cursor. bigint because the platform says so: 64-bit signed, never computed locally.
-- Named poll_offset, not "offset": OFFSET is a reserved word in Postgres.
CREATE TABLE IF NOT EXISTS wa_state (
  agent_id    text PRIMARY KEY,
  poll_offset bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- wamid UNIQUE is the idempotency backbone: replaying an offset can never
-- execute the same task twice, no matter how the poll cursor is manipulated.
CREATE TABLE IF NOT EXISTS wa_updates (
  wamid        text PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  run_id       text REFERENCES runs(id) ON DELETE SET NULL,
  error        text
);

CREATE INDEX IF NOT EXISTS wa_updates_recent_idx ON wa_updates (received_at DESC);
CREATE INDEX IF NOT EXISTS wa_updates_unprocessed_idx
  ON wa_updates (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- settings & secrets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- AES-256-GCM ciphertext, base64. Never returned by the API.
CREATE TABLE IF NOT EXISTS secrets (
  name       text PRIMARY KEY,
  ciphertext text NOT NULL,
  iv         text NOT NULL,
  tag        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
