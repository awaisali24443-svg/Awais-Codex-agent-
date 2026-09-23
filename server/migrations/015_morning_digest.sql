-- 015_morning_digest.sql — the morning WhatsApp digest's send log.
--
-- One row per Asia/Karachi calendar day the digest was attempted. The send
-- claims its day with INSERT ... ON CONFLICT DO NOTHING before sending, so
-- even a restart between ticks can never produce a second message for the
-- same morning. A failed send still claims the day: one message per morning,
-- never retry spam.
CREATE TABLE IF NOT EXISTS morning_digest_log (
  sent_date date PRIMARY KEY,
  sent_at   timestamptz NOT NULL DEFAULT now()
);
