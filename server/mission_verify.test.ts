/**
 * Prove-it's-done tests.
 *
 * The promises under test: (1) a mission with checkable output (steps or
 * announced files) is re-checked against the durable record before it may be
 * marked done; (2) a simple answer with nothing checkable skips verification
 * and closes exactly as before; (3) a mission whose checks fail is marked
 * failed with error_type 'verification_failed', never silently done.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun, finishRun, getRun, readEvents } from './runs.js';
import { parseMilestone } from './planning.js';
import { recordMissionStep } from './mission_steps.js';
import { recordArtifact } from './artifacts.js';
import {
  parseVerification,
  verifyMission,
  verificationPassed,
  type VerificationCheck,
} from './mission_verify.js';
import { acceptRun } from './accept.js';
import { loadConfig, type AppConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine, type ScriptStep } from './engine/scripted.js';

let db: Db;

function milestone(line: string) {
  const m = parseMilestone(line);
  assert.ok(m, `expected a milestone in: ${line}`);
  return m;
}

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'mission-verify-access-key-for-tests';

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

function makeExecutor(steps: ScriptStep[]): RunExecutor {
  return new RunExecutor({
    db,
    bus: new EventBus(),
    engine: new ScriptedEngine({ steps, speed: 0 }),
  });
}

/** Wait for a run to reach a terminal state without sleeping a fixed amount. */
async function settleRun(runId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(db, runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM mission_steps');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM conversations');
});

describe('verifyMission', () => {
  test('a simple answer with no steps and no artifacts skips verification', async () => {
    const run = await createRun(db, { prompt: 'what time is it', engine: 'scripted' });
    const checks = await verifyMission(db, run.id, 'it is noon');
    assert.deepEqual(checks, []);
    assert.equal(verificationPassed(checks), false); // skipped is not a pass
  });

  test('every announced step done → checks pass', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/2: scaffold'));
    await recordMissionStep(db, run.id, milestone('Step 2/2: implement'));
    await recordMissionStep(db, run.id, milestone('Step 1/2 done: scaffolded'));
    await recordMissionStep(db, run.id, milestone('Step 2/2 done: implemented'));

    const checks = await verifyMission(db, run.id, 'here is the thing');
    assert.equal(checks.length, 2);
    assert.ok(checks.every((c) => c.passed));
    assert.equal(checks.find((c) => c.name === 'steps')?.evidence, '2/2 steps done');
    assert.equal(verificationPassed(checks), true);
  });

  test('a step that never finished fails verification', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/2: scaffold'));
    await recordMissionStep(db, run.id, milestone('Step 2/2: implement'));
    await recordMissionStep(db, run.id, milestone('Step 1/2 done: scaffolded'));

    const checks = await verifyMission(db, run.id, 'here is the thing');
    const steps = checks.find((c) => c.name === 'steps');
    assert.ok(steps);
    assert.equal(steps.passed, false);
    assert.match(steps.evidence, /step 2/);
    assert.equal(verificationPassed(checks), false);
  });

  test('an empty answer fails the answer check', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/1 done: built'));

    const checks = await verifyMission(db, run.id, '   ');
    const answer = checks.find((c) => c.name === 'answer');
    assert.ok(answer);
    assert.equal(answer.passed, false);
    assert.equal(verificationPassed(checks), false);
  });

  test('announced files pass; a materialized file that vanished fails', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/1 done: built'));
    await recordArtifact(db, run.id, 'out/report.pdf');

    let checks = await verifyMission(db, run.id, 'done');
    let artifacts = checks.find((c) => c.name === 'artifacts');
    assert.ok(artifacts);
    assert.equal(artifacts.passed, true);
    assert.match(artifacts.evidence, /report\.pdf/);

    // The file was materialized once, then lost from disk: that is a real
    // failure, not a missing cache.
    await db.query(`UPDATE artifacts SET storage_key = 'ghost/missing.bin' WHERE run_id = $1`, [
      run.id,
    ]);
    checks = await verifyMission(db, run.id, 'done');
    artifacts = checks.find((c) => c.name === 'artifacts');
    assert.ok(artifacts);
    assert.equal(artifacts.passed, false);
    assert.match(artifacts.evidence, /missing on disk/);
    assert.equal(verificationPassed(checks), false);
  });

  test('parseVerification is defensive', () => {
    assert.equal(parseVerification(null), null);
    assert.equal(parseVerification('garbage'), null);
    assert.equal(parseVerification([{ nope: 1 }]), null);
    const checks: VerificationCheck[] = [{ name: 'steps', passed: true, evidence: '2/2 steps done' }];
    assert.deepEqual(parseVerification(JSON.parse(JSON.stringify(checks))), checks);
  });
});

describe('verification persistence', () => {
  test('finishRun stores the checks; getRun reads them back', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    const checks: VerificationCheck[] = [
      { name: 'answer', passed: true, evidence: 'answer produced (12 chars)' },
      { name: 'steps', passed: true, evidence: '1/1 steps done' },
    ];
    await finishRun(db, run.id, { status: 'completed', text: 'done', verification: checks });
    const reread = await getRun(db, run.id);
    assert.deepEqual(reread?.verification, checks);
  });

  test('a run closed without verification reads back null', async () => {
    const run = await createRun(db, { prompt: 'hi', engine: 'scripted' });
    await finishRun(db, run.id, { status: 'completed', text: 'hello' });
    const reread = await getRun(db, run.id);
    assert.equal(reread?.verification, null);
  });
});

describe('executor prove-it-done', () => {
  test('a mission with all steps done closes as completed with proof', async () => {
    const config = makeConfig();
    const executor = makeExecutor([
      { log: 'Step 1/2: gather the facts' },
      { log: 'Step 1/2 done: facts gathered' },
      { log: 'Step 2/2: write the report' },
      { log: 'Step 2/2 done: report written' },
      { text: 'the report' },
    ]);
    const result = await acceptRun({ db, executor, config }, { prompt: 'write the report', kind: 'chat' });
    assert.equal(result.ok, true);
    await settleRun(result.run.id);
    await executor.shutdown();

    const run = await getRun(db, result.ok ? result.run.id : 'missing');
    assert.equal(run?.status, 'completed');
    assert.ok(run?.verification);
    assert.equal(run?.verification?.length, 2);
    assert.ok(run?.verification?.every((c) => c.passed));
    const events = await readEvents(db, run!.id);
    assert.ok(events.some((e) => e.type === 'verification.checked'));
    const completed = events.find((e) => e.type === 'run.completed');
    assert.deepEqual(
      (completed?.payload as { verification: unknown }).verification,
      run?.verification,
    );
  });

  test('a mission with an unfinished step fails instead of completing', async () => {
    const config = makeConfig();
    const executor = makeExecutor([
      { log: 'Step 1/2: gather the facts' },
      { log: 'Step 1/2 done: facts gathered' },
      { log: 'Step 2/2: write the report' },
      // No "Step 2/2 done" — the agent stopped early but still answered.
      { text: 'the report' },
    ]);
    const result = await acceptRun({ db, executor, config }, { prompt: 'write the report', kind: 'chat' });
    assert.equal(result.ok, true);
    await settleRun(result.run.id);
    await executor.shutdown();

    const run = await getRun(db, result.ok ? result.run.id : 'missing');
    assert.equal(run?.status, 'failed');
    assert.equal(run?.errorType, 'verification_failed');
    assert.match(run?.errorMessage ?? '', /steps/);
    const steps = run?.verification?.find((c) => c.name === 'steps');
    assert.ok(steps);
    assert.equal(steps.passed, false);
  });

  test('a simple answer still closes as completed with no verification', async () => {
    const config = makeConfig();
    const executor = makeExecutor([{ text: 'it is noon' }]);
    const result = await acceptRun({ db, executor, config }, { prompt: 'what time is it', kind: 'chat' });
    assert.equal(result.ok, true);
    await settleRun(result.run.id);
    await executor.shutdown();

    const run = await getRun(db, result.ok ? result.run.id : 'missing');
    assert.equal(run?.status, 'completed');
    assert.equal(run?.verification, null);
    const events = await readEvents(db, run!.id);
    assert.ok(!events.some((e) => e.type === 'verification.checked'));
  });
});
