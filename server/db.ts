/**
 * Database adapter — one Postgres dialect, two drivers.
 *
 *   DATABASE_URL set  -> `pg` Pool   (Neon, or any Postgres)
 *   DATABASE_URL unset-> PGlite      (in-process Postgres, for tests/local dev)
 *
 * Keeping a single dialect means the schema, migrations and every query are
 * identical in dev, CI and production. The driver is the only difference.
 *
 * Neon specifics handled here:
 *   - SSL is required (sslmode=require in the connection string)
 *   - Neon hands out a *pooled* URL (PgBouncer, transaction mode) on hosts
 *     containing "-pooler". In that mode only transaction-scoped advisory
 *     locks and unnamed statements are safe, so:
 *       * we never use named prepared statements
 *       * we only take `pg_advisory_xact_lock`, never session-level locks
 *   - compute scales to zero, so the first query after idle pays a cold start;
 *     connect() therefore retries once instead of failing the request
 */
import pg from 'pg';

export type Dialect = 'pg' | 'pglite';

export interface Db {
  readonly dialect: Dialect;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run several statements with no parameters (migrations, DDL). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const PG_RETRY_DELAY_MS = 750;

function isNeonHost(connectionString: string): boolean {
  return /neon\.tech/i.test(connectionString);
}

function isPooledHost(connectionString: string): boolean {
  return /-pooler\./i.test(connectionString);
}

/** Wrap a `pg` Pool (or one of its clients) as a Db. */
function pgDb(target: pg.Pool | pg.PoolClient, dialect: Dialect = 'pg'): Db {
  return {
    dialect,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await target.query(sql, params as never[]);
      return res.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await target.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = 'connect' in target ? await (target as pg.Pool).connect() : (target as pg.PoolClient);
      const isOwnClient = 'connect' in target;
      try {
        await client.query('BEGIN');
        const result = await fn(pgDb(client, dialect));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        if (isOwnClient) client.release();
      }
    },
    async close(): Promise<void> {
      if ('end' in target) await (target as pg.Pool).end();
    },
  };
}

/** In-process Postgres for tests and local development without a database server. */
async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = await PGlite.create();

  const db: Db = {
    dialect: 'pglite',
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await lite.query(sql, params as never[]);
      return res.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await lite.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // PGlite is single-connection; serialise transactions so nested awaits
      // from other callers cannot interleave inside an open transaction.
      const run = async (): Promise<T> => {
        await lite.exec('BEGIN');
        try {
          const result = await fn(db);
          await lite.exec('COMMIT');
          return result;
        } catch (err) {
          await lite.exec('ROLLBACK').catch(() => {});
          throw err;
        }
      };
      const previous = tail;
      let release: () => void = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run();
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      await lite.close();
    },
  };

  let tail: Promise<void> = Promise.resolve();
  return db;
}

export async function createDb(connectionString = process.env.DATABASE_URL): Promise<Db> {
  if (!connectionString || !connectionString.trim()) {
    return createPgliteDb();
  }

  const url = connectionString.trim();
  const pooled = isPooledHost(url);

  const pool = new pg.Pool({
    connectionString: url,
    // Neon requires TLS; its certificates are not in the system trust store.
    ssl: isNeonHost(url) || /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    // Free-tier friendly. Keep small: the server is a relay, not a data cruncher.
    max: pooled ? 3 : 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // PgBouncer in transaction mode cannot hold session state.
    ...(pooled ? { statement_timeout: 30_000 } : {}),
  });

  // A pool-level error must never crash the process (Neon recycling connections
  // during scale-to-zero is normal and expected).
  pool.on('error', (err) => {
    console.error('[db] idle client error (recovering):', err.message);
  });

  const db = pgDb(pool);

  // Warm the connection once, tolerating the Neon cold start.
  try {
    await db.query('SELECT 1');
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, PG_RETRY_DELAY_MS));
    try {
      await db.query('SELECT 1');
    } catch (secondErr) {
      console.error('[db] could not reach Postgres:', (secondErr as Error).message);
      throw secondErr;
    }
    console.warn('[db] connected after cold-start retry:', (firstErr as Error).message);
  }

  return db;
}

/**
 * Allocate the next gap-free sequence number for a run and append an event.
 * Must run inside a transaction: the advisory lock is transaction-scoped, which
 * is exactly what PgBouncer transaction pooling supports.
 */
export async function appendEvent(
  tx: Db,
  runId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [runId]);
  const rows = await tx.query<{ seq: number }>(
    `INSERT INTO run_events (run_id, seq, type, payload)
     VALUES ($1, COALESCE((SELECT MAX(seq) FROM run_events WHERE run_id = $1), 0) + 1, $2, $3::jsonb)
     RETURNING seq`,
    [runId, type, JSON.stringify(payload ?? {})],
  );
  return rows[0].seq;
}

/**
 * Retention: run_events is append-only and grows with every mission.
 * Neon's free tier is 0.5 GB, so prune on a schedule (or at boot).
 * Run rows survive — only the replayable event tail is trimmed.
 */
export async function pruneRunEvents(db: Db, keepDays = 14): Promise<number> {
  const rows = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM run_events WHERE at < now() - ($1 || ' days')::interval RETURNING 1
     )
     SELECT count(*)::text AS count FROM deleted`,
    [String(keepDays)],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Orphan recovery on boot: a run left 'running' by a crash can never finish. */
export async function markOrphanedRuns(db: Db, maxAgeMinutes = 60): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `UPDATE runs
          SET status = 'failed',
              error_type = 'orphaned',
              error_message = 'Server restarted while this run was in flight',
              finished_at = now()
        WHERE status IN ('queued', 'running', 'paused')
          AND started_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
      [String(maxAgeMinutes)],
    );
    // A stream that reconnects after a restart replays run_events. Without a
    // terminal event the client waits on a dead run forever: no failure
    // notice, no retry button, no live updates. Record the failure the same
    // way a live failure would, so replay terminates the card properly.
    for (const row of rows) {
      await appendEvent(tx, row.id, 'run.failed', {
        status: 'failed',
        errorType: 'orphaned',
        errorMessage: 'Server restarted while this run was in flight',
      });
    }
    return rows.length;
  });
}
