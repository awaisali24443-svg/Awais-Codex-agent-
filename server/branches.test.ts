import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { forkBranch, listBranches, ensureMainBranch } from './branches.js';
import { createRun, finishRun, listMessages } from './runs.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

/** One conversation with three completed turns on the main branch. */
async function seedConversation(): Promise<{ conversationId: string; main: string; userIds: string[] }> {
  const r1 = await createRun(db, { prompt: 'first', engine: 'test-engine' });
  const conversationId = r1.conversationId as string;
  await finishRun(db, r1.id, { status: 'completed', text: 'answer one' });
  const r2 = await createRun(db, { prompt: 'second', engine: 'test-engine', conversationId });
  await finishRun(db, r2.id, { status: 'completed', text: 'answer two' });
  const r3 = await createRun(db, { prompt: 'third', engine: 'test-engine', conversationId });
  await finishRun(db, r3.id, { status: 'completed', text: 'answer three' });
  const main = await ensureMainBranch(db, conversationId);
  const userIds = (
    await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at ASC, id ASC`,
      [conversationId],
    )
  ).map((r) => r.id);
  return { conversationId, main, userIds };
}

describe('branches', () => {
  it('creates a main branch per conversation and files messages under it', async () => {
    const { conversationId, main } = await seedConversation();
    const branches = await listBranches(db, conversationId);
    assert.equal(branches.length, 1);
    assert.equal(branches[0].id, main);
    assert.equal(branches[0].label, 'main');
    const msgs = await listMessages(db, conversationId);
    assert.ok(msgs.length > 0);
    for (const m of msgs) {
      const row = await db.query<{ branch_id: string }>(`SELECT branch_id FROM messages WHERE id = $1`, [m.id]);
      assert.equal(row[0].branch_id, main);
    }
  });

  it('forking at a message starts the new branch after the previous message', async () => {
    const { conversationId, userIds } = await seedConversation();
    // Fork at the second user message: the new branch shows everything up to
    // the message before 'second', but NOT 'second' itself.
    const forked = await forkBranch(db, conversationId, userIds[1]);
    assert.equal(forked.label, 'Branch 2');
    assert.ok(forked.parentBranchId);

    // The edited replacement + its answer land in the new branch.
    const r = await createRun(db, {
      prompt: 'second, but edited',
      engine: 'test-engine',
      conversationId,
      branchId: forked.id,
    });
    await finishRun(db, r.id, { status: 'completed', text: 'edited answer' });

    const view = await listMessages(db, conversationId, 200, forked.id);
    const contents = view.map((m) => m.content);
    assert.ok(contents.includes('first'), 'keeps messages before the fork');
    assert.ok(contents.includes('answer one'), 'keeps the earlier answer');
    assert.ok(!contents.includes('second'), 'hides the original forked message');
    assert.ok(!contents.includes('answer two'), 'hides the forked answer too');
    assert.ok(!contents.includes('third'), 'hides later parent messages');
    assert.ok(contents.includes('second, but edited'), 'shows the edited replacement');
    assert.ok(contents.includes('edited answer'), 'shows the new answer');

    // The parent branch is untouched.
    const mainView = await listMessages(db, conversationId);
    assert.ok(mainView.map((m) => m.content).includes('second'));
  });

  it('forking the first message starts the branch from the very beginning', async () => {
    const { conversationId, userIds } = await seedConversation();
    const forked = await forkBranch(db, conversationId, userIds[0]);
    assert.equal(forked.forkMessageId, null);
    const r = await createRun(db, {
      prompt: 'completely different start',
      engine: 'test-engine',
      conversationId,
      branchId: forked.id,
    });
    await finishRun(db, r.id, { status: 'completed', text: 'a different answer' });
    const view = await listMessages(db, conversationId, 200, forked.id);
    assert.deepEqual(view.map((m) => m.content), ['completely different start', 'a different answer']);
  });

  it('rejects a branch that does not belong to the conversation', async () => {
    const a = await createRun(db, { prompt: 'a', engine: 'test-engine' });
    await finishRun(db, a.id, { status: 'completed', text: 'a done' });
    const b = await createRun(db, { prompt: 'b', engine: 'test-engine' });
    await finishRun(db, b.id, { status: 'completed', text: 'b done' });
    const bMain = await ensureMainBranch(db, b.conversationId as string);
    await assert.rejects(
      createRun(db, { prompt: 'x', engine: 'test-engine', conversationId: a.conversationId, branchId: bMain }),
      /branch does not belong/,
    );
  });

  it('rejects forking a message from another conversation', async () => {
    const a = await createRun(db, { prompt: 'a2', engine: 'test-engine' });
    await finishRun(db, a.id, { status: 'completed', text: 'a2 done' });
    const b = await createRun(db, { prompt: 'b2', engine: 'test-engine' });
    await finishRun(db, b.id, { status: 'completed', text: 'b2 done' });
    const bMsg = await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND role = 'user' LIMIT 1`,
      [b.conversationId],
    );
    await assert.rejects(forkBranch(db, a.conversationId as string, bMsg[0].id), /not found/);
  });
});
