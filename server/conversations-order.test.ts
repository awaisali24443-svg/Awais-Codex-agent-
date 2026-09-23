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

test('conversations without runs fall back to creation order', async () => {
  await db.query('DELETE FROM conversations');
  await db.query('DELETE FROM runs');

  await addConversation('cnv_a', 'a', '3 hours');
  await addConversation('cnv_b', 'b', '2 hours');
  await addConversation('cnv_c', 'c', '1 hour');

  const convos = await listConversations(db);
  assert.deepEqual(convos.map((c) => c.id), ['cnv_c', 'cnv_b', 'cnv_a']);
});
