-- 012_google.sql — Gmail + Calendar (read-only) connectors.
--
-- Google issues refresh tokens (access_type=offline + prompt=consent), so the
-- sealed blob holds both the refresh token and the current access token: a
-- restart never loses the connection, and the access token is refreshed on
-- demand. The operator only reconnects if they revoke access at Google.
-- Scope is deliberately read-only (gmail.readonly, calendar.readonly).

CREATE TABLE IF NOT EXISTS google_tokens (
  id          text PRIMARY KEY DEFAULT 'default',
  ciphertext  text NOT NULL,
  iv          text NOT NULL,
  tag         text NOT NULL,
  member_email text NOT NULL DEFAULT '',
  member_name text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
