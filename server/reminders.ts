/**
 * Reminders — opt-in scheduled tasks.
 *
 * A reminder is a row, not an alarm: `text` plus `run_at`. Nothing fires unless
 * the process was started with REMINDERS_ENABLED=true, and even then firing is
 * a normal run through the same acceptance path as everything else (one at a
 * time, daily budget, kind 'api'). The two-phase claim (`pending` → `claimed`
 * → `fired`) means a crash between claiming and starting leaves rows that the
 * next tick picks up again instead of reminders that silently never fire — or
 * worse, fire twice.
 */
import type { Db } from './db.js';
import { newId } from './runs.js';

export type ReminderStatus = 'pending' | 'claimed' | 'fired' | 'cancelled';

export interface Reminder {
  id: string;
  text: string;
  runAt: string;
  status: ReminderStatus;
  runId: string | null;
  createdAt: string;
}

interface ReminderRow {
  id: string;
  text: string;
  run_at: Date | string;
  status: ReminderStatus;
  run_id: string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    text: row.text,
    runAt: toIso(row.run_at),
    status: row.status,
    runId: row.run_id,
    createdAt: toIso(row.created_at),
  };
}

export const MAX_REMINDER_CHARS = 500;

export async function createReminder(db: Db, text: string, runAt: Date): Promise<Reminder> {
  const clean = text.trim();
  if (!clean) throw new Error('createReminder: text is empty');
  if (clean.length > MAX_REMINDER_CHARS) {
    throw new Error(`createReminder: text is ${clean.length} chars; the limit is ${MAX_REMINDER_CHARS}`);
  }
  if (Number.isNaN(runAt.getTime())) throw new Error('createReminder: runAt is not a date');
  if (runAt.getTime() <= Date.now()) throw new Error('createReminder: runAt is in the past');

  const id = newId('rem');
  await db.query(
    `INSERT INTO reminders (id, text, run_at, status) VALUES ($1, $2, $3, 'pending')`,
    [id, clean, runAt.toISOString()],
  );
  const rows = await db.query<ReminderRow>(`SELECT * FROM reminders WHERE id = $1`, [id]);
  return mapReminder(rows[0]);
}

export async function listReminders(db: Db, includeTerminal = false): Promise<Reminder[]> {
  const rows = await db.query<ReminderRow>(
    `SELECT * FROM reminders
      WHERE $1 OR status IN ('pending', 'claimed')
      ORDER BY run_at ASC
      LIMIT 100`,
    [includeTerminal],
  );
  return rows.map(mapReminder);
}

export async function cancelReminder(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE reminders SET status = 'cancelled'
      WHERE id = $1 AND status IN ('pending', 'claimed')
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Atomically claim due reminders. `FOR UPDATE SKIP LOCKED` keeps two
 * schedulers (there is only ever one, but cheap to be safe) from claiming the
 * same row.
 */
export async function claimDueReminders(db: Db, limit = 5): Promise<Reminder[]> {
  const rows = await db.query<ReminderRow>(
    `UPDATE reminders SET status = 'claimed'
      WHERE id IN (
        SELECT id FROM reminders
         WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
  return rows.map(mapReminder);
}

/** The reminder fired as this run. */
export async function markReminderFired(db: Db, id: string, runId: string): Promise<void> {
  await db.query(`UPDATE reminders SET status = 'fired', run_id = $2 WHERE id = $1`, [id, runId]);
}

/** The run could not start (budget spent, another task active): try next tick. */
export async function releaseReminder(db: Db, id: string): Promise<void> {
  await db.query(
    `UPDATE reminders SET status = 'pending' WHERE id = $1 AND status = 'claimed'`,
    [id],
  );
}
