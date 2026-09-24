/**
 * What the phone downloads, and which build it thinks it has.
 *
 * Two failures, one afternoon:
 *
 *  - The operator reported six bugs that had already been fixed and deployed.
 *    His phone was still running the previous build, because the shell was
 *    served with an hour of `max-age` — and there was nothing on screen that
 *    could tell either of us which build he was looking at.
 *
 * So this file boots the real app and asserts the two halves of the answer:
 * the shell always revalidates (a deploy is live on the next load, not an hour
 * later), and the running commit is reported both by /healthz and by /api/status,
 * where the Settings page reads it from.
 *
 * It is a test on HTTP, not on files, on purpose: `Cache-Control` is set by
 * express.static according to rules that are easy to get subtly wrong, and the
 * only proof that matters is the header a phone receives.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from './app.js';
import { createStores } from './settings.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig } from './config.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';

const SECRET = 'shell-cache-session-secret-long-enough';
const KEY = 'shell-cache-access-key';

let db: Db;
let server: Server;
let base: string;

before(async () => {
  db = await createDb('');
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: SECRET,
    ACCESS_KEY: KEY,
    ENGINE: 'scripted',
  } as NodeJS.ProcessEnv);

  const bus = new EventBus();
  const executor = new RunExecutor({ db, bus, engine: new ScriptedEngine() });
  const app = createApp({
    config,
    db,
    bus,
    executor,
    ...createStores(db, config),
    status: { startedAt: Date.now(), migrationsApplied: 1, orphanedRuns: 0 },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

const cacheControl = (res: Response): string => res.headers.get('cache-control') ?? '';

describe('the shell revalidates, so a deploy is live on the next load', () => {
  for (const file of ['/app.js', '/styles.css', '/theme.css', '/timeline.js', '/manifest.json']) {
    test(`${file} is no-cache`, async () => {
      const res = await fetch(`${base}${file}`);
      assert.equal(res.status, 200, `${file} is served`);
      assert.match(
        cacheControl(res),
        /no-cache/,
        `${file} must revalidate — an hour of max-age is an hour of old UI on the phone`,
      );
    });
  }

  test('the HTML shell is no-cache, both as a file and as a route', async () => {
    const direct = await fetch(`${base}/index.html`);
    assert.match(cacheControl(direct), /no-cache/);

    // A deep link is answered with index.html by the SPA fallback, which sets
    // the header itself — the file's own headers never apply there.
    const deep = await fetch(`${base}/some/deep/link`);
    assert.equal(deep.status, 200);
    assert.match(cacheControl(deep), /no-cache/);
  });

  test('the service worker is never cached at all', async () => {
    const res = await fetch(`${base}/sw.js`);
    const header = cacheControl(res);
    assert.match(header, /no-store/, 'a cached worker pins a stale app');
    assert.equal(res.headers.get('service-worker-allowed'), '/');
  });

  test('icons keep the long cache — the shell is what had to change', async () => {
    const res = await fetch(`${base}/pwa-192x192.png`);
    assert.equal(res.status, 200);
    assert.match(
      cacheControl(res),
      /max-age=3600/,
      'an icon is worth caching; a client bundle is not',
    );
  });
});

describe('the running build is on the wire', () => {
  test('/healthz names the commit', async () => {
    const res = await fetch(`${base}/healthz`);
    const body = (await res.json()) as { commit?: string; service: string };
    assert.equal(body.service, 'awais-codex', 'the service id is unchanged on purpose');
    assert.ok(typeof body.commit === 'string' && body.commit.length > 0, 'commit is present');
    // Locally there is no Render env var: the value has to be an honest
    // placeholder rather than an empty string.
    assert.equal(body.commit, 'unknown');
  });

  test('/healthz reports an injected commit when the host provides one', async () => {
    // The production value comes from RENDER_GIT_COMMIT; this asserts the
    // plumbing without pretending to be Render. (buildCommit reads the env at
    // request time, so setting it here is enough.)
    process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
    try {
      const res = await fetch(`${base}/healthz`);
      const body = (await res.json()) as { commit: string };
      assert.equal(body.commit, 'abcdef1', 'shortened to the seven characters people quote');
    } finally {
      delete process.env.RENDER_GIT_COMMIT;
    }
  });

  test('/api/status carries it too — that is what Settings reads', async () => {
    const res = await fetch(`${base}/api/status`, { headers: { 'x-access-key': KEY } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { commit?: string };
    assert.ok(typeof body.commit === 'string', 'the page cannot show what the API does not say');
  });
});

describe('the client shows it', () => {
  test('Settings renders a build line from /api/status', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const client = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf-8');
    assert.ok(client.includes('renderBuildLine'), 'the line is rendered');
    assert.ok(client.includes("api('/api/status')"), 'from the status endpoint');
    assert.ok(client.includes('build-line'), 'with an id, so it is replaced rather than stacked');
  });

  test('the service worker cache name was bumped for this shell', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sw = readFileSync(fileURLToPath(new URL('../web/sw.js', import.meta.url)), 'utf-8');
    assert.match(sw, /const VERSION = 'wais-v4'/, 'a new cache name drops the old shell on activate');
  });
});
