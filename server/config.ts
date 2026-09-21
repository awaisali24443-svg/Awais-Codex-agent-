/**
 * Boot-time environment validation.
 *
 * Fails fast with an actionable message instead of throwing `undefined` deep in
 * a request handler. No dependency: a small typed schema checker.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;

  /** Postgres connection string. Empty -> PGlite (dev/test only). */
  databaseUrl: string;
  /** Key for signing session cookies. */
  sessionSecret: string;
  /** Master key for AES-256-GCM encryption of stored secrets. */
  masterKey: string;

  /** Google AI Studio key for the Antigravity agent. Optional: the UI can supply one. */
  geminiApiKey: string;
  /** WhatsApp Agent Platform token. Optional: the feature is a limited beta. */
  whatsappToken: string;

  /** Only one process may long-poll a WhatsApp agent. */
  pollerEnabled: boolean;
  /** Hard daily cap on agent runs — the free tier allows ~100/day. */
  dailyRunBudget: number;
  /** Days to keep replayable run events (Neon free tier is 0.5 GB). */
  eventRetentionDays: number;
  /** Days to keep artifact files on the ephemeral disk before pruning. */
  artifactRetentionDays: number;

  appUrl: string;
}

class ConfigError extends Error {
  constructor(problems: string[]) {
    super(
      'Invalid environment configuration:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nSee .env.example for the full list.',
    );
    this.name = 'ConfigError';
  }
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  const isProduction = nodeEnv === 'production';

  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  const sessionSecret = (env.SESSION_SECRET ?? '').trim();
  const masterKey = (env.MASTER_KEY ?? '').trim();

  if (isProduction && !databaseUrl) {
    problems.push(
      'DATABASE_URL is required in production — Render\'s free disk is ephemeral, so SQLite/JSON files lose data on every spin-down',
    );
  }
  if (isProduction && sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters in production');
  }
  if (!isProduction && sessionSecret && sessionSecret.length < 32) {
    problems.push('SESSION_SECRET is set but shorter than 32 characters');
  }
  if (isProduction && !masterKey) {
    problems.push('MASTER_KEY is required in production (encrypts stored API tokens)');
  }
  if (masterKey && !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    problems.push('MASTER_KEY must be 64 hex characters (32 bytes) — e.g. `openssl rand -hex 32`');
  }

  const pollerEnabled = readBool(env.POLLER_ENABLED, false);
  if (pollerEnabled && !(env.WHATSAPP_TOKEN ?? '').trim()) {
    problems.push('POLLER_ENABLED=true but WHATSAPP_TOKEN is empty — the poller would spin');
  }

  const dailyRunBudget = readInt(env.DAILY_RUN_BUDGET, 100);
  if (dailyRunBudget < 1 || dailyRunBudget > 10_000) {
    problems.push(`DAILY_RUN_BUDGET must be between 1 and 10000 (got ${dailyRunBudget})`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv,
    isProduction,
    port: readInt(env.PORT, 3000),
    databaseUrl,
    sessionSecret: sessionSecret || 'dev-only-insecure-session-secret-change-me',
    masterKey: masterKey || '0'.repeat(64),
    geminiApiKey: (env.GEMINI_API_KEY ?? '').trim(),
    whatsappToken: (env.WHATSAPP_TOKEN ?? '').trim(),
    pollerEnabled,
    dailyRunBudget,
    eventRetentionDays: readInt(env.EVENT_RETENTION_DAYS, 14),
    artifactRetentionDays: readInt(env.ARTIFACT_RETENTION_DAYS, 7),
    appUrl: (env.APP_URL ?? '').trim(),
  };
}
