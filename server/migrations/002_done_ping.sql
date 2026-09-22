-- Opt-in WhatsApp "done" ping for web-started runs.
-- Set at run creation; the executor's terminal hook reads it, never the poller.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS notify_whatsapp boolean NOT NULL DEFAULT false;
