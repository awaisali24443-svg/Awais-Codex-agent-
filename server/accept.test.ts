/**
 * Accept-path queue tests.
 *
 * The one-mission-at-a-time rule is the closest thing the arena has to a
 * queue: a run holds the single-active slot from creation until it reaches a
 * terminal state. The promise under test: a run that fails to start must
 * never keep holding that slot — otherwise every future mission is refused
 * with "another mission is already running" even though nothing runs, which
 * is exactly what a broken queue looks like from the outside. Only a server
 * restart (the boot recovery sweep) clears such a wedge today.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { acceptRun } from './accept.js';
import { getActiveRun, type PlanStep } from './runs.js';
import { peekDayTotal } from './budget.js';
import { loadConfig, type AppConfig } from './config.js';
import type { RunExecutor } from './executor.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM mission_steps');
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM budgets');
});

// Long enough to trip looksComplex, so the planning branch (with its extra
// fallible awaits between run creation and executor start) is exercised.
const COMPLEX_PROMPT =
  'Build a small habit tracker web app. First, design the data model for habits and check-ins. ' +
  'Then implement the storage layer with SQLite. Then build the UI with a weekly grid view. ' +
  'Finally, write tests for the streak calculation and document the setup steps. ' +
  'Also add CSV export and a dark mode toggle for the settings screen.';

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'accept-queue-access-key-for-tests';

function makeConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'key',
    ACCESS_KEY,
    SESSION_SECRET: SECRET,
    ENGINE: 'scripted',
    DAILY_RUN_BUDGET: '50',
  } as NodeJS.ProcessEnv);
}

/** Executor stub: the planning pass finds steps; start() is a no-op. */
function stubExecutor(): RunExecutor {
  const steps: PlanStep[] = [
    { index: 1, total: 2, label: 'design' },
    { index: 2, total: 2, label: 'build' },
  ];
  return {
    planMission: async () => steps,
    start: () => {},
  } as unknown as RunExecutor;
}

/**
 * A Db whose query() throws for statements matching `pattern` — a simulated
 * transient storage failure mid-accept. Transactions propagate the fault so
 * createRun's inner statements fail the same way the real one would.
 */
function failingDb(inner: Db, pattern: RegExp): Db {
  const wrap = (target: Db): Db => ({
    ...target,
    query: <T,>(sql: string, params?: unknown[]): Promise<T[]> =>
      pattern.test(sql)
        ? Promise.reject(new Error('simulated storage failure'))
        : target.query<T>(sql, params),
    transaction: <T,>(fn: (tx: Db) => Promise<T>): Promise<T> =>
      target.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

describe('accept failure never wedges the queue', () => {
  test('a storage failure during plan saving fails the run and frees the slot', async () => {
    const config = makeConfig();
    // saveRunPlan is UPDATE runs SET plan_json = ... — fail exactly that.
    const boomDb = failingDb(db, /SET plan_json/);
    await assert.rejects(
      () =>
        acceptRun(
          { db: boomDb, executor: stubExecutor(), config },
          { prompt: COMPLEX_PROMPT, kind: 'chat' },
        ),
      /simulated storage failure/,
    );
    // The run must not sit in 'queued' holding the single-active slot.
    assert.equal(await getActiveRun(db), null);
    const rows = await db.query<{ status: string; error_type: string | null }>(
      'SELECT status, error_type FROM runs',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].error_type, 'accept_failed');
  });

  test('the budget claim is refunded when the run never started', async () => {
    const config = makeConfig();
    const boomDb = failingDb(db, /SET plan_json/);
    await assert.rejects(
      () =>
        acceptRun(
          { db: boomDb, executor: stubExecutor(), config },
          { prompt: COMPLEX_PROMPT, kind: 'chat' },
        ),
      /simulated storage failure/,
    );
    // The claim happened (consumeRunBudget ran before the failure) but the
    // mission never executed, so the day must not be charged.
    assert.equal(await peekDayTotal(db), 0);
  });

  test('a later mission can start after an accept failure', async () => {
    const config = makeConfig();
    const boomDb = failingDb(db, /SET plan_json/);
    await assert.rejects(
      () =>
        acceptRun(
          { db: boomDb, executor: stubExecutor(), config },
          { prompt: COMPLEX_PROMPT, kind: 'chat' },
        ),
      /simulated storage failure/,
    );
    // Healthy storage again: the next mission must be accepted, not refused
    // with "another mission is already running".
    const result = await acceptRun(
      { db, executor: stubExecutor(), config },
      { prompt: COMPLEX_PROMPT, kind: 'chat' },
    );
    assert.equal(result.ok, true);
  });
});
