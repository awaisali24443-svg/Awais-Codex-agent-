/**
 * Settings and secrets tests.
 *
 * The point of this file is not that a `PUT` returns 200. It is that four
 * specific things are true, because each is a way this feature could be built
 * and still be wrong:
 *
 *   1. **The plaintext never comes back out.** Not through the API, not in a
 *      list, not in a fingerprint. Asserted against the raw response text
 *      rather than a parsed field, so a new field that leaks it fails too.
 *   2. **A swapped ciphertext is rejected.** The secret's name is bound into
 *      the GCM associated data; if that binding is ever dropped, this fails.
 *   3. **A change takes effect without a restart.** The store writes into the
 *      live `AppConfig`, so `/api/budget` must show a new limit immediately and
 *      `/readyz` must see a key that nothing in the environment provides.
 *   4. **Changing MASTER_KEY degrades, it does not crash.** An undecryptable
 *      row is reported and the environment value keeps working.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { loadConfig, type AppConfig } from './config.js';
import { createApp } from './app.js';
import { createStores, SecretValueError, SecretsUnavailableError, SettingValueError } from './settings.js';
import { EventBus } from './events.js';
import { RunExecutor } from './executor.js';
import { ScriptedEngine } from './engine/scripted.js';
import {
  SecretDecryptionError,
  fingerprintOf,
  isMasterKey,
  maskSecret,
  openSecret,
  sealSecret,
} from './crypto.js';

const MASTER_KEY = 'a1b2c3d4'.repeat(8); // 64 hex characters
const OTHER_KEY = 'f0e1d2c3'.repeat(8);
const ACCESS_KEY = 'settings-tests-access-key';
const SESSION_SECRET = 'a-session-secret-long-enough-for-the-validation';
const FAKE_GEMINI_KEY = 'AIzaSyTESTKEY-do-not-use-0123456789';

let db: Db;

/** A config with a usable MASTER_KEY: the normal case. */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'key',
      ACCESS_KEY,
      SESSION_SECRET,
      MASTER_KEY,
      // The engine name drives the readiness report; the executor below is
      // still the scripted one, because these tests never run a mission.
      ENGINE: 'antigravity',
      DAILY_RUN_BUDGET: '50',
      ANTIGRAVITY_AGENT: 'antigravity-preview-09-2026',
      GEMINI_API_KEY: '',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

/** Boot a real HTTP server for a config. `app` is returned so tests can act. */
async function serve(
  config: AppConfig,
): Promise<{ base: string; close: () => Promise<void> }> {
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

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** The access key header stands in for the browser's session cookie. */
function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-access-key': ACCESS_KEY, 'content-type': 'application/json', ...extra };
}

before(async () => {
  db = await createDb('');
  await migrate(db);
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// crypto
// ---------------------------------------------------------------------------

describe('crypto: AES-256-GCM', () => {
  test('round-trips a secret', () => {
    const sealed = sealSecret(MASTER_KEY, 'gemini_api_key', 'super-secret-value');
    assert.notEqual(sealed.ciphertext, 'super-secret-value');
    assert.equal(openSecret(MASTER_KEY, 'gemini_api_key', sealed), 'super-secret-value');
  });

  test('uses a fresh IV, so the same value seals differently every time', () => {
    const a = sealSecret(MASTER_KEY, 'gemini_api_key', 'same');
    const b = sealSecret(MASTER_KEY, 'gemini_api_key', 'same');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.equal(openSecret(MASTER_KEY, 'gemini_api_key', b), 'same');
  });

  test('refuses the wrong master key, and names the secret it could not open', () => {
    const sealed = sealSecret(MASTER_KEY, 'whatsapp_token', 'token-value');
    assert.throws(
      () => openSecret(OTHER_KEY, 'whatsapp_token', sealed),
      (err: Error) =>
        err instanceof SecretDecryptionError &&
        /whatsapp_token/.test(err.message) &&
        /MASTER_KEY changed/.test(err.message),
    );
  });

  test('refuses a tampered ciphertext', () => {
    const sealed = sealSecret(MASTER_KEY, 'gemini_api_key', 'value');
    const flipped = Buffer.from(sealed.ciphertext, 'base64');
    flipped[0] ^= 0x01;
    assert.throws(
      () => openSecret(MASTER_KEY, 'gemini_api_key', { ...sealed, ciphertext: flipped.toString('base64') }),
      SecretDecryptionError,
    );
  });

  test('refuses a tampered tag', () => {
    const sealed = sealSecret(MASTER_KEY, 'gemini_api_key', 'value');
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] ^= 0xff;
    assert.throws(
      () => openSecret(MASTER_KEY, 'gemini_api_key', { ...sealed, tag: tag.toString('base64') }),
      SecretDecryptionError,
    );
  });

  /**
   * The reason the name is associated data: without it, one row's ciphertext
   * could be pasted into another row and the store would hand the wrong
   * credential to the wrong consumer without complaint.
   */
  test('refuses a ciphertext that was moved to another secret name', () => {
    const sealed = sealSecret(MASTER_KEY, 'gemini_api_key', 'value');
    assert.throws(() => openSecret(MASTER_KEY, 'whatsapp_token', sealed), SecretDecryptionError);
  });

  test('rejects a malformed master key instead of guessing', () => {
    assert.throws(() => sealSecret('not-hex', 'gemini_api_key', 'x'), /64 hex characters/);
    assert.equal(isMasterKey(MASTER_KEY), true);
    assert.equal(isMasterKey(OTHER_KEY), true);
    assert.equal(isMasterKey(MASTER_KEY.slice(0, 63)), false);
    assert.equal(isMasterKey(`${MASTER_KEY}0`), false);
    assert.equal(isMasterKey(''), false);
  });

  test('fingerprints are stable, short, and do not contain the value', () => {
    const print = fingerprintOf('AIzaSySomethingLongEnough');
    assert.equal(print, fingerprintOf('AIzaSySomethingLongEnough'));
    assert.notEqual(print, fingerprintOf('AIzaSySomethingElseLongEnough'));
    assert.match(print, /^[0-9a-f]{12}$/);
    assert.equal(print.includes('AIza'), false);
  });

  test('masking keeps a hint and hides the rest', () => {
    assert.equal(maskSecret('short'), '****');
    const masked = maskSecret('abcdefghijklmnop');
    assert.equal(masked.includes('ijkl'), false);
    assert.match(masked, /^abcd.*16 chars\)$/);
  });
});

// ---------------------------------------------------------------------------
// secrets store
// ---------------------------------------------------------------------------

describe('secrets store', () => {
  test('stores, reads back, and reports the source', async () => {
    const { secrets } = createStores(db, makeConfig());
    await secrets.set('gemini_api_key', FAKE_GEMINI_KEY);

    assert.equal(secrets.get('gemini_api_key'), FAKE_GEMINI_KEY);
    assert.equal(secrets.source('gemini_api_key'), 'stored');

    await secrets.remove('gemini_api_key');
  });

  test('persists encrypted: the row never contains the plaintext', async () => {
    const { secrets } = createStores(db, makeConfig());
    await secrets.set('gemini_api_key', FAKE_GEMINI_KEY);

    const rows = await db.query<{ ciphertext: string; iv: string; tag: string }>(
      'SELECT ciphertext, iv, tag FROM secrets WHERE name = $1',
      ['gemini_api_key'],
    );
    const row = rows[0];
    assert.ok(row, 'expected a stored row');
    const raw = `${row.ciphertext}${row.iv}${row.tag}`;
    assert.equal(raw.includes(FAKE_GEMINI_KEY), false);
    assert.equal(Buffer.from(row.ciphertext, 'base64').toString('utf-8').includes('AIza'), false);

    await secrets.remove('gemini_api_key');
  });

  test('a fresh store decrypts what another store wrote (survives a restart)', async () => {
    const first = createStores(db, makeConfig()).secrets;
    await first.set('whatsapp_token', 'wa-token-value');

    const second = createStores(db, makeConfig()).secrets;
    const loaded = await second.load();
    assert.equal(loaded.loaded, 1);
    assert.equal(second.get('whatsapp_token'), 'wa-token-value');
    assert.equal(second.source('whatsapp_token'), 'stored');

    await second.remove('whatsapp_token');
  });

  test('the environment is the fallback, and a stored value wins', async () => {
    const config = makeConfig({ geminiApiKey: 'from-environment' });
    const { secrets } = createStores(db, config);

    assert.equal(secrets.get('gemini_api_key'), 'from-environment');
    assert.equal(secrets.source('gemini_api_key'), 'environment');

    await secrets.set('gemini_api_key', 'from-the-store');
    assert.equal(secrets.get('gemini_api_key'), 'from-the-store');
    assert.equal(secrets.source('gemini_api_key'), 'stored');

    // Removing it puts the environment value back in charge rather than
    // leaving an empty credential behind.
    const { removed } = await secrets.remove('gemini_api_key');
    assert.equal(removed, true);
    assert.equal(secrets.get('gemini_api_key'), 'from-environment');
    assert.equal(secrets.source('gemini_api_key'), 'environment');
  });

  test('a missing value is reported as missing, not as an empty string', () => {
    const { secrets } = createStores(db, makeConfig());
    assert.equal(secrets.source('whatsapp_token'), 'missing');
    assert.equal(secrets.get('whatsapp_token'), '');
  });

  test('an undecryptable row is reported, not thrown, and the env value still works', async () => {
    const withKey = createStores(db, makeConfig()).secrets;
    await withKey.set('gemini_api_key', 'written-under-the-old-key');

    // Same database, different MASTER_KEY: exactly what a key rotation looks
    // like to a server that has not been given the new rows yet.
    const rotated = createStores(db, makeConfig({ masterKey: OTHER_KEY, geminiApiKey: 'env-fallback' })).secrets;
    const loaded = await rotated.load();

    assert.deepEqual(loaded.unreadable, ['gemini_api_key']);
    assert.equal(loaded.loaded, 0);
    assert.equal(rotated.source('gemini_api_key'), 'unreadable');
    assert.equal(rotated.get('gemini_api_key'), 'env-fallback');

    const meta = rotated.describe('gemini_api_key');
    assert.equal(meta.source, 'unreadable');
    assert.equal(meta.fingerprint, fingerprintOf('env-fallback'));

    await withKey.remove('gemini_api_key');
  });

  test('refuses to store anything without a usable MASTER_KEY', async () => {
    const { secrets } = createStores(db, makeConfig({ masterKey: '' }));
    assert.equal(secrets.encryptionAvailable, false);
    await assert.rejects(
      () => secrets.set('gemini_api_key', 'value'),
      (err: Error) => err instanceof SecretsUnavailableError && /MASTER_KEY/.test(err.message),
    );
  });

  test('refuses empty and absurdly long values', async () => {
    const { secrets } = createStores(db, makeConfig());
    await assert.rejects(() => secrets.set('gemini_api_key', '   '), SecretValueError);
    await assert.rejects(() => secrets.set('gemini_api_key', 'x'.repeat(9_000)), SecretValueError);
  });

  test('a credential is trimmed of the newline a copy-paste leaves behind', async () => {
    const { secrets } = createStores(db, makeConfig());
    await secrets.set('whatsapp_token', '  pasted-token\n');
    assert.equal(secrets.get('whatsapp_token'), 'pasted-token');
    await secrets.remove('whatsapp_token');
  });

  test('metadata carries a fingerprint and a timestamp, never the value', async () => {
    const { secrets } = createStores(db, makeConfig());
    await secrets.set('gemini_api_key', FAKE_GEMINI_KEY);

    const meta = secrets.describe('gemini_api_key');
    assert.equal(meta.name, 'gemini_api_key');
    assert.equal(meta.envVar, 'GEMINI_API_KEY');
    assert.equal(meta.fingerprint, fingerprintOf(FAKE_GEMINI_KEY));
    assert.ok(meta.updatedAt && !Number.isNaN(Date.parse(meta.updatedAt)));
    assert.equal(JSON.stringify(meta).includes(FAKE_GEMINI_KEY), false);

    await secrets.remove('gemini_api_key');
  });
});

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

describe('settings store', () => {
  test('falls back to the environment, and says so', async () => {
    const config = makeConfig({ dailyRunBudget: 50 });
    const { settings } = createStores(db, config);
    await settings.load();

    assert.equal(settings.get('dailyRunBudget'), 50);
    assert.equal(settings.source('dailyRunBudget'), 'environment');
    assert.equal(settings.get('antigravityAgent'), 'antigravity-preview-09-2026');
  });

  test('changing a setting rewrites the live config immediately', async () => {
    const config = makeConfig({ dailyRunBudget: 50 });
    const { settings } = createStores(db, config);
    await settings.load();

    await settings.set('dailyRunBudget', 7);
    assert.equal(config.dailyRunBudget, 7, 'the running server must see the new limit');

    await settings.set('antigravityAgent', 'antigravity-preview-11-2026');
    assert.equal(config.antigravityAgent, 'antigravity-preview-11-2026');

    await settings.clear('dailyRunBudget');
    await settings.clear('antigravityAgent');
  });

  test('clearing restores the environment default, not the last stored value', async () => {
    const config = makeConfig({ dailyRunBudget: 50 });
    const { settings } = createStores(db, config);
    await settings.load();

    await settings.set('dailyRunBudget', 7);
    const restored = await settings.clear('dailyRunBudget');

    assert.equal(restored, 50);
    assert.equal(config.dailyRunBudget, 50);
    assert.equal(settings.source('dailyRunBudget'), 'environment');
  });

  test('a stored override is applied at boot from the database', async () => {
    await createStores(db, makeConfig()).settings.set('dailyRunBudget', 9);

    const config = makeConfig({ dailyRunBudget: 50 });
    const fresh = createStores(db, config);
    const loaded = await fresh.settings.load();

    assert.equal(loaded.applied, 1);
    assert.equal(config.dailyRunBudget, 9, 'boot must not ignore the stored override');
    assert.equal(fresh.settings.source('dailyRunBudget'), 'stored');

    await fresh.settings.clear('dailyRunBudget');
  });

  test('refuses values outside the schema', async () => {
    const { settings } = createStores(db, makeConfig());

    await assert.rejects(() => settings.set('dailyRunBudget', 0), SettingValueError);
    await assert.rejects(() => settings.set('dailyRunBudget', 10_001), SettingValueError);
    await assert.rejects(() => settings.set('dailyRunBudget', 'lots'), SettingValueError);
    await assert.rejects(() => settings.set('antigravityAgent', 'no spaces allowed'), SettingValueError);
    await assert.rejects(() => settings.set('antigravityAgent', ''), SettingValueError);
  });

  test('a numeric string is accepted — form fields send strings', async () => {
    const { settings } = createStores(db, makeConfig());
    await settings.set('dailyRunBudget', '25');
    assert.equal(settings.get('dailyRunBudget'), 25);
    await settings.clear('dailyRunBudget');
  });

  test('unknown or invalid rows are reported and skipped, never fatal', async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ('fromASelectedFuture', '"x"'::jsonb)`);
    await db.query(`INSERT INTO settings (key, value) VALUES ('dailyRunBudget', '0'::jsonb)`);

    const config = makeConfig({ dailyRunBudget: 50 });
    const { settings } = createStores(db, config);
    const loaded = await settings.load();

    assert.equal(loaded.applied, 0);
    assert.equal(loaded.rejected.length, 2);
    assert.ok(loaded.rejected.some((entry) => entry.startsWith('fromASelectedFuture')));
    assert.ok(loaded.rejected.some((entry) => entry.startsWith('dailyRunBudget')));
    assert.equal(config.dailyRunBudget, 50, 'an invalid row must not become the limit');

    await db.query(`DELETE FROM settings WHERE key = 'fromASelectedFuture'`);
    await db.query(`DELETE FROM settings WHERE key = 'dailyRunBudget'`);
  });
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

describe('settings routes', () => {
  let base: string;
  let close: () => Promise<void>;
  let config: AppConfig;

  before(async () => {
    config = makeConfig({ dailyRunBudget: 50 });
    const server = await serve(config);
    base = server.base;
    close = server.close;
  });

  after(async () => {
    await close();
  });

  test('the panel is behind auth like everything else under /api', async () => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 401);
  });

  test('the panel lists settings, secrets and whether storing is possible', async () => {
    const res = await fetch(`${base}/api/settings`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      settings: Array<{ key: string; value: unknown; source: string; envVar: string }>;
      secrets: Array<{ name: string; source: string; fingerprint: string | null }>;
      encryption: { available: boolean };
    };

    const budget = body.settings.find((s) => s.key === 'dailyRunBudget');
    assert.equal(budget?.value, 50);
    assert.equal(budget?.source, 'environment');
    assert.equal(budget?.envVar, 'DAILY_RUN_BUDGET');

    assert.deepEqual(
      body.secrets.map((s) => s.name),
      ['gemini_api_key', 'whatsapp_token', 'whatsapp_to', 'github_pat', 'linkedin_client_id', 'linkedin_client_secret'],
    );
    assert.equal(body.secrets[0].source, 'missing');
    assert.equal(body.encryption.available, true);
  });

  test('a new budget applies to the running server, not the next boot', async () => {
    const put = await fetch(`${base}/api/settings/dailyRunBudget`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: 3 }),
    });
    assert.equal(put.status, 200);

    // The observable effect: the budget endpoint the UI reads.
    const budget = await fetch(`${base}/api/budget`, { headers: auth() });
    const body = (await budget.json()) as { limit?: number; dailyRunBudget?: number; buckets?: unknown };
    const reported = body.limit ?? body.dailyRunBudget;
    assert.equal(reported, 3, `expected the live limit to be 3, got ${JSON.stringify(body)}`);

    const restored = await fetch(`${base}/api/settings/dailyRunBudget`, { method: 'DELETE', headers: auth() });
    assert.equal(restored.status, 200);
    const after = await fetch(`${base}/api/budget`, { headers: auth() });
    const afterBody = (await after.json()) as { limit?: number; dailyRunBudget?: number };
    assert.equal(afterBody.limit ?? afterBody.dailyRunBudget, 50);
  });

  test('rejects a bad value with a reason, and an unknown key with a list', async () => {
    const bad = await fetch(`${base}/api/settings/dailyRunBudget`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: -5 }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { error: string; message: string };
    assert.equal(badBody.error, 'invalid_value');
    assert.match(badBody.message, /between 1 and 10000/);

    const unknown = await fetch(`${base}/api/settings/notAThing`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: 1 }),
    });
    assert.equal(unknown.status, 404);
    const unknownBody = (await unknown.json()) as { error: string; message: string };
    assert.equal(unknownBody.error, 'unknown_setting');
    assert.match(unknownBody.message, /dailyRunBudget/);

    const missingValue = await fetch(`${base}/api/settings/dailyRunBudget`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({}),
    });
    assert.equal(missingValue.status, 400);
  });

  test('a stored key is never echoed back, in any field', async () => {
    const put = await fetch(`${base}/api/settings/secrets/gemini_api_key`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: FAKE_GEMINI_KEY }),
    });
    assert.equal(put.status, 200);
    const raw = await put.text();
    assert.equal(raw.includes(FAKE_GEMINI_KEY), false, 'the write response leaked the value');

    const listed = await fetch(`${base}/api/settings`, { headers: auth() });
    const listText = await listed.text();
    assert.equal(listText.includes(FAKE_GEMINI_KEY), false, 'the read response leaked the value');

    const body = JSON.parse(listText) as {
      secrets: Array<{ name: string; source: string; fingerprint: string | null }>;
    };
    const gemini = body.secrets.find((s) => s.name === 'gemini_api_key');
    assert.equal(gemini?.source, 'stored');
    assert.equal(gemini?.fingerprint, fingerprintOf(FAKE_GEMINI_KEY));
  });

  test('the stored key reaches the engine — /readyz says so without a restart', async () => {
    const res = await fetch(`${base}/readyz`);
    const body = (await res.json()) as { checks: Record<string, string> };
    assert.match(body.checks.engine, /key present \(stored\)/);
  });

  test('deleting the stored key falls back to the environment again', async () => {
    const res = await fetch(`${base}/api/settings/secrets/gemini_api_key`, {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      removed: boolean;
      source: string;
      secret: { fingerprint: string | null };
    };
    assert.equal(body.removed, true);
    assert.equal(body.source, 'missing');
    assert.equal(body.secret.fingerprint, null);

    const ready = await fetch(`${base}/readyz`);
    const readyBody = (await ready.json()) as { checks: Record<string, string> };
    assert.equal(readyBody.checks.engine, 'no key configured');
  });

  test('unknown credential names are refused rather than stored', async () => {
    const res = await fetch(`${base}/api/settings/secrets/slack_token`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: 'xoxb_something' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'unknown_secret');
    assert.match(body.message, /gemini_api_key, whatsapp_token, whatsapp_to, github_pat/);

    // And nothing was written.
    const rows = await db.query('SELECT name FROM secrets WHERE name = $1', ['slack_token']);
    assert.equal(rows.length, 0);
  });

  test('a non-string value is refused with the expected shape in the message', async () => {
    const res = await fetch(`${base}/api/settings/secrets/whatsapp_token`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: { nested: true } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'value_required');
    assert.match(body.message, /"value"/);
  });

  test('a stored WhatsApp token is what the poller would read', async () => {
    const { secrets } = createStores(db, makeConfig());
    await secrets.set('whatsapp_token', 'wa-stored-token');

    const fresh = createStores(db, makeConfig());
    await fresh.secrets.load();
    assert.equal(fresh.secrets.get('whatsapp_token'), 'wa-stored-token');

    await fresh.secrets.remove('whatsapp_token');
  });
});

describe('settings routes without a master key', () => {
  let base: string;
  let close: () => Promise<void>;

  before(async () => {
    const server = await serve(makeConfig({ masterKey: '' }));
    base = server.base;
    close = server.close;
  });

  after(async () => {
    await close();
  });

  test('says encryption is unavailable and explains what to set', async () => {
    const res = await fetch(`${base}/api/settings`, { headers: auth() });
    const body = (await res.json()) as { encryption: { available: boolean; hint: string | null } };
    assert.equal(body.encryption.available, false);
    assert.match(body.encryption.hint ?? '', /MASTER_KEY/);
  });

  test('refuses to store a secret with 503 rather than a false success', async () => {
    const res = await fetch(`${base}/api/settings/secrets/gemini_api_key`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: 'a-key' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'encryption_unavailable');
    assert.match(body.message, /openssl rand -hex 32/);

    const rows = await db.query('SELECT name FROM secrets');
    assert.equal(rows.length, 0, 'nothing may be stored unencrypted');
  });

  test('settings still work — a budget does not need a master key', async () => {
    const res = await fetch(`${base}/api/settings/antigravityAgent`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ value: 'antigravity-preview-12-2026' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { value: string; source: string };
    assert.equal(body.value, 'antigravity-preview-12-2026');
    assert.equal(body.source, 'stored');

    const cleared = await fetch(`${base}/api/settings/antigravityAgent`, {
      method: 'DELETE',
      headers: auth(),
    });
    assert.equal(cleared.status, 200);
  });
});
