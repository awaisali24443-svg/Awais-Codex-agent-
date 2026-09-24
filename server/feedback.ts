/**
 * What the operator thought of an answer.
 *
 * The research on this is unanimous about the shape and the reasons:
 *
 *   * the rating must be one click and inline — a form that opens a modal
 *     "kills response rate";
 *   * the *reason* is asked for only on a bad rating, and from a short closed
 *     list, because "pre-defined categories are faster than open text" and
 *     because a countable reason is the only kind that can be acted on;
 *   * a few words of free text after that, for the cases the codes do not fit;
 *   * the data lives in its own table with the message and run it belongs to,
 *     "not columns bolted onto the message", so it can be read back as a set;
 *   * and it has to be visible to the person who gave it — "if you ask for it
 *     and nothing visibly improves, users stop giving it".
 *
 * So: one row per message, replaced when he changes his mind, with a closed set
 * of reasons that this file owns so the route and the UI cannot drift apart.
 */
import type { Db } from './db.js';

/** The closed list. Ids travel over the wire; labels are for people. */
export const FEEDBACK_REASONS = [
  { id: 'wrong', label: 'Wrong information' },
  { id: 'off_topic', label: 'Not what I asked for' },
  { id: 'too_long', label: 'Too long or too vague' },
  { id: 'broken', label: 'Something was broken' },
  { id: 'other', label: 'Something else' },
] as const;

export type FeedbackRating = 'up' | 'down';

export interface StoredFeedback {
  messageId: string;
  runId: string | null;
  rating: FeedbackRating;
  reason: string | null;
  note: string | null;
  updatedAt: string;
}

export type SaveFeedbackResult =
  | { ok: true; feedback: StoredFeedback }
  | { ok: false; reason: 'not_found' | 'invalid' | 'missing_rating'; message: string };

const REASON_IDS: Set<string> = new Set(FEEDBACK_REASONS.map((r) => r.id));
const NOTE_LIMIT = 500;

/** A reason code is only meaningful for a bad rating, and must be a known one. */
export function normaliseReason(rating: FeedbackRating, raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const value = String(raw).trim();
  if (rating === 'up') {
    return { ok: false, message: 'A reason belongs to a thumbs-down — a good rating needs none.' };
  }
  if (!REASON_IDS.has(value)) {
    return { ok: false, message: `Unknown reason "${value}".` };
  }
  return { ok: true, value };
}

/** The free-text note, trimmed, capped, and empty strings treated as absent. */
export function normaliseNote(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const value = String(raw).replace(/\s+/g, ' ').trim();
  if (!value) return { ok: true, value: null };
  if (value.length > NOTE_LIMIT) {
    return { ok: false, message: `Keep it under ${NOTE_LIMIT} characters.` };
  }
  return { ok: true, value };
}

function rowToFeedback(row: Record<string, unknown>): StoredFeedback {
  return {
    messageId: String(row.message_id),
    runId: row.run_id ? String(row.run_id) : null,
    rating: row.rating === 'up' ? 'up' : 'down',
    reason: row.reason ? String(row.reason) : null,
    note: row.note ? String(row.note) : null,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/**
 * Record a rating, replacing whatever was there.
 *
 * The message has to exist: a rating against a message nobody can read is not
 * feedback, it is a bug with a database row attached to it.
 */
export async function saveFeedback(
  db: Db,
  input: { messageId: string; rating: unknown; reason?: unknown; note?: unknown },
): Promise<SaveFeedbackResult> {
  const rating = String(input.rating ?? '').trim();
  if (rating !== 'up' && rating !== 'down') {
    return { ok: false, reason: 'missing_rating', message: 'A rating must be thumbs-up or thumbs-down.' };
  }

  const reason = normaliseReason(rating, input.reason);
  if (!reason.ok) return { ok: false, reason: 'invalid', message: reason.message };
  const note = normaliseNote(input.note);
  if (!note.ok) return { ok: false, reason: 'invalid', message: note.message };

  const existing = await db.query<{ id: string; run_id: string | null }>(
    `SELECT id, run_id FROM messages WHERE id = $1`,
    [input.messageId],
  );
  if (existing.length === 0) {
    return { ok: false, reason: 'not_found', message: 'That message is not here any more.' };
  }
  const runId = existing[0].run_id ?? null;

  const saved = await db.query(
    `INSERT INTO message_feedback (message_id, run_id, rating, reason, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_id) DO UPDATE
       SET rating = EXCLUDED.rating,
           reason = EXCLUDED.reason,
           note = EXCLUDED.note,
           run_id = EXCLUDED.run_id,
           updated_at = now()
     RETURNING message_id, run_id, rating, reason, note, updated_at`,
    [input.messageId, runId, rating, reason.value, note.value],
  );

  return { ok: true, feedback: rowToFeedback(saved[0]) };
}

/**
 * The answer a run produced, if it has been stored yet.
 *
 * The live card knows its run id, not the row id — the message is written when
 * the run closes, and the operator may well tap the thumb before the app has
 * fetched the thread again. Resolving it here means the rating is about the
 * answer either way, and shows up on the stored message when it is reopened.
 */
export async function assistantMessageIdForRun(db: Db, runId: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE run_id = $1 AND role = 'assistant'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [runId],
  );
  return rows[0]?.id ?? null;
}

/** Take a rating back — the operator tapped the thumb he had already tapped. */
export async function clearFeedback(db: Db, messageId: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM message_feedback WHERE message_id = $1 RETURNING message_id`, [messageId]);
  return result.length > 0;
}

/**
 * The ratings for a set of messages, keyed by message id.
 *
 * Used when a conversation is reopened: the thumbs have to show what he already
 * said, or the app is asking the same question twice.
 */
export async function feedbackForMessages(db: Db, messageIds: string[]): Promise<Map<string, StoredFeedback>> {
  const ids = (messageIds ?? []).filter((id) => typeof id === 'string' && id);
  const map = new Map<string, StoredFeedback>();
  if (ids.length === 0) return map;

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const result = await db.query(
    `SELECT message_id, run_id, rating, reason, note, updated_at
       FROM message_feedback WHERE message_id IN (${placeholders})`,
    ids,
  );
  for (const row of result) {
    const feedback = rowToFeedback(row);
    map.set(feedback.messageId, feedback);
  }
  return map;
}

export interface FeedbackSummary {
  up: number;
  down: number;
  recent: Array<{
    messageId: string;
    runId: string | null;
    rating: FeedbackRating;
    reason: string | null;
    reasonLabel: string | null;
    note: string | null;
    task: string | null;
    updatedAt: string;
  }>;
}

/**
 * What he has said, and about what.
 *
 * This exists because collecting feedback and never showing it back is how a
 * feedback button becomes furniture. It answers one question — "which of my
 * tasks disappointed me?" — with the task's own words attached.
 */
export async function feedbackSummary(db: Db, limit = 5): Promise<FeedbackSummary> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const counts = await db.query<{ rating: string; n: string }>(
    `SELECT rating, count(*)::text AS n FROM message_feedback GROUP BY rating`,
  );
  let up = 0;
  let down = 0;
  for (const row of counts) {
    if (row.rating === 'up') up = Number(row.n) || 0;
    else if (row.rating === 'down') down = Number(row.n) || 0;
  }

  const recent = await db.query(
    `SELECT f.message_id, f.run_id, f.rating, f.reason, f.note, f.updated_at, r.prompt
       FROM message_feedback f
       LEFT JOIN runs r ON r.id = f.run_id
      ORDER BY f.updated_at DESC
      LIMIT $1`,
    [capped],
  );

  const labelFor = (id: string | null) => FEEDBACK_REASONS.find((r) => r.id === id)?.label ?? null;

  return {
    up,
    down,
    recent: recent.map((row) => ({
      messageId: String(row.message_id),
      runId: row.run_id ? String(row.run_id) : null,
      rating: row.rating === 'up' ? 'up' : 'down',
      reason: row.reason ? String(row.reason) : null,
      reasonLabel: labelFor(row.reason ? String(row.reason) : null),
      note: row.note ? String(row.note) : null,
      task: row.prompt ? String(row.prompt).replace(/\s+/g, ' ').slice(0, 120) : null,
      updatedAt: new Date(row.updated_at as string).toISOString(),
    })),
  };
}
