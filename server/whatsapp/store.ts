/**
 * Durable state for the WhatsApp poller.
 *
 * Two tables, two jobs:
 *
 *   wa_state    the poll cursor, per agent. Advanced only after a batch has
 *               been handled, so a crash re-reads rather than skips.
 *   wa_updates  one row per inbound wamid — the idempotency backbone. Replaying
 *               an offset can therefore never execute the same task twice, no
 *               matter how the cursor is manipulated, restarted or reset.
 *
 * The three columns that matter on `wa_updates` are `run_id` (a task was
 * started for this message), `processed_at` (we are completely done with it)
 * and `error`. The split between the first two is what makes the recovery path
 * work: a message whose run exists but whose reply never went out is
 * *resumed*, not re-run.
 */
import type { Db } from '../db.js';
import type { InboundMessage } from './api.js';

export interface Cursor {
  agentId: string;
  offset: number;
}

export interface RecordedMessage {
  /** False when this wamid was already in the table — a replay, not new work. */
  fresh: boolean;
  runId: string | null;
  processedAt: string | null;
}

/**
 * The stored cursor. There is normally exactly one agent, so the newest row is
 * the cursor; keeping it keyed by agent id means a token swapped to a different
 * agent starts cleanly instead of resuming someone else's sequence.
 */
export async function loadCursor(db: Db): Promise<Cursor | null> {
  const rows = await db.query<{ agent_id: string; poll_offset: string | number }>(
    `SELECT agent_id, poll_offset FROM wa_state ORDER BY updated_at DESC LIMIT 1`,
  );
  if (!rows[0]) return null;
  return { agentId: rows[0].agent_id, offset: Number(rows[0].poll_offset) };
}

/**
 * Store the cursor. `next_offset` is always the platform's own value, never a
 * computed one: it is a 64-bit signed sequence shared by messages and receipts,
 * and any arithmetic on our side is how a poll starts skipping entries.
 */
export async function saveCursor(db: Db, agentId: string, offset: number): Promise<void> {
  await db.query(
    `INSERT INTO wa_state (agent_id, poll_offset, updated_at)
          VALUES ($1, $2, now())
     ON CONFLICT (agent_id)
     DO UPDATE SET poll_offset = $2, updated_at = now()`,
    [agentId, offset],
  );
}

/** Insert-once. A row that already existed means this message is a replay. */
export async function recordMessage(db: Db, message: InboundMessage): Promise<RecordedMessage> {
  const inserted = await db.query<{ wamid: string }>(
    `INSERT INTO wa_updates (wamid, kind, payload)
          VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (wamid) DO NOTHING
      RETURNING wamid`,
    [message.id, message.type === 'text' ? 'text' : message.type, JSON.stringify(message)],
  );

  if (inserted.length > 0) {
    return { fresh: true, runId: null, processedAt: null };
  }

  const rows = await db.query<{ run_id: string | null; processed_at: Date | string | null }>(
    `SELECT run_id, processed_at FROM wa_updates WHERE wamid = $1`,
    [message.id],
  );
  const row = rows[0];
  return {
    fresh: false,
    runId: row?.run_id ?? null,
    processedAt: row?.processed_at ? new Date(row.processed_at).toISOString() : null,
  };
}

/**
 * Bind the run to the message as soon as it exists — before any reply is
 * attempted. If the process dies between here and the reply, the retry finds
 * `run_id` set and resumes instead of starting a second task.
 */
export async function attachRun(db: Db, wamid: string, runId: string): Promise<void> {
  await db.query(`UPDATE wa_updates SET run_id = $2 WHERE wamid = $1`, [wamid, runId]);
}

/**
 * Record a failure *without* marking the message handled.
 *
 * A reply that could not be delivered leaves the row unprocessed on purpose:
 * the next boot sees it, and the user eventually hears back instead of the
 * message going silently missing.
 */
export async function noteError(db: Db, wamid: string, error: string): Promise<void> {
  await db.query(`UPDATE wa_updates SET error = $2 WHERE wamid = $1`, [wamid, error]);
}

/** We are done with this message: it will never be handled again. */
/**
 * How long a handled inbound message is kept.
 *
 * `wa_updates` holds the full payload of every message the platform delivered,
 * and nothing used to delete any of it — on a 0.5 GB free database that is a
 * slow leak with no ceiling. Thirty days is long enough that "what did I send
 * last week" is answerable, and short enough that the table stays small.
 */
export const WA_UPDATE_RETENTION_DAYS = 30;

/**
 * Retention for the message log, batched like the run-event sweep.
 *
 * Only rows that were handled are eligible: an unprocessed row is pending work
 * (boot recovery reads it, reconcile() delivers it), so deleting one would
 * silently drop a message the operator sent.
 */
export async function pruneWaUpdates(
  db: Db,
  keepDays = WA_UPDATE_RETENTION_DAYS,
  batch = 5000,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.query<{ count: string }>(
      `WITH doomed AS (
         SELECT wamid FROM wa_updates
          WHERE processed_at IS NOT NULL
            AND received_at < now() - ($1 || ' days')::interval
          LIMIT $2
       ), deleted AS (
         DELETE FROM wa_updates w USING doomed d WHERE w.wamid = d.wamid RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [String(keepDays), String(batch)],
    );
    const n = Number(rows[0]?.count ?? 0);
    total += n;
    if (n < batch) return total;
  }
}

export async function markProcessed(db: Db, wamid: string, error: string | null = null): Promise<void> {
  await db.query(
    `UPDATE wa_updates SET processed_at = now(), error = $2 WHERE wamid = $1`,
    [wamid, error],
  );
}

/**
 * The phone's conversation thread.
 *
 * Every task you send from WhatsApp lives in one conversation, so a follow-up
 * continues the same sandbox — the agent keeps the project it was midway
 * through building instead of meeting it for the first time. `/new` deliberately
 * bypasses this and starts another conversation.
 */
export async function latestWhatsappConversation(db: Db): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE source = 'whatsapp'
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/** Messages still waiting to be handled — used by /api/status and the boot log. */
export async function countUnprocessed(db: Db): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wa_updates WHERE processed_at IS NULL`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Remember the agent creator's platform id (`user:<id>`, the `from` on inbound
 * messages). This is the only value the platform accepts as an explicit `to`
 * on a proactive send — a phone number is rejected — so the done-ping reads it
 * back from here. Idempotent: every batch re-learns the same id.
 */
export async function saveCreatorId(db: Db, agentId: string, creatorId: string): Promise<void> {
  await db.query(
    `INSERT INTO wa_state (agent_id, poll_offset, creator_id, updated_at)
          VALUES ($1, 0, $2, now())
     ON CONFLICT (agent_id)
     DO UPDATE SET creator_id = $2, updated_at = now()`,
    [agentId, creatorId],
  );
}

/** The newest learned creator id across agents — normally there is exactly one. */
export async function loadCreatorId(db: Db): Promise<string | null> {
  const rows = await db.query<{ creator_id: string | null }>(
    `SELECT creator_id FROM wa_state WHERE creator_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
  );
  return rows[0]?.creator_id ?? null;
}
