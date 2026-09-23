/**
 * Data-layer tests — run against real PostgreSQL (PGlite, in-process).
 *
 *   npm test
 *
 * No network, no credentials, no database server: PGlite is PostgreSQL compiled
 * to WASM, so the schema, the partial indexes, the advisory lock and the
 * jsonb columns all behave exactly as they will on Neon.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, appendEvent, pruneRunEvents, markOrphanedRuns, type Db } from './db.js';
import { migrate, loadMigrations, resolveMigrationsDir } from './migrate.js';
import { loadConfig } from './config.js';

let db: Db;

async function makeRun(id: string, status = 'running', startedAt?: string): Promise<void> {
  await db.query(
    `INSERT INTO runs (id, kind, prompt, status, engine, started_at)
     VALUES ($1, 'chat', 'test prompt', $2, 'antigravity-preview-05-2026',
             COALESCE($3::timestamptz, now()))`,
    [id, status, startedAt ?? null],
  );
}

before(async () => {
  db = await createDb('');
  const result = await migrate(db);
  // Derived from the migrations directory itself, so adding a new migration
  // file can never stale this assertion again.
  const expected = loadMigrations(resolveMigrationsDir()).map((m) => m.version);
  assert.deepEqual(result.applied, expected, `fresh database should apply migrations ${expected.join(', ')}`);
});

after(async () => {
  await db.close();
});

describe('migrations', () => {
  test('are idempotent', async () => {
    const again = await migrate(db);
    assert.deepEqual(again.applied, [], 'second run applies nothing');
    const expected = loadMigrations(resolveMigrationsDir()).map((m) => m.version);
    assert.deepEqual(again.skipped, expected, 'every migration on disk is skipped');
  });

  test('filenames follow NNN_name.sql and sort numerically', () => {
    const migrations = loadMigrations(resolveMigrationsDir());
    assert.ok(migrations.length >= 1);
    assert.equal(migrations[0].version, 1);
    for (let i = 1; i < migrations.length; i++) {
      assert.ok(migrations[i].version > migrations[i - 1].version, 'versions ascend');
    }
  });

  test('create every table the plan specifies', async () => {
    const expected = [
      'artifacts',
      'budgets',
      'conversations',
      'memories',
      'memory_profile',
      'messages',
      'reminders',
      'run_events',
      'runs',
      'schema_migrations',
      'secrets',
      'settings',
      'wa_state',
      'wa_updates',
    ];
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    assert.deepEqual(
      rows.map((r) => r.table_name),
      expected,
    );
  });
});

describe('run_events', () => {
  test('allocate a gap-free sequence starting at 1', async () => {
    await makeRun('run_seq');
    const seqs: number[] = [];
    for (const type of ['run.started', 'thought', 'run.completed']) {
      seqs.push(await db.transaction((tx) => appendEvent(tx, 'run_seq', type, { type })));
    }
    assert.deepEqual(seqs, [1, 2, 3]);

    const replay = await db.query<{ seq: number; type: string }>(
      'SELECT seq, type FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq',
      ['run_seq', 1],
    );
    assert.deepEqual(replay.map((r) => r.seq), [2, 3], '?after=1 replays only the tail');
  });

  test('reject duplicate sequence numbers for the same run', async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO run_events (run_id, seq, type, payload) VALUES ('run_seq', 1, 'dup', '{}'::jsonb)`,
      ),
      /duplicate key|unique/i,
    );
  });

  test('cascade when a run is deleted', async () => {
    await db.exec(`DELETE FROM runs WHERE id = 'run_seq'`);
    const rows = await db.query('SELECT 1 FROM run_events WHERE run_id = $1', ['run_seq']);
    assert.equal(rows.length, 0);
  });

  test('prune only events older than the retention window', async () => {
    await makeRun('run_prune');
    await db.transaction((tx) => appendEvent(tx, 'run_prune', 'old', {}));
    await db.exec(`UPDATE run_events SET at = now() - interval '30 days' WHERE run_id = 'run_prune'`);
    await db.transaction((tx) => appendEvent(tx, 'run_prune', 'fresh', {}));

    const deleted = await pruneRunEvents(db, 14);
    assert.equal(deleted, 1, 'only the 30-day-old event is removed');

    const left = await db.query<{ type: string }>('SELECT type FROM run_events WHERE run_id = $1', [
      'run_prune',
    ]);
    assert.deepEqual(left.map((r) => r.type), ['fresh']);
  });
});

describe('quota guards', () => {
  // These tests share one database, and the "single active run" index is global,
  // so each case starts from a clean slate.
  async function completeAllRuns(): Promise<void> {
    await db.exec(`UPDATE runs SET status = 'completed' WHERE status IN ('queued','running','paused')`);
  }

  test('at most one run may be active at a time', async () => {
    await completeAllRuns();
    await makeRun('run_active_1');

    await assert.rejects(
      makeRun('run_active_2'),
      /duplicate key|unique/i,
      'a second concurrent run must be refused by the database',
    );

    await db.exec(`UPDATE runs SET status = 'completed' WHERE id = 'run_active_1'`);
    await makeRun('run_active_2');
    const rows = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = 'run_active_2'`);
    assert.equal(rows[0].status, 'running', 'once the first finishes, a new run is allowed');
  });

  test('mark stale in-flight runs as orphaned', async () => {
    await completeAllRuns();
    await makeRun('run_stale', 'running', new Date(Date.now() - 90 * 60_000).toISOString());

    const recovered = await markOrphanedRuns(db, 60);
    assert.equal(recovered, 1, 'exactly the stale run is recovered');

    const rows = await db.query<{ status: string; error_type: string }>(
      `SELECT status, error_type FROM runs WHERE id = 'run_stale'`,
    );
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].error_type, 'orphaned');
  });

  test('leaves fresh in-flight runs alone', async () => {
    await completeAllRuns();
    await makeRun('run_fresh', 'running', new Date().toISOString());

    const recovered = await markOrphanedRuns(db, 60);
    assert.equal(recovered, 0);

    const rows = await db.query<{ status: string }>(`SELECT status FROM runs WHERE id = 'run_fresh'`);
    assert.equal(rows[0].status, 'running');
    await completeAllRuns();
  });
});

describe('whatsapp idempotency', () => {
  test('a repeated wamid cannot create a second task', async () => {
    await db.query(`INSERT INTO wa_updates (wamid, kind) VALUES ('wamid_ABC', 'text')`);
    await assert.rejects(
      db.query(`INSERT INTO wa_updates (wamid, kind) VALUES ('wamid_ABC', 'text')`),
      /duplicate key|unique/i,
      'replaying an offset must never execute the same message twice',
    );
  });

  test('poll cursor is a true 64-bit value', async () => {
    const big = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    await db.query(`INSERT INTO wa_state (agent_id, poll_offset) VALUES ('agent_1', $1)`, [
      big.toString(),
    ]);
    const rows = await db.query<{ poll_offset: string }>(
      `SELECT poll_offset::text FROM wa_state WHERE agent_id = 'agent_1'`,
    );
    assert.equal(rows[0].poll_offset, big.toString(), 'cursor survives as an exact integer');
  });
});

describe('memory constraints (ported from v1 behaviour)', () => {
  test('duplicate content is rejected even with different ids', async () => {
    await db.query(
      `INSERT INTO memories (id, category, content) VALUES ('mem_a', 'preference', 'User prefers React')`,
    );
    await assert.rejects(
      db.query(
        `INSERT INTO memories (id, category, content) VALUES ('mem_b', 'fact', 'user prefers react')`,
      ),
      /duplicate key|unique/i,
      'case-insensitive content dedup is enforced in the database, not in code',
    );
  });

  test('invalid category is rejected by the check constraint', async () => {
    await assert.rejects(
      db.query(`INSERT INTO memories (id, category, content) VALUES ('mem_c', 'nonsense', 'x')`),
      /check constraint|violates/i,
    );
  });
});

describe('config validation', () => {
  test('production requires DATABASE_URL and secrets', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      /DATABASE_URL is required|SESSION_SECRET|MASTER_KEY/,
    );
  });

  /** The minimum a production deployment needs to boot. */
  const productionEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require',
    SESSION_SECRET: 'a'.repeat(40),
    MASTER_KEY: 'b'.repeat(64),
    ACCESS_KEY: 'an-access-key-long-enough-to-pass',
    GEMINI_API_KEY: 'test-key',
    PORT: '10000',
  };

  test('a valid production environment passes', () => {
    const config = loadConfig({ ...productionEnv } as NodeJS.ProcessEnv);
    assert.equal(config.port, 10000);
    assert.equal(config.dailyRunBudget, 100);
    assert.equal(config.pollerEnabled, false);
  });

  test('the real agent is the default engine', () => {
    // Not scripted: a deployment that silently ran the demo engine would look
    // like the agent working while nothing real ever ran.
    assert.equal(loadConfig({ ...productionEnv } as NodeJS.ProcessEnv).engineName, 'antigravity');
  });

  test('production boots the real engine without an env key — it warns, the key can come from Settings', () => {
    const { GEMINI_API_KEY: _omitted, ...withoutKey } = productionEnv;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const config = loadConfig({ ...withoutKey } as NodeJS.ProcessEnv);
      assert.equal(config.engineName, 'antigravity');
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((w) => w.includes('GEMINI_API_KEY')),
      'the missing key is warned about, not silently ignored',
    );
  });

  test('but the scripted engine is allowed without a key', () => {
    const { GEMINI_API_KEY: _omitted, ...withoutKey } = productionEnv;
    const config = loadConfig({ ...withoutKey, ENGINE: 'scripted' } as NodeJS.ProcessEnv);
    assert.equal(config.engineName, 'scripted');
  });

  test('an unknown engine name is rejected rather than ignored', () => {
    assert.throws(
      () => loadConfig({ ...productionEnv, ENGINE: 'gpt5' } as NodeJS.ProcessEnv),
      /ENGINE must be/,
    );
  });

  test('the agent id is configurable, because it is date-stamped', () => {
    const config = loadConfig({
      ...productionEnv,
      ANTIGRAVITY_AGENT: 'antigravity-preview-12-2026',
    } as NodeJS.ProcessEnv);
    assert.equal(config.antigravityAgent, 'antigravity-preview-12-2026');
    assert.match(loadConfig({ ...productionEnv } as NodeJS.ProcessEnv).antigravityAgent, /^antigravity-preview-\d{2}-\d{4}$/);
  });

  test('refuses a weak access key in production', () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@host/db',
          SESSION_SECRET: 'a'.repeat(40),
          MASTER_KEY: 'b'.repeat(64),
          ACCESS_KEY: 'short',
        } as NodeJS.ProcessEnv),
      /ACCESS_KEY must be at least 12 characters/,
    );
  });

  test('open mode needs no key at all', () => {
    const { ACCESS_KEY: _omitted, ...rest } = productionEnv;
    const config = loadConfig({ ...rest, AUTH_MODE: 'open' } as NodeJS.ProcessEnv);
    assert.equal(config.authMode, 'open');
    assert.equal(config.accessKey, '');
  });

  test('key mode is the default', () => {
    assert.equal(loadConfig({ ...productionEnv } as NodeJS.ProcessEnv).authMode, 'key');
  });

  /**
   * The local papercut this covers: with key mode and no key, `checkAccessKey`
   * matches nothing, so `npm run dev` served a sign-in screen that could not be
   * passed — every route 401, including the form that issues the session.
   */
  test('a local run with no key opens rather than locking you out', () => {
    const config = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    assert.equal(config.authMode, 'open');
    assert.equal(config.accessKey, '');
  });

  test('but asking for key mode explicitly without a key is an error', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'development', AUTH_MODE: 'key' } as NodeJS.ProcessEnv),
      /ACCESS_KEY/,
    );
  });

  test('a local run with a key keeps key mode', () => {
    const config = loadConfig({ NODE_ENV: 'development', ACCESS_KEY: 'local-dev-key' } as NodeJS.ProcessEnv);
    assert.equal(config.authMode, 'key');
    assert.equal(config.accessKey, 'local-dev-key');
  });

  test('an unknown AUTH_MODE is rejected rather than silently guessed', () => {
    assert.throws(
      () => loadConfig({ ...productionEnv, AUTH_MODE: 'yolo' } as NodeJS.ProcessEnv),
      /AUTH_MODE must be "key" or "open"/,
    );
  });

  test('refuses a poller with no token (the "silent spin" trap)', () => {
    assert.throws(
      () => loadConfig({ POLLER_ENABLED: 'true' } as NodeJS.ProcessEnv),
      /WHATSAPP_TOKEN is empty/,
    );
  });

  test('rejects a malformed MASTER_KEY', () => {
    assert.throws(
      () => loadConfig({ MASTER_KEY: 'not-hex' } as NodeJS.ProcessEnv),
      /64 hex characters/,
    );
  });
});
