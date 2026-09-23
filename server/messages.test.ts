import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { listMessages } from './runs.js';

let db: Db;

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

describe('listMessages', () => {
  it('returns the run status alongside each message', async () => {
    await db.query(`INSERT INTO conversations (id, title) VALUES ('c_hist', 't')`);
    await db.query(
      `INSERT INTO runs (id, kind, prompt, status, engine, started_at)
       VALUES ('r_hist', 'chat', 'p', 'completed', 'e', now())`,
    );
    await db.query(
      `INSERT INTO messages (id, conversation_id, role, content, run_id)
       VALUES ('m1', 'c_hist', 'user', 'hello', NULL),
              ('m2', 'c_hist', 'assistant', 'hi', 'r_hist'),
              ('m3', 'c_hist', 'assistant', 'no run attached', NULL)`,
    );
    const msgs = await listMessages(db, 'c_hist');
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].runStatus, null);
    assert.equal(msgs[1].runId, 'r_hist');
    assert.equal(msgs[1].runStatus, 'completed');
    assert.equal(msgs[2].runStatus, null);
  });
});
