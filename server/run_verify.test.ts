/**
 * Run-closure verification tests (ECC pilot Phase 3a).
 *
 * mission_verify.ts checks WHAT a mission produced (answer, steps,
 * artifacts). This module checks the closure itself — the things that must
 * be true of the durable record the moment a run is called finished:
 * the run's status is terminal, its terminal event is actually in the log
 * (the SSE drain-then-close contract depends on it), the source check was
 * recorded when the answer cited sources, and the run no longer holds the
 * single-active slot (an orphaned slot wedges every future mission).
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun, emitEvent, finishRun, setRunStatus } from './runs.js';
import { verifyRunClosure } from './run_verify.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM run_events');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
});

async function completedRun(text = 'done'): Promise<string> {
  const run = await createRun(db, { prompt: 'a task', engine: 'scripted' });
  await setRunStatus(db, run.id, 'running');
  await finishRun(db, run.id, { status: 'completed', text });
  return run.id;
}

function check(checks: { name: string; passed: boolean }[], name: string) {
  const found = checks.find((c) => c.name === name);
  assert.ok(found, `expected a ${name} check`);
  return found;
}

describe('run closure verification', () => {
  test('a cleanly completed run passes every closure check', async () => {
    const id = await completedRun('an answer with a source https://example.com/a');
    await emitEvent(db, id, 'sources.checked', { checked: 1, alive: 1, dead: [] });

    const checks = await verifyRunClosure(db, id, { hadUrls: true });
    assert.ok(checks.length >= 3);
    assert.ok(
      checks.every((c) => c.passed),
      `expected all checks to pass, got ${JSON.stringify(checks)}`,
    );
  });

  test('a cited answer with no recorded source check fails sources_recorded', async () => {
    const id = await completedRun('see https://example.com/missing');

    const checks = await verifyRunClosure(db, id, { hadUrls: true });
    assert.equal(check(checks, 'sources_recorded').passed, false);
    assert.equal(check(checks, 'terminal_status').passed, true);
    assert.equal(check(checks, 'terminal_event').passed, true);
  });

  test('an answer without URLs is not asked for a source check', async () => {
    const id = await completedRun('plain answer, no links');

    const checks = await verifyRunClosure(db, id, { hadUrls: false });
    assert.equal(checks.find((c) => c.name === 'sources_recorded'), undefined);
    assert.ok(checks.every((c) => c.passed));
  });

  test('a run that never closed fails terminal checks and counts as orphaned', async () => {
    const run = await createRun(db, { prompt: 'still going', engine: 'scripted' });

    const checks = await verifyRunClosure(db, run.id, { hadUrls: false });
    assert.equal(check(checks, 'terminal_status').passed, false);
    assert.equal(check(checks, 'terminal_event').passed, false);
    assert.equal(check(checks, 'no_orphan').passed, false);
  });

  test('a failed run with its terminal event passes closure', async () => {
    const run = await createRun(db, { prompt: 'will fail', engine: 'scripted' });
    await setRunStatus(db, run.id, 'running');
    await finishRun(db, run.id, {
      status: 'failed',
      text: 'partial',
      errorType: 'engine_error',
      errorMessage: 'boom',
    });

    const checks = await verifyRunClosure(db, run.id, { hadUrls: false });
    assert.ok(
      checks.every((c) => c.passed),
      `expected all checks to pass, got ${JSON.stringify(checks)}`,
    );
  });

  test('a cancelled run passes closure', async () => {
    const run = await createRun(db, { prompt: 'stop me', engine: 'scripted' });
    await setRunStatus(db, run.id, 'running');
    await finishRun(db, run.id, { status: 'cancelled', text: 'partial' });

    const checks = await verifyRunClosure(db, run.id, { hadUrls: false });
    assert.ok(
      checks.every((c) => c.passed),
      `expected all checks to pass, got ${JSON.stringify(checks)}`,
    );
  });

  test('a terminal status with NO terminal event fails terminal_event only', async () => {
    // The crash-fallback close: status flipped by hand, nothing appended to
    // the log. This is the exact closure the executor's rescue path leaves,
    // and the check must be able to say so precisely.
    const run = await createRun(db, { prompt: 'crash close', engine: 'scripted' });
    await setRunStatus(db, run.id, 'running');
    await setRunStatus(db, run.id, 'failed', { errorType: 'executor_crashed' });

    const checks = await verifyRunClosure(db, run.id, { hadUrls: false });
    assert.equal(check(checks, 'terminal_status').passed, true);
    assert.equal(check(checks, 'terminal_event').passed, false);
    assert.equal(check(checks, 'no_orphan').passed, true);
  });

  test('a missing run reports a single failed check, not a crash', async () => {
    const checks = await verifyRunClosure(db, 'run_does_not_exist', { hadUrls: false });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].passed, false);
  });
});
