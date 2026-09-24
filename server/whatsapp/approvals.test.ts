/**
 * Approve-by-WhatsApp.
 *
 * The claims being tested:
 *
 *   - "yes" approves a waiting plan (run goes queued, executor starts it),
 *     "no" rejects it (run cancelled), anything else is fed back as requested
 *     changes (plan gains the note, still waiting).
 *   - A LinkedIn draft is published on "yes", discarded on "no".
 *   - Only the owner's reply counts: anyone else's "yes" is ignored and the
 *     message flows on untouched.
 *   - With no open ask, messages flow to the relay untouched.
 *   - Without a token the asks are silent: no send, no claim, no error.
 *   - One ask per item: a second ask for the same waiting plan is a no-op.
 */
import test, { after, afterEach, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from '../db.js';
import { migrate } from '../migrate.js';
import { loadConfig, type AppConfig } from '../config.js';
import { EventBus } from '../events.js';
import {
  createRun,
  getRun,
  saveRunPlan,
  setRunStatus,
  type PlanStep,
  type Run,
} from '../runs.js';
import type { SecretName } from '../settings.js';
import { directionPayload } from '../design/directions.js';
import { saveCreatorId } from './store.js';
import { WhatsAppPoller } from './poller.js';
import type { InboundMessage } from './api.js';
import {
  findPendingApproval,
  maybeAskDraftApproval,
  maybeAskPlanApproval,
  maybeHandleApprovalReply,
  parseApprovalReply,
  resolveApproval,
  stripChangePrefix,
  type HandleDeps,
} from './approvals.js';

const TOKEN = 'wa-agent-api-key-from-the-phone';
const CREATOR = 'user:creator-01';
const STRANGER = 'user:someone-else';

let db: Db;

function makeConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'key',
    ACCESS_KEY: 'approvals-test-key',
    SESSION_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    MASTER_KEY: 'd4e5f6a7'.repeat(8),
    ENGINE: 'scripted',
  } as NodeJS.ProcessEnv);
}

/** A stand-in for the agent API that only records outbound sends. */
async function fakePlatform(): Promise<{ url: string; sends: string[]; close(): Promise<void> }> {
  const sends: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/messages') {
        const body = JSON.parse(raw) as { text?: { body?: string } };
        sends.push(body.text?.body ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: 'wamid.1' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sends,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const secrets = (token: string | null, to: string | null = null) => ({
  get: (name: SecretName) => (name === 'whatsapp_to' ? to ?? '' : token ?? ''),
});

async function learnCreator(id: string = CREATOR): Promise<void> {
  await saveCreatorId(db, 'agent-test', id);
}

const STEPS: PlanStep[] = [
  { index: 1, total: 2, label: 'Research the options' },
  { index: 2, total: 2, label: 'Write the summary' },
];

async function makeAwaitingPlan(prompt = 'Build the thing'): Promise<Run> {
  const run = await createRun(db, { prompt, kind: 'chat', engine: 'scripted' });
  await saveRunPlan(db, run.id, STEPS);
  await setRunStatus(db, run.id, 'awaiting_plan');
  return (await getRun(db, run.id)) as Run;
}

/** A prompt the UI gate recognises, so the plan carries the direction ask. */
const BUILD_PROMPT = 'Build the landing page for my studio with a hero and a gallery';

async function makeDraft(): Promise<string> {
  const run = await createRun(db, { prompt: 'Post on LinkedIn', kind: 'chat', engine: 'scripted' });
  await setRunStatus(db, run.id, 'completed');
  await db.query(`INSERT INTO linkedin_drafts (id, run_id, text) VALUES ('lid_test1', $1, $2)`, [
    run.id,
    'Hello LinkedIn — this is the draft.',
  ]);
  return 'lid_test1';
}

function inbound(text: string, from: string = CREATOR, id = `wamid.${Math.random()}`): InboundMessage {
  return { id, from, timestamp: null, type: 'text', text, contextId: null, profileName: null };
}

function handleDeps(overrides: Partial<HandleDeps> = {}): HandleDeps & { started: string[] } {
  const started: string[] = [];
  return {
    db,
    bus: new EventBus(),
    executor: {
      start: (run: Run) => void started.push(run.id),
      cancel: () => false,
    },
    masterKey: 'test-master-key',
    secrets: secrets(TOKEN),
    started,
    ...overrides,
  };
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

afterEach(async () => {
  await db.query(`DELETE FROM wa_approvals`);
  await db.query(`DELETE FROM wa_state`);
  await db.query(`DELETE FROM linkedin_drafts`);
  await db.query(`DELETE FROM runs`);
});

describe('parseApprovalReply', () => {
  test('yes-shapes approve', () => {
    for (const t of ['yes', 'YES', 'yeah', 'yep', 'ok', 'OK', 'approve', 'approved', '👍', 'do it']) {
      assert.equal(parseApprovalReply(t), 'approve', t);
    }
  });

  test('no-shapes reject', () => {
    for (const t of ['no', 'NO', 'nope', 'nah', 'reject', 'rejected', 'cancel', '👎']) {
      assert.equal(parseApprovalReply(t), 'reject', t);
    }
  });

  test('change prefixes and free text are requested changes', () => {
    for (const t of [
      'change: make it shorter',
      'CHANGE: use firebase',
      'edit: fix the hook',
      'looks good but add a testing step',
      'maybe later?',
    ]) {
      assert.equal(parseApprovalReply(t), 'changes', t);
    }
  });

  test('stripChangePrefix removes the prefix only', () => {
    assert.equal(stripChangePrefix('change: make it shorter'), 'make it shorter');
    assert.equal(stripChangePrefix('EDIT: x'), 'x');
    assert.equal(stripChangePrefix('just a thought'), 'just a thought');
  });
});

describe('maybeAskPlanApproval', () => {
  test('silent without a token: no send, no claim, no error', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    const run = await makeAwaitingPlan();
    const ok = await maybeAskPlanApproval(
      { db, secrets: secrets(null), baseUrl: platform.url },
      run,
      STEPS,
    );
    assert.equal(ok, false);
    assert.equal(platform.sends.length, 0);
    assert.equal(await findPendingApproval(db), null);
  });

  test('sends the plan once, with the reply line', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await learnCreator();

    const run = await makeAwaitingPlan();
    const ok = await maybeAskPlanApproval(
      { db, secrets: secrets(TOKEN), baseUrl: platform.url },
      run,
      STEPS,
    );
    assert.equal(ok, true);
    assert.equal(platform.sends.length, 1);
    const text = platform.sends[0];
    assert.ok(text.includes('📋 Plan ready'));
    assert.ok(text.includes('Research the options'));
    assert.ok(text.includes('YES to approve'));
    const pending = await findPendingApproval(db);
    assert.ok(pending);
    assert.equal(pending.kind, 'plan');
    assert.equal(pending.refId, run.id);
  });

  test('one ask per item: the second ask is a no-op', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await learnCreator();

    const run = await makeAwaitingPlan();
    const deps = { db, secrets: secrets(TOKEN), baseUrl: platform.url };
    assert.equal(await maybeAskPlanApproval(deps, run, STEPS), true);
    assert.equal(await maybeAskPlanApproval(deps, run, STEPS), false);
    assert.equal(platform.sends.length, 1);
  });
});

describe('maybeAskDraftApproval', () => {
  test('silent without a token', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());

    const ok = await maybeAskDraftApproval({ db, secrets: secrets(null), baseUrl: platform.url }, 'lid_x', 'text');
    assert.equal(ok, false);
    assert.equal(platform.sends.length, 0);
    assert.equal(await findPendingApproval(db), null);
  });

  test('sends the draft with the reply line, once', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await learnCreator();

    const draftId = await makeDraft();
    const deps = { db, secrets: secrets(TOKEN), baseUrl: platform.url };
    assert.equal(await maybeAskDraftApproval(deps, draftId, 'Hello LinkedIn — this is the draft.'), true);
    assert.equal(await maybeAskDraftApproval(deps, draftId, 'Hello LinkedIn — this is the draft.'), false);
    assert.equal(platform.sends.length, 1);
    assert.ok(platform.sends[0].includes('📝 LinkedIn draft ready'));
    assert.ok(platform.sends[0].includes('Hello LinkedIn'));
    assert.ok(platform.sends[0].includes('YES to publish'));
  });
});

describe('the direction ask travels with the plan', () => {
  test('a build gets the proposal, its alternates, and a way to say you choose', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await learnCreator();

    const run = await makeAwaitingPlan(BUILD_PROMPT);
    const ok = await maybeAskPlanApproval(
      { db, secrets: secrets(TOKEN), baseUrl: platform.url },
      run,
      STEPS,
    );
    assert.equal(ok, true);
    const text = platform.sends[0];
    assert.ok(/🎨 Direction: \w+ — /.test(text), 'the proposal is named, in full');
    assert.ok(text.includes('1. '), 'and the alternates are numbered for a phone keyboard');
    assert.ok(text.includes('CHOOSE to keep this one'), 'including the option not to choose');
    assert.ok(text.includes('YES to approve'), 'and the ask is still an approval');
  });

  test('a task that is not a build is not asked about its direction', async (t) => {
    const platform = await fakePlatform();
    t.after(() => platform.close());
    await learnCreator();

    const run = await makeAwaitingPlan();
    await maybeAskPlanApproval({ db, secrets: secrets(TOKEN), baseUrl: platform.url }, run, STEPS);
    const text = platform.sends[0];
    assert.ok(!text.includes('🎨 Direction'), 'no direction block on a task that builds nothing');
    assert.ok(!text.includes('1/2/3'), 'and no numbered reply to confuse the plan steps');
  });

  test('a number records the direction and does not become a plan edit', async () => {
    // The order matters: `parseApprovalReply` maps anything that is not yes/no
    // to CHANGE, so a bare "2" would otherwise be appended to the plan as
    // "Operator change: 2" and the direction would never be chosen.
    await learnCreator();
    const run = await makeAwaitingPlan(BUILD_PROMPT);
    await db.query(`INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_dir', 'plan', $1)`, [run.id]);
    const deps = handleDeps();

    const result = await maybeHandleApprovalReply(deps, inbound('2'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('🎨 Direction:'), result.reply);
    assert.ok(result.reply.includes('Reply YES to approve'), 'the approval is still the operator\'s to give');
    const updated = await getRun(db, run.id);
    // Asserted against the payload rather than a hard-coded name: what matters
    // is that the number picks the alternate *listed second*, in the same list
    // the message carried.
    assert.equal(
      updated?.direction,
      directionPayload(BUILD_PROMPT).chips[1].id,
      'the second alternate, in the order it was listed',
    );
    assert.equal(updated?.status, 'awaiting_plan', 'and nothing was approved');
    assert.equal(updated?.plan?.length, STEPS.length, 'and the plan was not edited');
    const events = await db.query<{ type: string; payload: { chosenBy?: string } }>(
      `SELECT type, payload FROM run_events WHERE run_id = $1 AND type = 'design.direction'`,
      [run.id],
    );
    assert.equal(events[0]?.payload.chosenBy, 'operator');
  });

  test('CHOOSE keeps the proposal, and says it was not chosen by hand', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan(BUILD_PROMPT);
    await db.query(`INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_dir2', 'plan', $1)`, [run.id]);
    const result = await maybeHandleApprovalReply(handleDeps(), inbound('choose'));
    assert.equal(result.handled, true);
    const updated = await getRun(db, run.id);
    assert.ok(updated?.direction, 'the proposal is stored');
    const events = await db.query<{ payload: { chosenBy?: string } }>(
      `SELECT payload FROM run_events WHERE run_id = $1 AND type = 'design.direction'`,
      [run.id],
    );
    assert.equal(events[0]?.payload.chosenBy, 'auto');
  });

  test('a change note that contains a number is still a change note', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan(BUILD_PROMPT);
    await db.query(`INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_dir3', 'plan', $1)`, [run.id]);
    const result = await maybeHandleApprovalReply(handleDeps(), inbound('change: make it 2 lines shorter'));
    assert.equal(result.handled, true);
    assert.equal((await getRun(db, run.id))?.direction, null, 'nothing was chosen');
    assert.equal((await getRun(db, run.id))?.plan?.length, STEPS.length + 1, 'and the note landed on the plan');
  });

  test('a number on a task that is not a build is not a direction', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await db.query(`INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_dir4', 'plan', $1)`, [run.id]);
    const result = await maybeHandleApprovalReply(handleDeps(), inbound('2'));
    assert.equal(result.handled, true);
    assert.equal((await getRun(db, run.id))?.direction, null);
    assert.ok(!result.reply.includes('🎨 Direction:'), result.reply);
  });
});

describe('maybeHandleApprovalReply', () => {
  test('no pending approval: not handled, nothing touched', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('yes'));
    assert.equal(result.handled, false);
    assert.equal((await getRun(db, run.id))?.status, 'awaiting_plan');
    assert.equal(deps.started.length, 0);
  });

  test("a stranger's yes is ignored", async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('yes', STRANGER));
    assert.equal(result.handled, false);
    assert.equal((await getRun(db, run.id))?.status, 'awaiting_plan');
    assert.equal(deps.started.length, 0);
    // The ask is still open for the owner.
    assert.ok(await findPendingApproval(db));
  });

  test('approve-by-yes: run goes queued and the executor starts it', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('yes'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('✅ Plan approved'));
    assert.equal((await getRun(db, run.id))?.status, 'queued');
    assert.deepEqual(deps.started, [run.id]);
    assert.equal(await findPendingApproval(db), null);
  });

  test('reject-by-no: run is cancelled', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('no'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('🛑 Plan rejected'));
    assert.equal((await getRun(db, run.id))?.status, 'cancelled');
    assert.equal(deps.started.length, 0);
    assert.equal(await findPendingApproval(db), null);
  });

  test('change-feedback round-trip: note appended, still waiting, ask stays open', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('change: add a testing step at the end'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('📝 Noted'));

    const updated = (await getRun(db, run.id)) as Run;
    assert.equal(updated.status, 'awaiting_plan');
    assert.equal(updated.plan?.length, 3);
    assert.ok(updated.plan?.[2].label.includes('add a testing step at the end'));
    assert.equal(deps.started.length, 0);
    // The ask stays open so he can iterate, then approve.
    const pending = await findPendingApproval(db);
    assert.ok(pending);
    assert.ok(pending.feedback?.includes('add a testing step'));

    // And the follow-up "yes" approves the amended plan.
    const again = await maybeHandleApprovalReply(deps, inbound('yes'));
    assert.equal(again.handled, true);
    assert.equal((await getRun(db, run.id))?.status, 'queued');
    assert.deepEqual(deps.started, [run.id]);
  });

  test('stale ask: run already decided elsewhere resolves as stale', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await setRunStatus(db, run.id, 'completed');
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('yes'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('not waiting anymore'));
    assert.equal(deps.started.length, 0);
    assert.equal(await findPendingApproval(db), null);
  });

  test('draft yes without a LinkedIn connection warns and stays pending', async () => {
    await learnCreator();
    const draftId = await makeDraft();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'linkedin_draft', $1)`,
      [draftId],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('yes'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('Could not publish'));
    const rows = await db.query<{ status: string }>(
      `SELECT status FROM linkedin_drafts WHERE id = $1`,
      [draftId],
    );
    assert.equal(rows[0].status, 'pending');
    assert.ok(await findPendingApproval(db), 'ask stays open');
  });

  test('draft no discards the draft', async () => {
    await learnCreator();
    const draftId = await makeDraft();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'linkedin_draft', $1)`,
      [draftId],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('no'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('🗑️ Draft discarded'));
    const rows = await db.query<{ status: string; error: string }>(
      `SELECT status, error FROM linkedin_drafts WHERE id = $1`,
      [draftId],
    );
    assert.equal(rows[0].status, 'failed');
    assert.ok(rows[0].error.includes('Discarded by the operator'));
    assert.equal(await findPendingApproval(db), null);
  });

  test('draft change feedback is noted and stays pending', async () => {
    await learnCreator();
    const draftId = await makeDraft();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'linkedin_draft', $1)`,
      [draftId],
    );
    const deps = handleDeps();
    const result = await maybeHandleApprovalReply(deps, inbound('make the hook punchier'));
    assert.equal(result.handled, true);
    assert.ok(result.reply.includes('📝 Feedback noted'));
    const rows = await db.query<{ status: string }>(
      `SELECT status FROM linkedin_drafts WHERE id = $1`,
      [draftId],
    );
    assert.equal(rows[0].status, 'pending');
    assert.ok(await findPendingApproval(db));
  });

  test('whatsapp_to override counts as the owner', async () => {
    // No learned creator id; the override identifies the owner instead.
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const deps = handleDeps({ secrets: secrets(TOKEN, 'user:override-9') });
    const result = await maybeHandleApprovalReply(deps, inbound('yes', 'user:override-9'));
    assert.equal(result.handled, true);
    assert.equal((await getRun(db, run.id))?.status, 'queued');
  });
});

describe('poller interception', () => {
  function makePoller(sent: string[], acceptCalls: string[]) {
    const config = makeConfig();
    return new WhatsAppPoller({
      db,
      bus: new EventBus(),
      client: { getUpdates: async () => null } as never,
      sender: {
        send: async (text: string) => {
          sent.push(text);
          return true;
        },
        markRead: async () => true,
      } as never,
      executor: { start: () => undefined, cancel: () => false } as never,
      config,
      secrets: secrets(TOKEN),
      accept: async (input) => {
        acceptCalls.push(input.prompt);
        return { ok: false, reason: 'in_progress', active: { id: 'x', prompt: 'busy' } as Run };
      },
    });
  }

  test('an approval reply never reaches the accept path', async () => {
    await learnCreator();
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    const sent: string[] = [];
    const acceptCalls: string[] = [];
    const poller = makePoller(sent, acceptCalls);

    await poller.handleMessage(inbound('yes', CREATOR, 'wamid.poll.yes'));
    assert.equal(acceptCalls.length, 0, 'the reply must not become a mission');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('✅ Plan approved'));
    assert.equal((await getRun(db, run.id))?.status, 'queued');
  });

  test('no open ask: the message flows to the relay path untouched', async () => {
    await learnCreator();
    const sent: string[] = [];
    const acceptCalls: string[] = [];
    const poller = makePoller(sent, acceptCalls);

    await poller.handleMessage(inbound('yes', CREATOR, 'wamid.poll.plain'));
    assert.equal(acceptCalls.length, 1, 'with no ask open, "yes" is an ordinary message');
    assert.ok(sent[0].includes('still on this one'));
  });
});

describe('resolveApproval', () => {
  test('resolving twice keeps the first resolution', async () => {
    const run = await makeAwaitingPlan();
    await db.query(
      `INSERT INTO wa_approvals (id, kind, ref_id) VALUES ('wap_1', 'plan', $1)`,
      [run.id],
    );
    await resolveApproval(db, 'wap_1', 'approved');
    await resolveApproval(db, 'wap_1', 'rejected');
    const rows = await db.query<{ resolution: string }>(
      `SELECT resolution FROM wa_approvals WHERE id = 'wap_1'`,
    );
    assert.equal(rows[0].resolution, 'approved');
  });
});
