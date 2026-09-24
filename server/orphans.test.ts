/**
 * Orphaned-run recovery tests.
 *
 * When the server restarts mid-run, markOrphanedRuns must leave a terminal
 * `run.failed` event behind — not just flip the row. A reconnecting stream
 * replays run_events; without the terminal event the client waits on a dead
 * run forever (spinner spins, no failure notice, no retry button).
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, markOrphanedRuns, type Db } from './db.js';
import { migrate } from './migrate.js';
import { recoverOrphanedRuns } from './recovery.js';
import { setRunStatus } from './runs.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

async function addRun(id: string, status: string, startedAgo: string): Promise<void> {
  await db.query(`INSERT INTO conversations (id, title, source) VALUES ($1, 't', 'web')`, [`cnv_${id}`]);
  await db.query(
    `INSERT INTO runs (id, conversation_id, kind, prompt, status, engine, started_at)
     VALUES ($1, $2, 'chat', 'p', $3, 'test', now() - $4::interval)`,
    [id, `cnv_${id}`, status, startedAgo],
  );
}

test('orphaned runs get a terminal run.failed event, fresh runs are untouched', async () => {
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');

  await addRun('run_old', 'running', '2 hours');

  const count = await markOrphanedRuns(db, 60);
  assert.equal(count, 1);

  const oldRows = await db.query<{ status: string; error_type: string }>(
    `SELECT status, error_type FROM runs WHERE id = 'run_old'`,
  );
  assert.equal(oldRows[0].status, 'failed');
  assert.equal(oldRows[0].error_type, 'orphaned');

  const events = await db.query<{ type: string; payload: string }>(
    `SELECT type, payload::text AS payload FROM run_events WHERE run_id = 'run_old'`,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'run.failed');
  assert.match(events[0].payload, /orphaned/);

  // A run that started moments ago is not an orphan, even in 'running' state.
  // (Only one active run at a time, so the fresh one goes in after the old
  // one was reaped.)
  await addRun('run_fresh', 'running', '0 seconds');
  const second = await markOrphanedRuns(db, 60);
  assert.equal(second, 0);
  const freshRows = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = 'run_fresh'`);
  assert.equal(freshRows[0].status, 'running');
});

test('a run left planning by a restart is failed, and never started unapproved', async () => {
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');

  // The planning pass is an in-flight engine call: a restart kills it, and the
  // row would otherwise hold the single active slot with nothing running.
  await addRun('run_plan', 'planning', '2 minutes');

  const started: string[] = [];
  const result = await recoverOrphanedRuns(db, { start: (run) => started.push(run.id) });

  assert.equal(result.failed, 1);
  assert.equal(result.resumed, 0);
  assert.deepEqual(started, [], 'a plan nobody approved must not start executing');
  const rows = await db.query<{ status: string; error_type: string }>(
    `SELECT status, error_type FROM runs WHERE id = 'run_plan'`,
  );
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error_type, 'interrupted');
});

test('the staleness sweep clears a planning run too', async () => {
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');

  await addRun('run_stale_plan', 'planning', '2 hours');
  assert.equal(await markOrphanedRuns(db, 60), 1);
  const rows = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = 'run_stale_plan'`);
  assert.equal(rows[0].status, 'failed');

  // And the status is a real one: it can be set and read back.
  await addRun('run_plan_live', 'running', '0 seconds');
  await setRunStatus(db, 'run_plan_live', 'planning');
  const live = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = 'run_plan_live'`);
  assert.equal(live[0].status, 'planning');
});
