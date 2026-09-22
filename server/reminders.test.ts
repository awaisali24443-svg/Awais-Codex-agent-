/**
 * Reminders, at the database level.
 *
 * The claims being tested: creating validates, claiming is atomic (a row is
 * never handed out twice), a failed firing releases the row back to pending,
 * and cancelling only touches rows that have not fired.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import {
  cancelReminder,
  claimDueReminders,
  createReminder,
  listReminders,
  markReminderFired,
  releaseReminder,
} from './reminders.js';
import { newId } from './runs.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
  // Stub runs so markReminderFired's run_id foreign key holds.
  await db.query(
    `INSERT INTO runs (id, kind, prompt, status, engine) VALUES
       ('run_x', 'api', 'stub', 'completed', 'test'),
       ('run_y', 'api', 'stub', 'completed', 'test')
     ON CONFLICT (id) DO NOTHING`,
  );
});

after(async () => {
  await db.close();
});

const future = (ms: number): Date => new Date(Date.now() + ms);
const past = (ms: number): Date => new Date(Date.now() - ms);

/** Insert a reminder that is already due. createReminder only accepts future
 *  runAt (an API-facing guard), so due rows bypass it the way the migration
 *  of an old row would. */
async function insertDueReminder(text: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO reminders (id, text, run_at, status)
      VALUES ($1, $2, now() - interval '1 second', 'pending') RETURNING id`,
    [newId('rem'), text],
  );
  return rows[0].id;
}

describe('reminders', () => {
  test('create validates its input', async () => {
    await assert.rejects(() => createReminder(db, '   ', future(60_000)), /empty/);
    await assert.rejects(() => createReminder(db, 'x'.repeat(501), future(60_000)), /limit/);
    await assert.rejects(() => createReminder(db, 'ok', past(1_000)), /past/);

    const reminder = await createReminder(db, '  water the plants  ', future(60_000));
    assert.equal(reminder.text, 'water the plants');
    assert.equal(reminder.status, 'pending');
  });

  test('claiming is atomic and release returns the row to pending', async () => {
    const reminderId = await insertDueReminder('due now');

    const first = await claimDueReminders(db);
    assert.ok(first.some((r) => r.id === reminderId), 'the due row is claimed');

    const second = await claimDueReminders(db);
    assert.ok(!second.some((r) => r.id === reminderId), 'a claimed row is not handed out twice');

    await releaseReminder(db, reminderId);
    const third = await claimDueReminders(db);
    assert.ok(third.some((r) => r.id === reminderId), 'a released row becomes claimable again');

    await markReminderFired(db, reminderId, 'run_x');
    const fired = (await listReminders(db, true)).find((r) => r.id === reminderId);
    assert.equal(fired?.status, 'fired');
    assert.equal(fired?.runId, 'run_x');
  });

  test('cancel only touches unfired reminders', async () => {
    const pending = await createReminder(db, 'to cancel', future(60_000));
    assert.equal(await cancelReminder(db, pending.id), true);

    const firedId = await insertDueReminder('already fired');
    const [claimed] = await claimDueReminders(db);
    assert.equal(claimed.id, firedId);
    await markReminderFired(db, firedId, 'run_y');
    assert.equal(await cancelReminder(db, firedId), false);

    assert.equal(await cancelReminder(db, 'rem_doesnotexist'), false);

    const visible = await listReminders(db);
    assert.ok(!visible.some((r) => r.id === pending.id), 'cancelled rows are hidden by default');
    assert.ok(
      (await listReminders(db, true)).some((r) => r.id === pending.id),
      'cancelled rows show with all=true',
    );
  });
});
