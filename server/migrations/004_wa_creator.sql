-- Learn the agent creator's platform id from inbound traffic.
-- The platform addresses the agent's single recipient as `user:<id>`; a phone
-- number is not a valid `to`. The poller records it here on every batch so the
-- done-ping can address a proactive message without an inbound message to reply to.
ALTER TABLE wa_state ADD COLUMN IF NOT EXISTS creator_id text;
