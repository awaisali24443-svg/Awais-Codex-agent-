/**
 * Migration runner.
 *
 * Applies `server/migrations/NNN_name.sql` in numeric order, recording each in
 * `schema_migrations`. Every migration runs inside its own transaction, so a
 * failure leaves the database exactly as it was.
 *
 * On Render's free tier there is no shell and no one-off jobs, so this runs at
 * boot from `npm start` — applying migrations is idempotent and cheap.
 */
import fs from 'fs';
import { findDir } from './paths.js';
import path from 'path';
import type { Db } from './db.js';

export interface MigrationResult {
  applied: number[];
  skipped: number[];
}

interface Migration {
  version: number;
  name: string;
  file: string;
}

/**
 * Locate the migrations directory.
 *
 * `server/migrations` is where it lives in the repo; `migrations` covers a
 * container or bundle that copied it next to the compiled output.
 */
export function resolveMigrationsDir(): string {
  const found = findDir(['server/migrations', 'migrations'], '001_init.sql')
    ?? findDir(['server/migrations', 'migrations']);
  if (!found) {
    throw new Error('Could not find the migrations directory — see the [paths] warning above.');
  }
  return found;
}

export function loadMigrations(dir = resolveMigrationsDir()): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) {
        throw new Error(`Migration filename must look like 001_name.sql, got: ${file}`);
      }
      return { version: Number(match[1]), name: match[2], file: path.join(dir, file) };
    })
    .sort((a, b) => a.version - b.version);
}

export async function migrate(db: Db, dir?: string): Promise<MigrationResult> {
  const migrations = loadMigrations(dir);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const rows = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const already = new Set(rows.map((r) => Number(r.version)));

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const migration of migrations) {
    if (already.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }

    const sql = fs.readFileSync(migration.file, 'utf-8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
    applied.push(migration.version);
    console.log(`[migrate] applied ${String(migration.version).padStart(3, '0')}_${migration.name}`);
  }

  if (applied.length === 0) {
    console.log(`[migrate] up to date (${skipped.length} migration(s) already applied)`);
  }

  return { applied, skipped };
}
