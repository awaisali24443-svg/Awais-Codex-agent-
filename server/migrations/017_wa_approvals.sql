-- 017_wa_approvals.sql — WhatsApp approval asks for plan previews and LinkedIn drafts.
--
-- When a run enters 'awaiting_plan' or a LinkedIn draft is filed as pending,
-- the owner gets one WhatsApp message asking for approval. A reply of "yes"
-- approves, "no" rejects, anything else is fed back as requested changes —
-- all matched to the open row here, and only when it comes from the owner.
--
-- Anti-spam: the partial unique index means one open ask per item. Claiming
-- the row before sending (like the morning digest claims its day) means a
-- restart or a slow send can never nag twice. An unanswered ask simply waits;
-- resolving it is the only way to close it.

CREATE TABLE IF NOT EXISTS wa_approvals (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('plan', 'linkedin_draft')),
  ref_id      text NOT NULL,
  asked_at    timestamptz NOT NULL DEFAULT now(),
  feedback    text,
  resolved_at timestamptz,
  resolution  text CHECK (resolution IN ('approved', 'rejected', 'stale'))
);

-- One open ask per item: a second ask for the same waiting plan or draft is
-- refused by the database, not by discipline.
CREATE UNIQUE INDEX IF NOT EXISTS wa_approvals_open_idx
  ON wa_approvals (kind, ref_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS wa_approvals_open_asked_idx
  ON wa_approvals (asked_at DESC) WHERE resolved_at IS NULL;
