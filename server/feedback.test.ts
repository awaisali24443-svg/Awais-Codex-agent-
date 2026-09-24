/**
 * What the operator said about an answer.
 *
 * Two things have to hold. First: the same rating twice is one row, not two —
 * he is allowed to change his mind, and the newest opinion is the one worth
 * keeping. Second: the reasons are a closed list, because a reason nobody can
 * count cannot be acted on, and a route that accepts anything would fill the
 * table with prose.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { ensureMainBranch } from './branches.js';
import {
  FEEDBACK_REASONS,
  clearFeedback,
  feedbackForMessages,
  feedbackSummary,
  normaliseNote,
  normaliseReason,
  saveFeedback,
} from './feedback.js';

let db: Db;
let seq = 0;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

/** A conversation with one answered question in it. */
async function seedAnsweredTask(prompt = 'summarise the report'): Promise<{ messageId: string; runId: string }> {
  seq += 1;
  const conversationId = `cnv_fb_${seq}`;
  const runId = `run_fb_${seq}`;
  const messageId = `msg_fb_${seq}`;
  await db.query(
    `INSERT INTO conversations (id, title, source) VALUES ($1, $2, 'web')`,
    [conversationId, prompt],
  );
  await db.query(
    `INSERT INTO runs (id, conversation_id, kind, prompt, status, engine)
     VALUES ($1, $2, 'chat', $3, 'completed', 'test')`,
    [runId, conversationId, prompt],
  );
  const branchId = await ensureMainBranch(db, conversationId);
  await db.query(
    `INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content)
     VALUES ($1, $2, $3, $4, 'assistant', 'Here is the summary.')`,
    [messageId, conversationId, branchId, runId],
  );
  return { messageId, runId };
}

test('a rating is stored against the message and its task', async () => {
  const { messageId, runId } = await seedAnsweredTask();
  const result = await saveFeedback(db, { messageId, rating: 'down', reason: 'wrong', note: 'It invented a number.' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.feedback.rating, 'down');
  assert.equal(result.feedback.reason, 'wrong');
  assert.equal(result.feedback.note, 'It invented a number.');
  assert.equal(result.feedback.runId, runId, 'so the rating can be read back against the task that produced it');
});

test('rating again replaces the row instead of adding one', async () => {
  const { messageId } = await seedAnsweredTask();
  await saveFeedback(db, { messageId, rating: 'down', reason: 'too_long' });
  await saveFeedback(db, { messageId, rating: 'up' });
  const rows = await db.query(`SELECT rating, reason FROM message_feedback WHERE message_id = $1`, [messageId]);
  assert.equal(rows.length, 1, 'one opinion per answer');
  assert.equal(rows[0].rating, 'up');
  // The reason belonged to the thumbs-down; keeping it would leave a good
  // rating carrying a complaint.
  assert.equal(rows[0].reason, null);
});

test('a rating that cannot be stored says why, in words', async () => {
  const { messageId } = await seedAnsweredTask();
  const noRating = await saveFeedback(db, { messageId, rating: 'maybe' });
  assert.equal(noRating.ok, false);

  const badReason = await saveFeedback(db, { messageId, rating: 'down', reason: 'because I said so' });
  assert.equal(badReason.ok, false);
  if (!badReason.ok) assert.match(badReason.message, /Unknown reason/);

  const upWithReason = await saveFeedback(db, { messageId, rating: 'up', reason: 'wrong' });
  assert.equal(upWithReason.ok, false, 'a good rating needs no complaint attached');

  const missing = await saveFeedback(db, { messageId: 'msg_not_here', rating: 'down' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'not_found');
});

test('a note is trimmed, capped, and an empty one is simply absent', () => {
  assert.deepEqual(normaliseNote('   '), { ok: true, value: null });
  assert.deepEqual(normaliseNote('  too   many\nspaces '), { ok: true, value: 'too many spaces' });
  assert.equal(normaliseNote('x'.repeat(501)).ok, false);
});

test('every reason the UI can send is one this file knows', () => {
  for (const reason of FEEDBACK_REASONS) {
    assert.deepEqual(normaliseReason('down', reason.id), { ok: true, value: reason.id });
    assert.ok(reason.label.length > 0, 'a reason a person cannot read is not a reason');
  }
  assert.equal(normaliseReason('down', 'nonsense').ok, false);
});

test('taking a rating back leaves nothing behind, and is harmless twice', async () => {
  const { messageId } = await seedAnsweredTask();
  await saveFeedback(db, { messageId, rating: 'up' });
  assert.equal(await clearFeedback(db, messageId), true);
  assert.equal(await clearFeedback(db, messageId), false);
  const rows = await db.query(`SELECT 1 FROM message_feedback WHERE message_id = $1`, [messageId]);
  assert.equal(rows.length, 0);
});

test('the ratings for a set of messages come back keyed, and only for those messages', async () => {
  const a = await seedAnsweredTask();
  const b = await seedAnsweredTask();
  await saveFeedback(db, { messageId: a.messageId, rating: 'up' });
  await saveFeedback(db, { messageId: b.messageId, rating: 'down', reason: 'off_topic' });

  const map = await feedbackForMessages(db, [a.messageId, b.messageId, 'msg_absent']);
  assert.equal(map.size, 2);
  assert.equal(map.get(a.messageId)?.rating, 'up');
  assert.equal(map.get(b.messageId)?.reason, 'off_topic');
  // No ids means no query at all — an unfiltered read here would be a way to
  // pull every rating in the database by asking for nothing.
  assert.equal((await feedbackForMessages(db, [])).size, 0);
});

test('the summary counts both directions and names the task that disappointed him', async () => {
  const before = await feedbackSummary(db, 50);
  const { messageId } = await seedAnsweredTask('write the pricing page');
  await saveFeedback(db, { messageId, rating: 'down', reason: 'broken', note: 'Half the buttons did nothing.' });

  const after = await feedbackSummary(db, 50);
  assert.equal(after.down, before.down + 1);
  assert.equal(after.recent[0].reasonLabel, 'Something was broken', 'the code is translated for the reader');
  assert.equal(after.recent[0].task, 'write the pricing page', 'and the task it was about is attached');
  assert.equal(after.recent[0].note, 'Half the buttons did nothing.');
});
