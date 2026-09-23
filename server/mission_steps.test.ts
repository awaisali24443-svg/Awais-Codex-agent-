/**
 * Durable missions tests.
 *
 * The two promises under test: (1) a "Step k/N" announcement is checkpointed
 * the moment it is made, so a crash loses nothing finished; (2) boot triage
 * resumes the newest orphan with progress and fails the rest as resumable
 * 'interrupted' runs. Plus the token-budget guard and the pre-flight
 * estimate that feeds the composer's cost line.
 */
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { createRun, getRun, type Run } from './runs.js';
import { parseMilestone } from './planning.js';
import {
  buildResumePreamble,
  firstPendingStep,
  formatTokens,
  getMissionSteps,
  isTokenBudgetSpent,
  recordMissionStep,
  triageOrphan,
} from './mission_steps.js';
import { estimateRunCost } from './accept.js';
import { recoverOrphanedRuns } from './recovery.js';
import { createApp } from './app.js';
import { createStores } from './settings.js';
import { loadConfig, type AppConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';

let db: Db;

function milestone(line: string) {
  const m = parseMilestone(line);
  assert.ok(m, `expected a milestone in: ${line}`);
  return m;
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

describe('mission step checkpoints', () => {
  test('a plan line creates a pending step; the done line completes it', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/3: scaffold the project'));
    await recordMissionStep(db, run.id, milestone('Step 2/3: write the code'));
    await recordMissionStep(db, run.id, milestone('Step 1/3 done: scaffolded with tests'));

    const steps = await getMissionSteps(db, run.id);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].status, 'done');
    assert.equal(steps[0].resultSummary, 'scaffolded with tests');
    assert.equal(steps[1].status, 'pending');
    assert.equal(await firstPendingStep(db, run.id), 2);
  });

  test('re-announcing a step updates it instead of duplicating', async () => {
    const run = await createRun(db, { prompt: 'build the thing', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/2: draft'));
    await recordMissionStep(db, run.id, milestone('Step 1/2: revised draft'));
    const steps = await getMissionSteps(db, run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].label, 'revised draft');
  });

  test('a done line with no prior plan line still files the step', async () => {
    const run = await createRun(db, { prompt: 'quick task', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/1 done: finished'));
    assert.equal((await getMissionSteps(db, run.id)).length, 1);
    assert.equal(await firstPendingStep(db, run.id), null);
  });

  test('the resume preamble lists finished steps and the continue point', async () => {
    const run = await createRun(db, { prompt: 'long mission', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/3: research'));
    await recordMissionStep(db, run.id, milestone('Step 1/3 done: found three options'));
    await recordMissionStep(db, run.id, milestone('Step 2/3: prototype'));
    const preamble = await buildResumePreamble(db, run.id, 2);
    assert.ok(preamble.includes('RESUMING'));
    assert.ok(preamble.includes('Step 1/3 done: found three options'));
    assert.ok(preamble.includes('Continue from step 2'));
    assert.ok(!preamble.includes('Step 2/3 done'));
  });
});

describe('triageOrphan', () => {
  test('young with progress -> resume; otherwise -> fail', () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    assert.equal(triageOrphan(2, recent), 'resume');
    assert.equal(triageOrphan(0, recent), 'fail');
    assert.equal(triageOrphan(5, old), 'fail');
  });
});

describe('token budget guard', () => {
  test('spent when chars/4 reaches the cap; inert without a cap', () => {
    assert.equal(isTokenBudgetSpent(4000, 1000), true);
    assert.equal(isTokenBudgetSpent(3999, 1000), false);
    assert.equal(isTokenBudgetSpent(1_000_000, null), false);
    assert.equal(isTokenBudgetSpent(1_000_000, 0), false);
  });

  test('formatTokens stays phone-readable', () => {
    assert.equal(formatTokens(800), '800');
    assert.equal(formatTokens(8200), '8.2k');
    assert.equal(formatTokens(24000), '24k');
  });
});

describe('estimateRunCost', () => {
  test('falls back to 8k with no history', async () => {
    const est = await estimateRunCost(db, { prompt: 'do a thing' });
    assert.equal(est.estimatedTokens, 8000);
    assert.equal(est.basis, 'fallback');
  });

  test('uses the operator history when it exists', async () => {
    const run = await createRun(db, { prompt: 'past mission', engine: 'scripted' });
    await db.query(
      `UPDATE runs SET status = 'completed', tokens_in = 1000, tokens_out = 2000, finished_at = now() WHERE id = $1`,
      [run.id],
    );
    const est = await estimateRunCost(db, { prompt: 'new mission' });
    assert.equal(est.estimatedTokens, 3000);
    assert.equal(est.basis, 'history');
    assert.equal(est.missionsSampled, 1);
  });

  test('deep research multiplies by passes', async () => {
    const est = await estimateRunCost(db, { prompt: 'research x', deepResearch: true, researchBudgetMinutes: 30 });
    assert.equal(est.estimatedTokens, 16000); // 8k fallback x 2 passes
  });
});

describe('recoverOrphanedRuns', () => {
  async function orphanWith(status: 'running' | 'paused', doneSteps: string[]): Promise<Run> {
    const run = await createRun(db, { prompt: `orphan ${status}`, engine: 'scripted' });
    for (const line of doneSteps) await recordMissionStep(db, run.id, milestone(line));
    await db.query(`UPDATE runs SET status = $2, started_at = now() - interval '5 minutes' WHERE id = $1`, [
      run.id,
      status,
    ]);
    return run;
  }

  test('an orphan with progress resumes from its first pending step', async () => {
    const run = await orphanWith('running', ['Step 1/3 done: researched']);
    const started: Run[] = [];
    const result = await recoverOrphanedRuns(db, { start: (r: Run) => void started.push(r) });

    assert.equal(result.resumed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.resumedRunId, run.id);
    assert.equal(started.length, 1);

    const resumed = await getRun(db, run.id);
    assert.equal(resumed?.status, 'queued');
    assert.equal(resumed?.resumeFromStep, 2);
    assert.equal(resumed?.errorType, null);
  });

  test('an orphan without progress fails as resumable-interrupted', async () => {
    const run = await orphanWith('running', []);
    const result = await recoverOrphanedRuns(db, { start: () => {} });

    assert.equal(result.resumed, 0);
    assert.equal(result.failed, 1);
    const failed = await getRun(db, run.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.errorType, 'interrupted');
    assert.ok(failed?.errorMessage?.includes('resume'));
  });

  test('a paused run is left alone — pausing was a decision, not a crash', async () => {
    const run = await orphanWith('paused', ['Step 1/2 done: drafted']);
    const result = await recoverOrphanedRuns(db, { start: () => { throw new Error('must not start'); } });
    assert.deepEqual(result, { resumed: 0, failed: 0, resumedRunId: null });
    assert.equal((await getRun(db, run.id))?.status, 'paused');
  });

  test('nothing to recover is a quiet no-op', async () => {
    const result = await recoverOrphanedRuns(db, { start: () => {} });
    assert.deepEqual(result, { resumed: 0, failed: 0, resumedRunId: null });
  });
});

// ---------------------------------------------------------------------------
// HTTP: the estimate endpoint and the resume endpoint, mounted and wired.
// ---------------------------------------------------------------------------

const SECRET = 'test-session-secret-that-is-definitely-long-enough';
const ACCESS_KEY = 'missions-access-key-for-tests';

let agent: Server;
let base: string;
const auth = { 'x-access-key': ACCESS_KEY };

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

async function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('mission routes', () => {
  before(async () => {
    const config = makeConfig();
    const executor = new RunExecutor({ db, bus: new EventBus(), engine: new ScriptedEngine() });
    const app = createApp({
      config,
      db,
      bus: new EventBus(),
      executor,
      ...createStores(db, config),
      status: { startedAt: Date.now(), migrationsApplied: 9, orphanedRuns: 0 },
    });
    agent = http.createServer(app);
    await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => agent.close(() => resolve()));
  });

  test('POST /runs/estimate answers without starting anything', async () => {
    const res = await post('/api/runs/estimate', { prompt: 'summarize this doc' });
    assert.equal(res.status, 200);
    assert.equal(res.body.estimatedTokens, 8000);
    assert.equal(res.body.basis, 'fallback');
    const runs = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM runs');
    assert.equal(runs[0].count, '0');
  });

  test('POST /runs/:id/resume requeues a paused run from its first pending step', async () => {
    const run = await createRun(db, { prompt: 'long build', engine: 'scripted' });
    await recordMissionStep(db, run.id, milestone('Step 1/4 done: planned'));
    await recordMissionStep(db, run.id, milestone('Step 2/4: coding'));
    await db.query(`UPDATE runs SET status = 'paused', error_type = 'token_budget' WHERE id = $1`, [run.id]);

    const res = await post(`/api/runs/${run.id}/resume`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.fromStep, 2);
    // The scripted engine settles the resumed run quickly; the resume itself
    // is what this proves — queued with the continue point set.
    const reloaded = await getRun(db, run.id);
    assert.ok(['queued', 'running', 'completed'].includes(reloaded?.status ?? ''));
    assert.equal(reloaded?.resumeFromStep, 2);
  });

  test('resume refuses a run that was never interrupted', async () => {
    const run = await createRun(db, { prompt: 'fresh', engine: 'scripted' });
    const res = await post(`/api/runs/${run.id}/resume`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_resumable');
  });
});
