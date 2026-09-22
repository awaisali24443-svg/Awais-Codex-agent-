/**
 * The morning briefing, at the database level: only runs inside the window
 * count, tokens add up, and reminders report pending + next due.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { getBriefing } from './briefing.js';
import { newId } from './runs.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM reminders');
  await db.query('DELETE FROM runs');
});

async function insertRun(opts: {
  status: string;
  hoursAgo?: number;
  tokensIn?: number;
  tokensOut?: number;
  prompt?: string;
}): Promise<string> {
  const id = newId('run');
  const started = new Date(Date.now() - (opts.hoursAgo ?? 1) * 3_600_000);
  await db.query(
    `INSERT INTO runs (id, kind, prompt, status, engine, started_at, finished_at, tokens_in, tokens_out)
      VALUES ($1, 'chat', $2, $3, 'test', $4, $5, $6, $7)`,
    [
      id,
      opts.prompt ?? 'a test mission',
      opts.status,
      started.toISOString(),
      opts.status === 'queued' ? null : started.toISOString(),
      opts.tokensIn ?? null,
      opts.tokensOut ?? null,
    ],
  );
  return id;
}

describe('briefing', () => {
  test('counts runs, sums tokens, and reports reminders', async () => {
    await insertRun({ status: 'completed', tokensIn: 100, tokensOut: 50 });
    await insertRun({ status: 'failed', tokensIn: 20, tokensOut: 10 });
    await insertRun({ status: 'cancelled' });
    await insertRun({ status: 'completed', hoursAgo: 200 }); // outside the window
    await insertRun({
      status: 'completed',
      prompt: 'x'.repeat(200),
    });

    await db.query(
      `INSERT INTO reminders (id, text, run_at, status) VALUES
         ($1, 'one', now() + interval '1 hour', 'pending'),
         ($2, 'two', now() + interval '2 hours', 'pending'),
         ($3, 'three', now() - interval '1 hour', 'fired')`,
      [newId('rem'), newId('rem'), newId('rem')],
    );

    const briefing = await getBriefing(db, 12);

    assert.equal(briefing.counts.total, 4);
    assert.equal(briefing.counts.completed, 2);
    assert.equal(briefing.counts.failed, 1);
    assert.equal(briefing.counts.cancelled, 1);
    assert.deepEqual(briefing.tokens, { in: 120, out: 60 });
    assert.equal(briefing.reminders.pending, 2);
    assert.ok(briefing.reminders.nextDue, 'next due reminder is reported');
    assert.ok(
      briefing.runs.every((r) => r.prompt.length <= 161),
      'prompts are truncated',
    );
  });

  test('an empty window is a valid briefing', async () => {
    const briefing = await getBriefing(db, 1);
    assert.equal(briefing.counts.total, 0);
    assert.deepEqual(briefing.tokens, { in: 0, out: 0 });
    assert.equal(briefing.reminders.pending, 0);
    assert.equal(briefing.reminders.nextDue, null);
  });
});
