/**
 * Planning support.
 *
 * Unit tests prove the heuristic and the parser. The wiring test proves the
 * part that matters: a progress line the agent speaks becomes a durable
 * `plan.milestone` event, and the planning contract reaches the engine only
 * for complex missions — never rewriting the stored prompt.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { createRun, getRun, readEvents } from './runs.js';
import type { Engine, EngineContext, EngineResult } from './engine/types.js';
import { looksComplex, parseMilestone, withPlanning } from './planning.js';

const COMPLEX_PROMPT =
  'Build a small expense tracker web page with a form to add expenses, a list showing them, ' +
  'localStorage persistence, and a monthly total at the top. Use plain HTML, CSS and JavaScript ' +
  'in a single file that works offline.';
const SIMPLE_PROMPT = 'What is the capital of France?';

/** Announces its steps the way the planning protocol asks. */
class PlanningEngine implements Engine {
  readonly name = 'planning';
  readonly prompts: string[] = [];

  async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
    this.prompts.push(prompt);
    ctx.log('Step 1/2: gather the requirements');
    ctx.log('Step 1/2 done: requirements listed');
    ctx.log('Step 2/2: write the page');
    ctx.text('done');
    return { text: 'done' };
  }
}

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

async function settle(runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await getRun(db, runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

describe('looksComplex', () => {
  test('short questions are not complex', () => {
    assert.equal(looksComplex(SIMPLE_PROMPT), false);
    assert.equal(looksComplex(''), false);
  });

  test('long, listed and build-like missions are complex', () => {
    assert.equal(looksComplex(COMPLEX_PROMPT), true);
    assert.equal(looksComplex('x'.repeat(600)), true);
    assert.equal(looksComplex('one\ntwo\nthree\nfour'), true);
    assert.equal(looksComplex('Do these things:\n1. first\n2. second'), true);
  });
});

describe('withPlanning', () => {
  test('wraps complex missions and leaves simple ones untouched', () => {
    const wrapped = withPlanning(COMPLEX_PROMPT);
    assert.ok(wrapped.includes('[Planning protocol'));
    assert.ok(wrapped.endsWith(COMPLEX_PROMPT));
    assert.equal(withPlanning(SIMPLE_PROMPT), SIMPLE_PROMPT);
  });
});

describe('parseMilestone', () => {
  test('parses plan and done lines', () => {
    assert.deepEqual(parseMilestone('Step 1/3: research the topic'), {
      index: 1,
      total: 3,
      label: 'research the topic',
      done: false,
    });
    assert.deepEqual(parseMilestone('Step 2/3 done: parser written'), {
      index: 2,
      total: 3,
      label: 'parser written',
      done: true,
    });
    assert.deepEqual(parseMilestone('step 1 of 2 — gather data'), {
      index: 1,
      total: 2,
      label: 'gather data',
      done: false,
    });
  });

  test('rejects non-milestones and nonsense', () => {
    assert.equal(parseMilestone('hello world'), null);
    assert.equal(parseMilestone('Step 0/3: nope'), null);
    assert.equal(parseMilestone('Step 4/3: impossible'), null);
    assert.equal(parseMilestone('I am on step 2 of the process now'), null);
  });
});

describe('executor planning wiring', () => {
  test('step lines become durable plan.milestone events', async () => {
    const engine = new PlanningEngine();
    const executor = new RunExecutor({ db, bus: new EventBus(), engine });

    const run = await createRun(db, { prompt: COMPLEX_PROMPT, kind: 'chat', engine: 'planning' });
    executor.start(run);
    await settle(run.id);

    const events = await readEvents(db, run.id, 0, 1000);
    const milestones = events.filter((e) => e.type === 'plan.milestone');
    assert.equal(milestones.length, 3);
    assert.deepEqual(milestones[0].payload, {
      index: 1,
      total: 2,
      label: 'gather the requirements',
      done: false,
    });
    assert.equal(milestones[1].payload.done, true);
    // The contract reached the engine on the wire…
    assert.ok(engine.prompts[0].includes('[Planning protocol'));
    // …while the stored prompt is untouched.
    const stored = await getRun(db, run.id);
    assert.equal(stored?.prompt, COMPLEX_PROMPT);
  });

  test('simple missions run without the contract', async () => {
    const engine = new PlanningEngine();
    const executor = new RunExecutor({ db, bus: new EventBus(), engine });

    const run = await createRun(db, { prompt: SIMPLE_PROMPT, kind: 'chat', engine: 'planning' });
    executor.start(run);
    await settle(run.id);

    assert.equal(engine.prompts[0], SIMPLE_PROMPT);
  });
});
