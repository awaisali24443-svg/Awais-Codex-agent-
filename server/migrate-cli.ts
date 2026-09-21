/**
 * CLI: apply migrations and exit.
 *
 *   npm run db:migrate          (local, uses DATABASE_URL or PGlite)
 *
 * Also invoked at boot from the production entry point, because Render's free
 * tier has no shell and no one-off jobs.
 */
import { createDb, markOrphanedRuns } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const usingPglite = !config.databaseUrl;
  if (usingPglite) {
    console.log('[migrate] DATABASE_URL is empty — using in-process PGlite (dev/test only)');
  } else {
    const host = config.databaseUrl.replace(/\/\/[^@]*@/, '//***@').split('/')[2] ?? 'unknown';
    console.log(`[migrate] target host: ${host}${/-pooler\./.test(host) ? ' (pooled)' : ''}`);
  }

  const db = await createDb(config.databaseUrl);
  try {
    const result = await migrate(db);
    const orphans = await markOrphanedRuns(db);
    if (orphans > 0) {
      console.log(`[migrate] marked ${orphans} orphaned run(s) as failed`);
    }
    console.log(
      `[migrate] done — ${result.applied.length} applied, ${result.skipped.length} already present`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
