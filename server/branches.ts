/**
 * Conversation branches: Manus-style fork-on-edit.
 *
 * A branch is a slice of a conversation. The 'main' branch has no parent.
 * Forking at message M creates a child branch whose visible messages are the
 * parent branch's messages up to *and including* the message before M, plus
 * the child's own messages. The original M stays in the parent, untouched —
 * the edited replacement is simply the first message of the new branch.
 *
 * Visibility is computed, never copied: one recursive CTE walks the parent
 * chain, and each ancestor contributes only messages at or before its fork
 * point. No duplication, no drift.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';

function newBranchId(): string {
  return `brn_${randomBytes(9).toString('base64url')}`;
}

export interface Branch {
  id: string;
  conversationId: string;
  parentBranchId: string | null;
  forkMessageId: string | null;
  label: string;
  createdAt: string;
}

interface BranchRow {
  id: string;
  conversation_id: string;
  parent_branch_id: string | null;
  fork_message_id: string | null;
  label: string;
  created_at: Date | string;
}

function mapBranch(r: BranchRow): Branch {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    parentBranchId: r.parent_branch_id,
    forkMessageId: r.fork_message_id,
    label: r.label,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** The conversation's 'main' branch, created on demand. Never null. */
export async function ensureMainBranch(db: Db, conversationId: string): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM branches
      WHERE conversation_id = $1 AND parent_branch_id IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [conversationId],
  );
  if (existing[0]) return existing[0].id;
  const id = newBranchId();
  await db.query(
    `INSERT INTO branches (id, conversation_id, label)
     VALUES ($1, $2, 'main')
     ON CONFLICT DO NOTHING`,
    [id, conversationId],
  );
  const again = await db.query<{ id: string }>(
    `SELECT id FROM branches
      WHERE conversation_id = $1 AND parent_branch_id IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [conversationId],
  );
  if (!again[0]) throw new Error('ensureMainBranch: main branch vanished immediately after insert');
  return again[0].id;
}

export async function listBranches(db: Db, conversationId: string): Promise<Branch[]> {
  const rows = await db.query<BranchRow>(
    `SELECT id, conversation_id, parent_branch_id, fork_message_id, label, created_at
       FROM branches WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );
  return rows.map(mapBranch);
}

/**
 * Fork the conversation at a message.
 *
 * The new branch starts *after* the message before M in M's visible chain, so
 * the edited replacement (inserted next, by the run that follows) takes M's
 * place in the new branch's view. M itself stays in the parent, unedited.
 *
 * @throws Error when the message does not belong to the conversation.
 */
export async function forkBranch(db: Db, conversationId: string, messageId: string): Promise<Branch> {
  const msgs = await db.query<{ id: string; branch_id: string }>(
    `SELECT id, branch_id FROM messages WHERE id = $1 AND conversation_id = $2`,
    [messageId, conversationId],
  );
  const msg = msgs[0];
  if (!msg) throw new Error('forkBranch: message not found in this conversation');

  // The message right before M in M's visible chain — the fork starts after it.
  const prev = await db.query<{ id: string }>(
    `WITH RECURSIVE ${chainCte('$1')}
     SELECT m.id FROM messages m JOIN chain c ON m.branch_id = c.id
      WHERE m.conversation_id = $2
        AND ${CHAIN_VISIBLE}
        AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $3)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1`,
    [msg.branch_id, conversationId, messageId],
  );

  const count = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM branches WHERE conversation_id = $1`,
    [conversationId],
  );
  const label = `Branch ${Number(count[0]?.n ?? 0) + 1}`;
  const id = newBranchId();
  await db.query(
    `INSERT INTO branches (id, conversation_id, parent_branch_id, fork_message_id, label)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, conversationId, msg.branch_id, prev[0]?.id ?? null, label],
  );
  const rows = await db.query<BranchRow>(`SELECT * FROM branches WHERE id = $1`, [id]);
  return mapBranch(rows[0]);
}

/**
 * The recursive visibility CTE shared by message listing and fork cutoffs.
 * Depth 0 is the branch itself (all its messages). Every ancestor carries
 * the fork cutoff the *child* imposed on it — that is the point in the
 * parent's history the child branched off from.
 */
export function chainCte(branchParam: string): string {
  return `chain AS (
    SELECT id, parent_branch_id, NULL::text AS child_fork_id, 0 AS depth
      FROM branches WHERE id = ${branchParam}
    UNION ALL
    SELECT b.id, b.parent_branch_id, child.fork_message_id, c.depth + 1
      FROM branches b
      JOIN chain c ON b.id = c.parent_branch_id
      JOIN branches child ON child.id = c.id
  )`;
}

/** Row predicate: which messages of the chain are visible in the branch. */
export const CHAIN_VISIBLE = `(c.depth = 0
  OR (c.child_fork_id IS NOT NULL
      AND (m.created_at, m.id) <= (SELECT created_at, id FROM messages WHERE id = c.child_fork_id)))`;
