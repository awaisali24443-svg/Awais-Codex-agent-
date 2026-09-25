/**
 * Scheduled-task firing, against a real database (PGlite).
 *
 * Regression test for the "queueing system is not working" report: a task
 * that fires must leave a run the operator can recognise. The fired run
 * lands in its own conversation titled with the schedule's name — before the
 * fix it was titled with the raw prompt text, so scheduled work was
 * indistinguishable from manually started missions and the queue looked dead.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig, type AppConfig } from './config.js';
import { peekDayTotal } from './budget.js';
import type { SecretName } from './settings.js';
import {
  claimDueTasks,
  composeReminderMessage,
  createScheduledTask,
  fireDueScheduledTasks,
  getScheduledTask,
  MAX_SCHEDULES_IN_LINE,
} from './scheduler.js';
import { getRun, listWaitingRuns } from './runs.js';

let db: Db;
let config: AppConfig;

before(async () => {
  db = await createDb('');
  await migrate(db);
  config = loadConfig({ NODE_ENV: 'test', DAILY_RUN_BUDGET: '50' } as NodeJS.ProcessEnv);
});

after(async () => {
  await db.close();
});

const stubExecutor = { start: (_run: unknown) => {} };

describe('scheduled task firing', () => {
  test('a fired task names the run conversation after the schedule', async () => {
    const task = await createScheduledTask(db, {
      name: 'Morning news',
      prompt: 'summarise the overnight tech news in five bullets',
      cadence: 'interval',
      intervalMinutes: 60,
    });
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [
      task.id,
    ]);

    const summary = await fireDueScheduledTasks(
      { db, executor: stubExecutor as never, config },
      () => {},
    );
    assert.equal(summary.fired.length, 1);
    const runId = summary.fired[0].runId;

    const run = await getRun(db, runId);
    assert.ok(run, 'fired run exists');
    assert.ok(run!.conversationId, 'fired run has a conversation');
    const cnvs = await db.query<{ title: string }>(
      `SELECT title FROM conversations WHERE id = $1`,
      [run!.conversationId],
    );
    assert.equal(cnvs[0].title, '⏰ Morning news');

    const after = await getScheduledTask(db, task.id);
    assert.equal(after!.lastRunId, runId);
    assert.ok(new Date(after!.nextRunAt).getTime() > Date.now(), 'next run advanced');
    // Close the stub-fired run so later tests own the single-active slot.
    await db.query(`UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1`, [runId]);
  });

  test('a monthly task claims, fires, and advances to next month', async () => {
    const task = await createScheduledTask(db, {
      name: 'Monthly audit',
      prompt: 'audit the app: find bugs, fix them, improve it',
      cadence: 'monthly',
      timeOfDay: '09:00',
      dayOfMonth: 15,
    });
    assert.equal(task.dayOfMonth, 15);
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [
      task.id,
    ]);
    const dueAt = (await getScheduledTask(db, task.id))!.nextRunAt;

    const claimed = await claimDueTasks(db);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].dayOfMonth, 15);
    const after = await getScheduledTask(db, task.id);
    assert.ok(
      new Date(after!.nextRunAt).getTime() > new Date(dueAt).getTime(),
      'monthly next_run_at advanced past the claimed one',
    );
    // Still the 15th at 09:00 Karachi.
    const iso = new Date(after!.nextRunAt).toISOString();
    const khi = new Date(new Date(after!.nextRunAt).getTime() + 5 * 3_600_000);
    assert.equal(khi.getUTCDate(), 15);
    assert.equal(iso.slice(11, 16), '04:00'); // 09:00+05:00 in UTC
  });

  test('a schedule that fires during a task joins the line instead of missing its time', async () => {
    const task = await createScheduledTask(db, {
      name: 'Busy test',
      prompt: 'do a thing',
      cadence: 'interval',
      intervalMinutes: 60,
    });
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [
      task.id,
    ]);
    // Occupy the single-active slot with a stuck run.
    await db.query(
      `INSERT INTO runs (id, kind, prompt, status, engine) VALUES ('run_stuck', 'chat', 'stuck', 'running', 'x')`,
    );
    const summary = await fireDueScheduledTasks(
      { db, executor: stubExecutor as never, config },
      () => {},
    );
    // Fired — and parked. A deferred schedule is a schedule that did not run at
    // the time it was asked to; the queue is how "not this instant, but yes"
    // is expressed, and the task keeps its place instead of losing a turn.
    assert.equal(summary.fired.length, 1);
    const waited = await listWaitingRuns(db);
    assert.equal(waited.length, 1, 'the fired task is in the line');
    assert.equal(waited[0].prompt, 'do a thing');
    await db.query(`DELETE FROM runs WHERE id = 'run_stuck'`);
    await db.query(`DELETE FROM runs WHERE id <> 'run_stuck'`);
  });

  test('but a full line defers rather than piling up a run per tick', async () => {
    // Ordinary tasks already waiting, from the operator's own asks.
    for (let i = 0; i < MAX_SCHEDULES_IN_LINE; i += 1) {
      await db.query(
        `INSERT INTO runs (id, kind, prompt, status, engine) VALUES ($1, 'chat', $2, 'waiting', 'x')`,
        [`run_line_${i}`, `already waiting ${i}`],
      );
    }
    await db.query(
      `INSERT INTO runs (id, kind, prompt, status, engine) VALUES ('run_stuck', 'chat', 'stuck', 'running', 'x')`,
    );
    const task = await createScheduledTask(db, {
      name: 'Monitor',
      prompt: 'check the thing',
      cadence: 'interval',
      intervalMinutes: 5,
    });
    await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [
      task.id,
    ]);

    const summary = await fireDueScheduledTasks(
      { db, executor: stubExecutor as never, config },
      () => {},
    );

    assert.equal(summary.fired.length, 0);
    assert.equal(summary.deferred.length, 1);
    assert.equal(summary.deferred[0].reason, 'the queue is full');
    const after = await getScheduledTask(db, task.id);
    const retryIn = new Date(after!.nextRunAt).getTime() - Date.now();
    assert.ok(retryIn > 0 && retryIn <= 6 * 60_000, 'retries in about five minutes');

    await db.query(`DELETE FROM runs`);
  });
});

/* ------------------------------------------------------------------ message-only --
 * A kind:'message' schedule never creates a run and never touches the daily
 * budget: at the scheduled time the owner just gets a WhatsApp note. */

const WA_TOKEN = 'test-wa-token';

const secretsWith = (token: string | null) => ({
  get: (name: SecretName) => (name === 'whatsapp_to' ? 'user:test-recipient' : token ?? ''),
});

/** A stubbed platform: records every /messages body, accepts the send. */
const stubPlatform = (calls: Array<{ body: string }>) =>
  (async (_url: unknown, init: { body?: string }) => {
    calls.push({ body: init.body ?? '' });
    return {
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ messages: [{ id: 'wamid.test' }] }),
    };
  }) as unknown as typeof fetch;

async function runCount(): Promise<number> {
  const rows = await db.query<{ n: string }>(`SELECT count(*) AS n FROM runs`);
  return Number(rows[0].n);
}

async function makeDue(taskId: string): Promise<void> {
  await db.query(`UPDATE scheduled_tasks SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [
    taskId,
  ]);
}

describe('message-only reminders', () => {
  test('the message text names the schedule and carries the reminder', () => {
    const text = composeReminderMessage({ name: 'Water plants', prompt: '  water the balcony plants  ' });
    assert.equal(text, '⏰ Water plants\n\nwater the balcony plants');
  });

  test('a message-only fire sends the note with no run and no budget spent', async () => {
    const runsBefore = await runCount();
    const budgetBefore = await peekDayTotal(db);
    const task = await createScheduledTask(db, {
      name: 'Call reminder',
      prompt: 'Call ammi about the expo',
      cadence: 'interval',
      intervalMinutes: 60,
      kind: 'message',
    });
    assert.equal(task.kind, 'message');
    await makeDue(task.id);

    const calls: Array<{ body: string }> = [];
    const summary = await fireDueScheduledTasks(
      {
        db,
        executor: stubExecutor as never,
        config,
        secrets: secretsWith(WA_TOKEN),
        fetchImpl: stubPlatform(calls),
      },
      () => {},
    );
    assert.equal(summary.fired.length, 1);
    assert.equal(summary.fired[0].kind, 'message');
    assert.equal(summary.fired[0].runId, '', 'no run is created');

    assert.equal(calls.length, 1, 'exactly one WhatsApp send');
    const payload = JSON.parse(calls[0].body) as { to?: string; text?: { body?: string } };
    assert.equal(payload.to, 'user:test-recipient');
    assert.match(payload.text?.body ?? '', /Call ammi about the expo/);

    assert.equal(await runCount(), runsBefore, 'no run was created');
    assert.equal(await peekDayTotal(db), budgetBefore, 'no budget was consumed');

    const after = await getScheduledTask(db, task.id);
    assert.ok(after!.lastRunAt, 'the fire time is recorded');
    assert.equal(after!.lastRunId, null, 'no run to point at');
    assert.ok(new Date(after!.nextRunAt).getTime() > Date.now(), 'next run advanced');
  });

  test('without a token the fire is silent, consumed, and throws nothing', async () => {
    const runsBefore = await runCount();
    const budgetBefore = await peekDayTotal(db);
    const task = await createScheduledTask(db, {
      name: 'Silent reminder',
      prompt: 'this goes nowhere',
      cadence: 'interval',
      intervalMinutes: 60,
      kind: 'message',
    });
    await makeDue(task.id);

    const calls: Array<{ body: string }> = [];
    const summary = await fireDueScheduledTasks(
      {
        db,
        executor: stubExecutor as never,
        config,
        secrets: secretsWith(null),
        fetchImpl: stubPlatform(calls),
      },
      () => {},
    );
    assert.equal(summary.fired.length, 1, 'the fire is consumed, not deferred');
    assert.equal(calls.length, 0, 'no send attempted without a token');
    assert.equal(await runCount(), runsBefore);
    assert.equal(await peekDayTotal(db), budgetBefore);
    const after = await getScheduledTask(db, task.id);
    assert.ok(new Date(after!.nextRunAt).getTime() > Date.now(), 'no retry storm');
  });

  test('two ticks never double-send the same fire', async () => {
    const task = await createScheduledTask(db, {
      name: 'Once only',
      prompt: 'send me exactly once',
      cadence: 'interval',
      intervalMinutes: 60,
      kind: 'message',
    });
    await makeDue(task.id);

    const calls: Array<{ body: string }> = [];
    const deps = {
      db,
      executor: stubExecutor as never,
      config,
      secrets: secretsWith(WA_TOKEN),
      fetchImpl: stubPlatform(calls),
    };
    const first = await fireDueScheduledTasks(deps, () => {});
    const second = await fireDueScheduledTasks(deps, () => {});
    assert.equal(first.fired.length, 1);
    assert.equal(second.fired.length, 0, 'the claim already advanced next_run_at');
    assert.equal(calls.length, 1, 'sent exactly once across both ticks');
  });

  test('a work reminder still consumes exactly one task of budget', async () => {
    const runsBefore = await runCount();
    const budgetBefore = await peekDayTotal(db);
    const task = await createScheduledTask(db, {
      name: 'Work reminder',
      prompt: 'do the actual work',
      cadence: 'interval',
      intervalMinutes: 60,
      kind: 'task',
    });
    await makeDue(task.id);

    const summary = await fireDueScheduledTasks(
      { db, executor: stubExecutor as never, config },
      () => {},
    );
    assert.equal(summary.fired.length, 1);
    assert.equal(summary.fired[0].kind, 'task');
    assert.ok(summary.fired[0].runId, 'a run is created');

    assert.equal((await runCount()) - runsBefore, 1, 'exactly one run created');
    assert.equal((await peekDayTotal(db)) - budgetBefore, 1, 'exactly one budget unit consumed');

    // Close the stub-fired run so later tests own the single-active slot.
    await db.query(`UPDATE runs SET status = 'completed', finished_at = now() WHERE id = $1`, [
      summary.fired[0].runId,
    ]);
  });
});
