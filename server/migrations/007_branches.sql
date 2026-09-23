-- 007_branches.sql — Manus-style conversation branches.
--
-- Editing an old message forks the conversation: the original stays untouched
-- in its branch, and the edited prompt starts a new branch whose view is the
-- parent branch's messages up to the fork point plus the new branch's own.
-- A branch with no parent is the conversation's 'main' branch.

CREATE TABLE IF NOT EXISTS branches (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_branch_id text REFERENCES branches(id) ON DELETE CASCADE,
  -- The parent-branch message the fork starts *after*. NULL means the fork
  -- starts at the very beginning (used when the first message is edited).
  fork_message_id  text REFERENCES messages(id) ON DELETE SET NULL,
  label            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS branches_conversation_idx
  ON branches (conversation_id, created_at);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS branch_id text REFERENCES branches(id) ON DELETE CASCADE;

-- Every existing conversation gets one 'main' branch; its messages belong to it.
DO $$
DECLARE
  c RECORD;
  b text;
BEGIN
  FOR c IN SELECT id FROM conversations LOOP
    b := 'brn_' || substr(md5(c.id), 1, 12);
    INSERT INTO branches (id, conversation_id, label)
    VALUES (b, c.id, 'main')
    ON CONFLICT (id) DO NOTHING;
    UPDATE messages SET branch_id = b
     WHERE conversation_id = c.id AND branch_id IS NULL;
  END LOOP;
END $$;

ALTER TABLE messages ALTER COLUMN branch_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS messages_branch_idx
  ON messages (branch_id, created_at);
