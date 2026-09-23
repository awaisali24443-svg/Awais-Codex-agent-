-- Public download links for mission artifacts.
--
-- Mirrors 013_share_replay: the token IS the auth (unguessable by
-- construction), and revoking is setting it back to NULL — the old link 404s
-- immediately. A link texted to the phone (WhatsApp auto-links URLs) downloads
-- the file, which is how a build output like an APK reaches the phone without
-- opening the web UI.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS share_token text;
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_share_token_idx ON artifacts (share_token);
