/**
 * Scheduled tasks — recurring jobs.
 *
 * A task is a row: name + prompt + cadence + where the answer goes. The loop
 * in main.ts (or a `POST /api/scheduled-tasks/tick` from an external cron)
 * claims due tasks and fires each through `acceptRun`, the same path every
 * other channel uses: one run at a time, one daily-budget claim per fire.
 * A task whose kind is 'message' instead sends its prompt as one WhatsApp
 * note — no run, no budget, ever.
 *
 * Claiming is two-phase like reminders: `claimDueTasks` advances `next_run_at`
 * atomically (`FOR UPDATE SKIP LOCKED`), and a fire that cannot start (agent
 * busy, budget spent) pulls `next_run_at` back to five minutes out so the
 * task retries soon instead of waiting a full interval — or silently dying.
 *
 * Free-tier honesty: Render's free plan sleeps the process when idle, so the
 * in-process 60s tick cannot fire while the service is asleep. The `/tick`
 * endpoint exists for exactly that: point a free external cron (cron-job.org)
 * at it every 15 minutes and due tasks fire even overnight. See DEPLOY.md.
 */
import type { Db } from './db.js';
import { newId } from './runs.js';
import { acceptRun, type AcceptDeps } from './accept.js';
import { WhatsAppClient } from './whatsapp/api.js';
import { WhatsAppSender } from './whatsapp/sender.js';
import { resolveRecipient } from './whatsapp/doneping.js';

export type Cadence = 'interval' | 'daily' | 'weekly' | 'monthly';
export type Deliver = 'web' | 'whatsapp';
/**
 * What a fire does. 'task' runs the agent through the normal acceptance path
 * (one run, one daily-budget claim); 'message' just sends the prompt text to
 * WhatsApp — no run, no budget, ever.
 */
export type TaskKind = 'task' | 'message';

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cadence: Cadence;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  weekday: number | null;
  /** Day of the month (1–28) for the monthly cadence. */
  dayOfMonth: number | null;
  timezone: string;
  deliver: Deliver;
  /** 'task' does agent work (costs budget); 'message' just sends a WhatsApp note. */
  kind: TaskKind;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  createdAt: string;
}

export interface CreateTaskInput {
  name: string;
  prompt: string;
  cadence: Cadence;
  intervalMinutes?: number;
  timeOfDay?: string;
  weekday?: number;
  dayOfMonth?: number;
  timezone?: string;
  deliver?: Deliver;
  /** Defaults to 'task'; 'message' sends the prompt as a WhatsApp note. */
  kind?: TaskKind;
}

export const MAX_TASK_NAME_CHARS = 80;
export const MAX_TASK_PROMPT_CHARS = 2000;
export const DEFAULT_TIMEZONE = 'Asia/Karachi';
/** A fire that could not start retries this soon instead of a full interval. */
export const DEFERRED_RETRY_MINUTES = 5;

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  cadence: Cadence;
  interval_minutes: number | null;
  time_of_day: string | null;
  weekday: number | null;
  day_of_month: number | null;
  timezone: string;
  deliver: Deliver;
  kind: TaskKind;
  enabled: boolean;
  next_run_at: Date | string;
  last_run_at: Date | string | null;
  last_run_id: string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cadence: row.cadence,
    intervalMinutes: row.interval_minutes,
    timeOfDay: row.time_of_day,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    timezone: row.timezone,
    deliver: row.deliver,
    kind: row.kind,
    enabled: row.enabled,
    nextRunAt: toIso(row.next_run_at),
    lastRunAt: row.last_run_at ? toIso(row.last_run_at) : null,
    lastRunId: row.last_run_id,
    createdAt: toIso(row.created_at),
  };
}

/* ------------------------------------------------------------ scheduling -- */

/** Offset of a timezone at an instant, in ms. Asia/Karachi has no DST, but
 *  the math stays correct for zones that do. */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Wall-clock time of `date` in `timeZone`, expressed as a UTC-based Date. */
function wallClock(date: Date, timeZone: string): Date {
  return new Date(date.getTime() + tzOffsetMs(timeZone, date));
}

/** Back to a real instant from a wall-clock-as-UTC value. */
function fromWallClock(wallMs: number, timeZone: string): Date {
  return new Date(wallMs - tzOffsetMs(timeZone, new Date(wallMs)));
}

/** Next HH:MM strictly after `from`, in `timeZone`. */
export function nextDaily(from: Date, timeOfDay: string, timeZone: string): Date {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  const wall = wallClock(from, timeZone);
  let target = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
    hh,
    mm,
    0,
    0,
  );
  if (target <= wall.getTime()) target += 86_400_000;
  return fromWallClock(target, timeZone);
}

/** Next `weekday` (0=Sunday) at HH:MM strictly after `from`, in `timeZone`. */
export function nextWeekly(
  from: Date,
  weekday: number,
  timeOfDay: string,
  timeZone: string,
): Date {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  const wall = wallClock(from, timeZone);
  const delta = (weekday - wall.getUTCDay() + 7) % 7;
  let target =
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hh, mm, 0, 0) +
    delta * 86_400_000;
  if (target <= wall.getTime()) target += 7 * 86_400_000;
  return fromWallClock(target, timeZone);
}

export function nextInterval(from: Date, intervalMinutes: number): Date {
  return new Date(from.getTime() + intervalMinutes * 60_000);
}

/**
 * Next day-of-month `dayOfMonth` (1–28) at HH:MM strictly after `from`, in
 * `timeZone`. Capped at 28 so every month has the day — no February edge
 * cases, no skipped months.
 */
export function nextMonthly(
  from: Date,
  dayOfMonth: number,
  timeOfDay: string,
  timeZone: string,
): Date {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  const wall = wallClock(from, timeZone);
  let target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), dayOfMonth, hh, mm, 0, 0);
  if (target <= wall.getTime()) {
    const nextMonth = wall.getUTCMonth() + 1;
    target = Date.UTC(
      wall.getUTCFullYear() + Math.floor(nextMonth / 12),
      nextMonth % 12,
      dayOfMonth,
      hh,
      mm,
      0,
      0,
    );
  }
  return fromWallClock(target, timeZone);
}

export interface CadenceSpec {
  cadence: Cadence;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  weekday: number | null;
  dayOfMonth: number | null;
  timezone: string;
}

/** When a task with this cadence should fire next, strictly after `from`. */
export function computeNextRun(spec: CadenceSpec, from: Date): Date {
  switch (spec.cadence) {
    case 'interval':
      return nextInterval(from, spec.intervalMinutes as number);
    case 'daily':
      return nextDaily(from, spec.timeOfDay as string, spec.timezone);
    case 'weekly':
      return nextWeekly(from, spec.weekday as number, spec.timeOfDay as string, spec.timezone);
    case 'monthly':
      return nextMonthly(
        from,
        spec.dayOfMonth as number,
        spec.timeOfDay as string,
        spec.timezone,
      );
  }
}

/* ------------------------------------------------------------ validation -- */

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`scheduler: unknown timezone "${timezone}"`);
  }
}

export interface NormalizedTaskInput {
  name: string;
  prompt: string;
  cadence: Cadence;
  intervalMinutes: number | null;
  timeOfDay: string | null;
  weekday: number | null;
  dayOfMonth: number | null;
  timezone: string;
  deliver: Deliver;
  kind: TaskKind;
}

export function normalizeTaskInput(input: CreateTaskInput): NormalizedTaskInput {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('scheduler: name is empty');
  if (name.length > MAX_TASK_NAME_CHARS) {
    throw new Error(`scheduler: name is ${name.length} chars; the limit is ${MAX_TASK_NAME_CHARS}`);
  }
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) throw new Error('scheduler: prompt is empty');
  if (prompt.length > MAX_TASK_PROMPT_CHARS) {
    throw new Error(
      `scheduler: prompt is ${prompt.length} chars; the limit is ${MAX_TASK_PROMPT_CHARS}`,
    );
  }
  if (!['interval', 'daily', 'weekly', 'monthly'].includes(input.cadence)) {
    throw new Error('scheduler: cadence must be interval, daily, weekly, or monthly');
  }
  const cadence = input.cadence;
  const timezone = (input.timezone ?? DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  assertValidTimezone(timezone);

  let intervalMinutes: number | null = null;
  let timeOfDay: string | null = null;
  let weekday: number | null = null;
  let dayOfMonth: number | null = null;

  if (cadence === 'interval') {
    const n = input.intervalMinutes;
    if (!Number.isInteger(n) || (n as number) < 5 || (n as number) > 10080) {
      throw new Error('scheduler: intervalMinutes must be a whole number of minutes from 5 to 10080');
    }
    intervalMinutes = n as number;
  } else {
    const t = (input.timeOfDay ?? '').trim();
    if (!TIME_RE.test(t)) throw new Error('scheduler: timeOfDay must be HH:MM in 24-hour time');
    timeOfDay = t;
    if (cadence === 'weekly') {
      const w = input.weekday;
      if (!Number.isInteger(w) || (w as number) < 0 || (w as number) > 6) {
        throw new Error('scheduler: weekday must be 0 (Sunday) through 6 (Saturday)');
      }
      weekday = w as number;
    }
    if (cadence === 'monthly') {
      const d = input.dayOfMonth;
      if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 28) {
        throw new Error('scheduler: dayOfMonth must be a whole day of the month from 1 to 28');
      }
      dayOfMonth = d as number;
    }
  }

  const deliver = input.deliver ?? 'web';
  if (deliver !== 'web' && deliver !== 'whatsapp') {
    throw new Error('scheduler: deliver must be web or whatsapp');
  }

  const kind = input.kind ?? 'task';
  if (kind !== 'task' && kind !== 'message') {
    throw new Error('scheduler: kind must be task or message');
  }

  return { name, prompt, cadence, intervalMinutes, timeOfDay, weekday, dayOfMonth, timezone, deliver, kind };
}

/* ------------------------------------------------------------------ crud -- */

export async function createScheduledTask(db: Db, input: CreateTaskInput): Promise<ScheduledTask> {
  const v = normalizeTaskInput(input);
  const id = newId('sch');
  const nextRunAt = computeNextRun(v, new Date());
  await db.query(
    `INSERT INTO scheduled_tasks
       (id, name, prompt, cadence, interval_minutes, time_of_day, weekday, day_of_month,
        timezone, deliver, kind, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      v.name,
      v.prompt,
      v.cadence,
      v.intervalMinutes,
      v.timeOfDay,
      v.weekday,
      v.dayOfMonth,
      v.timezone,
      v.deliver,
      v.kind,
      nextRunAt.toISOString(),
    ],
  );
  const rows = await db.query<TaskRow>(`SELECT * FROM scheduled_tasks WHERE id = $1`, [id]);
  return mapTask(rows[0]);
}

export async function listScheduledTasks(db: Db): Promise<ScheduledTask[]> {
  const rows = await db.query<TaskRow>(
    `SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC LIMIT 100`,
  );
  return rows.map(mapTask);
}

export async function getScheduledTask(db: Db, id: string): Promise<ScheduledTask | null> {
  const rows = await db.query<TaskRow>(`SELECT * FROM scheduled_tasks WHERE id = $1`, [id]);
  return rows.length ? mapTask(rows[0]) : null;
}

export async function setTaskEnabled(db: Db, id: string, enabled: boolean): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE scheduled_tasks SET enabled = $2 WHERE id = $1 RETURNING id`,
    [id, enabled],
  );
  return rows.length > 0;
}

export async function deleteScheduledTask(db: Db, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`DELETE FROM scheduled_tasks WHERE id = $1 RETURNING id`, [
    id,
  ]);
  return rows.length > 0;
}

/* --------------------------------------------------------------- firing -- */

/**
 * Claim due tasks: atomically advance `next_run_at` so a second scheduler
 * (there is only ever one, but cheap to be safe) cannot claim the same row.
 * Returns the claimed tasks with their pre-claim state.
 */
export async function claimDueTasks(db: Db, limit = 5): Promise<ScheduledTask[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<TaskRow>(
      `SELECT * FROM scheduled_tasks
        WHERE enabled AND next_run_at <= now()
        ORDER BY next_run_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const now = new Date();
    for (const row of rows) {
      const next = computeNextRun(
        {
          cadence: row.cadence,
          intervalMinutes: row.interval_minutes,
          timeOfDay: row.time_of_day,
          weekday: row.weekday,
          dayOfMonth: row.day_of_month,
          timezone: row.timezone,
        },
        now,
      );
      await tx.query(`UPDATE scheduled_tasks SET next_run_at = $2 WHERE id = $1`, [
        row.id,
        next.toISOString(),
      ]);
    }
    return rows.map(mapTask);
  });
}

/** The task fired as this run. */
export async function markTaskFired(db: Db, id: string, runId: string): Promise<void> {
  await db.query(
    `UPDATE scheduled_tasks SET last_run_at = now(), last_run_id = $2 WHERE id = $1`,
    [id, runId],
  );
}

/** A message-only fire: no run exists, so only the time is recorded. */
export async function markMessageFired(db: Db, id: string): Promise<void> {
  await db.query(`UPDATE scheduled_tasks SET last_run_at = now(), last_run_id = NULL WHERE id = $1`, [
    id,
  ]);
}

/** The run could not start (agent busy, budget spent): retry soon, not in a full interval. */
export async function deferTask(db: Db, id: string): Promise<void> {
  const retryAt = new Date(Date.now() + DEFERRED_RETRY_MINUTES * 60_000);
  await db.query(`UPDATE scheduled_tasks SET next_run_at = $2 WHERE id = $1`, [
    id,
    retryAt.toISOString(),
  ]);
}

export interface FireSummary {
  /** runId is '' for message-only fires — they never create a run. */
  fired: { taskId: string; taskName: string; runId: string; kind: TaskKind }[];
  deferred: { taskId: string; taskName: string; reason: string }[];
}

/** Test seam for message-only fires: replaces the WhatsApp HTTP layer. */
export interface FireSeams {
  fetchImpl?: typeof fetch;
}

/** The reminder text, plain: a header naming the schedule, then the note. */
export function composeReminderMessage(task: Pick<ScheduledTask, 'name' | 'prompt'>): string {
  return `⏰ ${task.name}\n\n${task.prompt.trim()}`;
}

/**
 * Fire a message-only schedule: send the reminder text as one WhatsApp
 * message and never create a run or touch the budget.
 *
 * The anti-spam rules, like the morning digest's:
 *
 *   - Silent without a token. No `whatsapp_token` (or no resolvable
 *     recipient) means no message, no error, no throw — and the fire is still
 *     consumed: `next_run_at` was already advanced by the claim, so there is
 *     no retry storm.
 *   - Claimed before sending. The claim in `claimDueTasks` advanced
 *     `next_run_at` atomically, so a restart or redeploy between claim and
 *     send can never double-send the same fire.
 *   - A failed send still consumes the fire. Retrying every 60 seconds until
 *     it works would be notification spam; the next scheduled fire comes on
 *     its own cadence.
 *   - Never throws. The message is decoration next to the agent — a send
 *     failure must not touch anything else in the process.
 */
async function fireMessageTask(
  deps: AcceptDeps & FireSeams,
  task: ScheduledTask,
  summary: FireSummary,
  log: (message: string) => void,
): Promise<void> {
  const { db } = deps;
  const logLine = (message: string): void => {
    log(`[scheduler] ${message}`);
  };
  const done = async (sent: boolean): Promise<void> => {
    await markMessageFired(db, task.id).catch(() => {});
    summary.fired.push({ taskId: task.id, taskName: task.name, runId: '', kind: 'message' });
    log(
      sent
        ? `[scheduler] messaged "${task.name}" on WhatsApp`
        : `[scheduler] "${task.name}" message-only: skipped silently (no WhatsApp token or recipient)`,
    );
  };
  try {
    const secrets = deps.secrets;
    const token = secrets?.get('whatsapp_token') ?? '';
    if (!token || !secrets) {
      await done(false);
      return;
    }
    const to = await resolveRecipient({ db, secrets }, logLine).catch(() => null);
    if (!to) {
      await done(false);
      return;
    }
    const client = new WhatsAppClient({ token, fetchImpl: deps.fetchImpl });
    const sender = new WhatsAppSender(client, logLine);
    const sent = await sender.send(composeReminderMessage(task), { to });
    if (!sent) log(`[scheduler] "${task.name}" message-only send failed: ${sender.error ?? 'unknown'}`);
    await done(sent);
  } catch (err) {
    log(`[scheduler] "${task.name}" message-only fire failed: ${(err as Error).message}`);
    await done(false);
  }
}

/**
 * One tick of the scheduler: claim what is due, fire each through the normal
 * acceptance path. A task whose run cannot start is deferred, never dropped.
 * Message-only schedules bypass the agent entirely: one WhatsApp note, no
 * run, no budget. Never throws — a bad tick must not kill the loop that owns
 * it.
 */
export async function fireDueScheduledTasks(
  deps: AcceptDeps & FireSeams,
  log: (message: string) => void = () => {},
): Promise<FireSummary> {
  const { db } = deps;
  const summary: FireSummary = { fired: [], deferred: [] };
  let due: ScheduledTask[];
  try {
    due = await claimDueTasks(db);
  } catch (err) {
    log(`[scheduler] claim failed: ${(err as Error).message}`);
    return summary;
  }
  for (const task of due) {
    if (task.kind === 'message') {
      await fireMessageTask(deps, task, summary, log);
      continue;
    }
    try {
      const result = await acceptRun(deps, {
        prompt: task.prompt,
        kind: 'api',
        notifyWhatsapp: task.deliver === 'whatsapp',
        // The fired run lands in its own conversation titled with the
        // schedule's name, so the operator can see at a glance which queued
        // work produced which mission.
        conversationTitle: `⏰ ${task.name}`,
      });
      if (result.ok) {
        await markTaskFired(db, task.id, result.run.id);
        summary.fired.push({ taskId: task.id, taskName: task.name, runId: result.run.id, kind: 'task' });
        log(`[scheduler] fired "${task.name}" as ${result.run.id}`);
      } else {
        await deferTask(db, task.id);
        const reason = result.reason === 'budget' ? 'daily budget spent' : 'another task is running';
        summary.deferred.push({ taskId: task.id, taskName: task.name, reason });
        log(`[scheduler] deferred "${task.name}" (${reason}); retrying soon`);
      }
    } catch (err) {
      await deferTask(db, task.id).catch(() => {});
      summary.deferred.push({ taskId: task.id, taskName: task.name, reason: 'error' });
      log(`[scheduler] error firing "${task.name}": ${(err as Error).message}`);
    }
  }
  return summary;
}
