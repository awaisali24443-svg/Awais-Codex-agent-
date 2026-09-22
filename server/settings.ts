/**
 * Settings and secrets — the two tables that were created and then left empty.
 *
 * Both stores here own one idea: **the environment provides defaults, the
 * database provides overrides, and the running process is the only reader.**
 * There is no second configuration system and no shadow copy — a change made
 * through `/api/settings` is applied to the `AppConfig` object that the rest of
 * the server already reads, so the budget on `/api/budget`, the limit enforced
 * in `accept.ts` and the poller's answer to "how many left today" can never
 * disagree with each other.
 *
 * Secrets are the one thing that cannot be read back out. They are encrypted
 * with `MASTER_KEY` (see crypto.ts), never logged, and never returned by any
 * endpoint — the API will only ever tell you *whether* a value exists, whether
 * it came from the environment or the database, and a short fingerprint so you
 * can confirm you pasted the same key twice.
 *
 * Only names with a consumer are accepted. A general-purpose vault is a nice
 * idea and a great place for credentials to quietly rot; `KNOWN_SECRETS` lists
 * exactly the values something in this server actually reads, and anything else
 * is refused rather than stored.
 */
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import {
  SecretDecryptionError,
  fingerprintOf,
  isMasterKey,
  openSecret,
  sealSecret,
} from './crypto.js';

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export const SETTING_KEYS = ['dailyRunBudget', 'antigravityAgent'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type ValidationResult = { ok: true; value: number | string } | { ok: false; message: string };

export interface SettingSpec {
  key: SettingKey;
  label: string;
  description: string;
  /** The environment variable that supplies the default. Shown in the UI. */
  envVar: string;
  /** Where the current value came from. */
  validate(raw: unknown): ValidationResult;
  /** Write the value into the live config the rest of the server reads. */
  apply(config: AppConfig, value: number | string): void;
}

const intInRange = (raw: unknown, min: number, max: number): ValidationResult => {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return { ok: false, message: 'must be a number' };
  const value = Math.trunc(n);
  if (value < min || value > max) return { ok: false, message: `must be between ${min} and ${max}` };
  return { ok: true, value };
};

export const SETTINGS: Record<SettingKey, SettingSpec> = {
  dailyRunBudget: {
    key: 'dailyRunBudget',
    label: 'Daily run budget',
    description:
      'Hard cap on agent runs per day, across every channel and each channel separately. ' +
      'Takes effect on the next mission — no redeploy.',
    envVar: 'DAILY_RUN_BUDGET',
    validate: (raw) => intInRange(raw, 1, 10_000),
    apply: (config, value) => {
      config.dailyRunBudget = Number(value);
    },
  },
  antigravityAgent: {
    key: 'antigravityAgent',
    label: 'Agent version',
    description:
      'Which managed agent the engine calls, e.g. antigravity-preview-09-2026. ' +
      'The date suffix is updated by the provider, so this needs to be changeable without a deploy.',
    envVar: 'ANTIGRAVITY_AGENT',
    validate: (raw) => {
      const value = String(raw ?? '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,80}$/.test(value)) {
        return { ok: false, message: 'must be an agent id like antigravity-preview-09-2026' };
      }
      return { ok: true, value };
    },
    apply: (config, value) => {
      config.antigravityAgent = String(value);
    },
  },
};

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && (SETTING_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

export const SECRET_NAMES = ['gemini_api_key', 'whatsapp_token', 'whatsapp_to'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface SecretSpec {
  name: SecretName;
  label: string;
  description: string;
  envVar: string;
  usedBy: string;
}

export const KNOWN_SECRETS: Record<SecretName, SecretSpec> = {
  gemini_api_key: {
    name: 'gemini_api_key',
    label: 'Google AI Studio key',
    description: 'Authorises the Antigravity engine. Without it, every mission fails with auth_failed.',
    envVar: 'GEMINI_API_KEY',
    usedBy: 'server/engine/antigravity.ts',
  },
  whatsapp_token: {
    name: 'whatsapp_token',
    label: 'WhatsApp Agent Platform token',
    description: 'Lets the poller read and answer messages sent to the agent from your phone.',
    envVar: 'WHATSAPP_TOKEN',
    usedBy: 'server/whatsapp/poller.ts',
  },
  whatsapp_to: {
    name: 'whatsapp_to',
    label: 'WhatsApp "done" ping recipient',
    description: 'Your phone number in international format. Run-completion pings are sent here; without it the ping is silently skipped.',
    envVar: 'WHATSAPP_TO',
    usedBy: 'server/whatsapp/doneping.ts',
  },
};

export function isSecretName(value: unknown): value is SecretName {
  return typeof value === 'string' && (SECRET_NAMES as readonly string[]).includes(value);
}

/**
 * Every state a credential can be in. The browser app renders one label per
 * value, so this is a contract: adding a source here without teaching the UI
 * about it would leave a credential displaying as "not set" while it is set.
 * `web-app.test.ts` compares the two lists.
 */
export const SECRET_SOURCES = ['stored', 'environment', 'missing', 'unreadable'] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];

export interface SecretMetadata {
  name: SecretName;
  label: string;
  description: string;
  envVar: string;
  usedBy: string;
  source: SecretSource;
  /** Short hash of the value, for "did I paste the same key twice". Never the value. */
  fingerprint: string | null;
  updatedAt: string | null;
}

/** Refuse anything that looks like a pasted-with-newlines or absurdly long value. */
const MAX_SECRET_CHARS = 8_192;

export class SecretsStore {
  private readonly cache = new Map<string, string>();
  private readonly unreadable = new Set<string>();
  private readonly updatedAt = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly masterKey: string,
    /** Environment-provided values, used when nothing is stored. */
    private readonly fallbacks: Partial<Record<SecretName, string>>,
  ) {}

  /**
   * Whether secrets can be written at all.
   *
   * A development boot without MASTER_KEY has no usable key — and encrypting
   * with a known placeholder would be worse than refusing, because the value
   * would *look* protected while being readable by anyone. So writes say so.
   */
  get encryptionAvailable(): boolean {
    return isMasterKey(this.masterKey);
  }

  /** Read every stored secret into memory, once, at boot. */
  async load(): Promise<{ loaded: number; unreadable: string[] }> {
    this.cache.clear();
    this.unreadable.clear();

    if (!this.encryptionAvailable) return { loaded: 0, unreadable: [] };

    const rows = await this.db.query<{
      name: string;
      ciphertext: string;
      iv: string;
      tag: string;
      updated_at: string | Date;
    }>('SELECT name, ciphertext, iv, tag, updated_at FROM secrets');

    for (const row of rows) {
      try {
        this.cache.set(row.name, openSecret(this.masterKey, row.name, row));
        this.updatedAt.set(row.name, new Date(row.updated_at).toISOString());
      } catch (err) {
        // Almost always "MASTER_KEY changed". Report it and keep booting: the
        // server is perfectly usable with environment-provided credentials, and
        // refusing to start would turn a wrong key into an outage.
        this.unreadable.add(row.name);
        const reason = err instanceof SecretDecryptionError ? err.message : String(err);
        console.warn(`[secrets] ${reason}`);
      }
    }

    return { loaded: this.cache.size, unreadable: [...this.unreadable] };
  }

  get(name: SecretName): string {
    if (this.cache.has(name)) return this.cache.get(name) as string;
    return this.fallbacks[name] ?? '';
  }

  source(name: SecretName): SecretSource {
    if (this.unreadable.has(name)) return 'unreadable';
    if (this.cache.has(name)) return 'stored';
    if (this.fallbacks[name]) return 'environment';
    return 'missing';
  }

  describe(name: SecretName): SecretMetadata {
    const spec = KNOWN_SECRETS[name];
    const stored = this.cache.get(name);
    const value = this.get(name);
    return {
      ...spec,
      source: this.source(name),
      fingerprint: value ? fingerprintOf(value) : null,
      updatedAt: stored ? (this.updatedAt.get(name) ?? null) : null,
    };
  }

  list(): SecretMetadata[] {
    return SECRET_NAMES.map((name) => this.describe(name));
  }

  async set(name: SecretName, rawValue: string): Promise<SecretMetadata> {
    if (!this.encryptionAvailable) {
      throw new SecretsUnavailableError(
        'Storing secrets needs MASTER_KEY (64 hex characters — `openssl rand -hex 32`). ' +
          'Set it in the environment, restart, and try again.',
      );
    }

    const value = rawValue.trim();
    if (!value) throw new SecretValueError('value must not be empty');
    if (value.length > MAX_SECRET_CHARS) {
      throw new SecretValueError(`value is ${value.length} characters; the limit is ${MAX_SECRET_CHARS}`);
    }

    const sealed = sealSecret(this.masterKey, name, value);
    const rows = await this.db.query<{ updated_at: string | Date }>(
      `INSERT INTO secrets (name, ciphertext, iv, tag)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE
              SET ciphertext = EXCLUDED.ciphertext,
                  iv = EXCLUDED.iv,
                  tag = EXCLUDED.tag,
                  updated_at = now()
        RETURNING updated_at`,
      [name, sealed.ciphertext, sealed.iv, sealed.tag],
    );

    this.cache.set(name, value);
    this.unreadable.delete(name);
    if (rows[0]?.updated_at) this.updatedAt.set(name, new Date(rows[0].updated_at).toISOString());

    // The value itself never reaches a log line — only which credential changed.
    console.log(`[secrets] ${name} updated (stored, encrypted)`);
    return this.describe(name);
  }

  /** Remove the stored copy. An environment variable, if set, takes over again. */
  async remove(name: SecretName): Promise<{ removed: boolean; source: SecretSource }> {
    const rows = await this.db.query<{ name: string }>(
      'DELETE FROM secrets WHERE name = $1 RETURNING name',
      [name],
    );
    this.cache.delete(name);
    this.unreadable.delete(name);
    this.updatedAt.delete(name);

    const removed = rows.length > 0;
    if (removed) console.log(`[secrets] ${name} removed (falls back to ${KNOWN_SECRETS[name].envVar})`);
    return { removed, source: this.source(name) };
  }
}

export class SecretsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsUnavailableError';
  }
}

export class SecretValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretValueError';
  }
}

/**
 * Build both stores from the pieces that are always at hand.
 *
 * The environment values that seeded `config` become the fallbacks, so the
 * store is never the *only* place a credential can live — an environment
 * variable keeps working with nothing in the database, which is what makes this
 * an upgrade rather than a migration.
 *
 * Constructing is not loading: call `settings.load()` and `secrets.load()` to
 * apply what is in the database. The boot sequence does; tests that only need
 * the environment values can skip it.
 */
export function createStores(db: Db, config: AppConfig): {
  settings: SettingsStore;
  secrets: SecretsStore;
} {
  return {
    settings: new SettingsStore(db, config),
    secrets: new SecretsStore(db, config.masterKey, {
      gemini_api_key: config.geminiApiKey,
      whatsapp_token: config.whatsappToken,
      whatsapp_to: config.whatsappTo,
    }),
  };
}

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

interface SettingRow {
  key: string;
  value: unknown;
}

export class SettingsStore {
  /** What the environment asked for, so clearing a setting restores it. */
  private readonly defaults = new Map<SettingKey, number | string>();
  private readonly stored = new Map<SettingKey, number | string>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {
    for (const key of SETTING_KEYS) {
      this.defaults.set(key, key === 'dailyRunBudget' ? config.dailyRunBudget : config.antigravityAgent);
    }
  }

  /** Read overrides and apply them to the live config. */
  async load(): Promise<{ applied: number; rejected: string[] }> {
    this.stored.clear();
    const rows = await this.db.query<SettingRow>('SELECT key, value FROM settings');
    const rejected: string[] = [];

    for (const row of rows) {
      if (!isSettingKey(row.key)) {
        // A row from a newer version (or a hand-edited database). Leave it in
        // place — deleting other people's data because we do not recognise it
        // is not a decision a settings loader should make.
        rejected.push(row.key);
        continue;
      }
      const spec = SETTINGS[row.key];
      const parsed = spec.validate(parseJsonValue(row.value));
      if (!parsed.ok) {
        rejected.push(`${row.key} (${parsed.message})`);
        continue;
      }
      this.stored.set(row.key, parsed.value);
      spec.apply(this.config, parsed.value);
    }

    return { applied: this.stored.size, rejected };
  }

  get(key: SettingKey): number | string {
    return this.stored.get(key) ?? (this.defaults.get(key) as number | string);
  }

  source(key: SettingKey): 'stored' | 'environment' {
    return this.stored.has(key) ? 'stored' : 'environment';
  }

  async set(key: SettingKey, raw: unknown): Promise<number | string> {
    const spec = SETTINGS[key];
    const parsed = spec.validate(raw);
    if (!parsed.ok) throw new SettingValueError(parsed.message);

    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(parsed.value)],
    );

    this.stored.set(key, parsed.value);
    spec.apply(this.config, parsed.value);
    console.log(`[settings] ${key} = ${String(parsed.value)} (applied live)`);
    return parsed.value;
  }

  /** Forget the override; the environment default applies again immediately. */
  async clear(key: SettingKey): Promise<number | string> {
    await this.db.query('DELETE FROM settings WHERE key = $1', [key]);
    this.stored.delete(key);

    const fallback = this.defaults.get(key) as number | string;
    SETTINGS[key].apply(this.config, fallback);
    return fallback;
  }

  list(): Array<{
    key: SettingKey;
    label: string;
    description: string;
    envVar: string;
    value: number | string;
    defaultValue: number | string;
    source: 'stored' | 'environment';
  }> {
    return SETTING_KEYS.map((key) => ({
      key,
      label: SETTINGS[key].label,
      description: SETTINGS[key].description,
      envVar: SETTINGS[key].envVar,
      value: this.get(key),
      defaultValue: this.defaults.get(key) as number | string,
      source: this.source(key),
    }));
  }
}

export class SettingValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingValueError';
  }
}

/**
 * `jsonb` comes back parsed from both drivers, but a value written as a JSON
 * string by hand (or by an older tool) arrives as text — accept both.
 */
function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
