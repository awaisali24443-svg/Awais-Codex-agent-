/**
 * Conversation list ordering tests.
 *
 * The sidebar must show the most recently *used* conversation first — a new
 * message in an old conversation bubbles it to the top. Ordering by
 * created_at instead buries active conversations under newer idle ones.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { listConversations } from './runs.js';
import { ensureMainBranch } from './branches.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

async function addConversation(id: string, title: string, createdAgo: string): Promise<void> {
  await db.query(
    `INSERT INTO conversations (id, title, source, created_at)
     VALUES ($1, $2, 'web', now() - $3::interval)`,
    [id, title, createdAgo],
  );
}

async function addRun(id: string, conversationId: string, startedAgo: string): Promise<void> {
  await db.query(
    `INSERT INTO runs (id, conversation_id, kind, prompt, status, engine, started_at)
     VALUES ($1, $2, 'chat', 'hello', 'completed', 'test', now() - $3::interval)`,
    [id, conversationId, startedAgo],
  );
}

test('a new run in an old conversation bubbles it above newer conversations', async () => {
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM runs');

  await addConversation('cnv_old', 'old conversation', '2 hours');
  await addConversation('cnv_new', 'new conversation', '1 hour');
  // Activity in the OLD conversation, right now.
  await addRun('run_1', 'cnv_old', '0 seconds');

  const convos = await listConversations(db);
  assert.deepEqual(
    convos.map((c) => c.id),
    ['cnv_old', 'cnv_new'],
    'most recently active conversation must come first',
  );
});

test('a row carries the last thing said, and search finds it by its words', async () => {
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM runs');
  await db.query('DELETE FROM messages');

  await addConversation('cnv_x', 'quarterly report', '2 hours');
  await addConversation('cnv_y', 'unrelated', '1 hour');
  // Every conversation starts with one 'main' branch; messages land on it.
  const branchId = await ensureMainBranch(db, 'cnv_x');
  await db.query(
    `INSERT INTO messages (id, conversation_id, branch_id, role, content, created_at)
     VALUES ('msg_1', 'cnv_x', $1, 'assistant', 'The report is attached.\n\nIt took four hours.', now() - $2::interval)`,
    [branchId, '10 minutes'],
  );

  const convos = await listConversations(db);
  const row = convos.find((c) => c.id === 'cnv_x');
  assert.equal(row?.previewRole, 'assistant');
  // One line of room: newlines flattened, and nothing that could wrap the row.
  assert.equal(row?.preview, 'The report is attached. It took four hours.');

  // Search reaches the words inside a task, not only its title.
  const byWord = await listConversations(db, 50, 'FOUR HOURS');
  assert.deepEqual(byWord.map((c) => c.id), ['cnv_x'], 'a phrase from a message finds its task');
  const byTitle = await listConversations(db, 50, 'quarterly');
  assert.deepEqual(byTitle.map((c) => c.id), ['cnv_x']);
  const nothing = await listConversations(db, 50, 'no such words anywhere');
  assert.deepEqual(nothing, []);
});

test('conversations without runs fall back to creation order', async () => {
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM runs');

  await addConversation('cnv_a', 'a', '3 hours');
  await addConversation('cnv_b', 'b', '2 hours');
  await addConversation('cnv_c', 'c', '1 hour');

  const convos = await listConversations(db);
  assert.deepEqual(convos.map((c) => c.id), ['cnv_c', 'cnv_b', 'cnv_a']);
});
