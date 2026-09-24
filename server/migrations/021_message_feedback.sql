-- 021_message_feedback.sql — what the operator said about an answer.
--
-- A rating is not a column on `messages`: it is a fact about a message, but it
-- arrives later, is written by a different action, and is read by a different
-- question ("which answers disappointed him?") than the message itself. One row
-- per message — there is one operator here, and the newest opinion is the one
-- that counts — and the row is updated in place when he changes his mind.
--
-- `reason` is a short code from a closed list (server/feedback.ts owns the
-- list), so the reasons are countable. `note` is the optional sentence for the
-- cases the codes do not cover.
CREATE TABLE IF NOT EXISTS message_feedback (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  run_id     text REFERENCES runs(id) ON DELETE SET NULL,
  rating     text NOT NULL CHECK (rating IN ('up', 'down')),
  reason     text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_feedback_run_idx ON message_feedback (run_id);
CREATE INDEX IF NOT EXISTS message_feedback_rating_idx ON message_feedback (rating, updated_at DESC);
