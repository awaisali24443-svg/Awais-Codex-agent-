-- 008_linkedin.sql — LinkedIn "post as me" integration.
--
-- LinkedIn's self-serve API (Share on LinkedIn, w_member_social) allows
-- posting, commenting and liking as the authenticated member. It does NOT
-- allow editing the profile itself — no API exists for that, for anyone.
-- Member tokens last ~60 days and cannot be refreshed programmatically, so
-- the row tracks expiry and the UI says "reconnect" instead of failing
-- silently.

CREATE TABLE IF NOT EXISTS linkedin_tokens (
  id          text PRIMARY KEY DEFAULT 'default',
  ciphertext  text NOT NULL,
  iv          text NOT NULL,
  tag         text NOT NULL,
  member_urn  text NOT NULL,
  member_name text NOT NULL DEFAULT '',
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Drafts the agent produced (```linkedin-post fenced block in its answer).
-- Nothing is ever published without the operator tapping Publish on a draft.
CREATE TABLE IF NOT EXISTS linkedin_drafts (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'failed')),
  post_urn    text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS linkedin_drafts_run_idx ON linkedin_drafts (run_id);
