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
  /** Explicit recipient for the run-completion "done" ping (E.164, e.g. +923324744601). Optional: no ping without it. */
  whatsappTo: string;
  /** GitHub personal access token, for the GitHub integration. Optional: Settings can supply one. */
  githubToken: string;
  /** Override the WhatsApp Agent Platform base (tests point this at a fake). */
  whatsappApiBase: string;

  /** Which engine executes runs. */
  engineName: 'scripted' | 'antigravity';
  /** Antigravity managed-agent id. Date-stamped, so it must be updatable. */
  antigravityAgent: string;
  /** Override the API base (tests point this at a local fake). */
  antigravityApiBase: string;
  /** Optional hard token ceiling for one interaction. 0 = uncapped. */
  antigravityMaxTokens: number;

  /**
   * What the operator asked for, from POLLER_ENABLED:
   *
   *   'auto' (default) - poll whenever a token is available, from the
   *                      environment or from Settings. Pasting the agent's API
   *                      key is the whole setup step.
   *   'on'             - the same, but a token must be reachable at boot.
   *   'off'            - never poll. Exactly one process may long-poll an
   *                      agent, so this is how a second host stays quiet.
   */
  pollerMode: 'auto' | 'on' | 'off';
  /**
   * Resolved state: whether the poller should be running *now*. Kept up to date
   * by the WhatsApp service as tokens come and go, so it answers "is polling
   * happening" rather than "was a variable set".
   */
  pollerEnabled: boolean;
  /**
   * Whether the reminder scheduler runs. Opt-in and off by default: a reminder
   * firing spends one of the day's runs, so nothing may schedule itself into
   * the budget without the operator asking. Set REMINDERS_ENABLED=true to turn
   * the 60-second firing loop on.
   */
  remindersEnabled: boolean;
  /**
   * Whether the scheduled-task loop runs. On by default: the operator asked
   * for scheduled tasks, and each fire still spends from the daily budget, so
   * a runaway schedule cannot cost more than the day allows. Set
   * SCHEDULER_ENABLED=false to turn the 60-second firing loop off.
   */
  schedulerEnabled: boolean;
  /**
   * 'key'  - the API needs a session, obtained once from a ?k= link.
   * 'open' - no check at all. Public internet plus a spendable daily quota.
   */
  authMode: 'key' | 'open';
  /** The secret in the access link. Not a password: nothing ever prompts for it. */
  accessKey: string;
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

  // NODE_ENV is cast to the union type below, so an unrecognised value would
  // silently become "development" and drop every production guard (database,
  // secrets, master key, access key). Fail here instead of booting unprotected.
  const nodeEnvRaw = (env.NODE_ENV ?? 'development').trim().toLowerCase();
  const validEnvs = ['development', 'test', 'production'];
  if (!validEnvs.includes(nodeEnvRaw)) {
    problems.push(
      `NODE_ENV must be one of ${validEnvs.join(', ')} (got "${env.NODE_ENV}") — ` +
        'a typo would otherwise disable the production guards silently',
    );
  }
  const nodeEnv = nodeEnvRaw as AppConfig['nodeEnv'];
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

  /**
   * Polling is opt-*out*, not opt-in. The agent's API key is the only thing the
   * WhatsApp third-party-agent feature asks for: the user generates it in the
   * app (Settings -> Agents -> Chat info -> API key) and pastes it in. Requiring
   * a second environment variable on top of that would be a setup step that
   * exists only in our implementation.
   */
  const pollerRaw = (env.POLLER_ENABLED ?? '').trim().toLowerCase();
  let pollerMode: AppConfig['pollerMode'] = 'auto';
  if (['1', 'true', 'yes', 'on'].includes(pollerRaw)) pollerMode = 'on';
  else if (['0', 'false', 'no', 'off'].includes(pollerRaw)) pollerMode = 'off';
  else if (pollerRaw !== '') {
    problems.push(`POLLER_ENABLED must be true/false (got "${env.POLLER_ENABLED}")`);
  }

  const hasEnvToken = Boolean((env.WHATSAPP_TOKEN ?? '').trim());
  /**
   * A poller with no token would hammer the platform with unauthenticated
   * requests, so this is worth failing over — but "no token in the environment"
   * is not the same as "no token": the encrypted store can hold one, and that
   * store needs MASTER_KEY to exist at all. So the hard failure stays where the
   * answer is knowable here — explicitly requested, and no token reachable from
   * either place. Otherwise the service waits for a key to be stored, and says
   * so on /readyz rather than at 3am.
   */
  if (pollerMode === 'on' && !hasEnvToken && !masterKey) {
    problems.push(
      'POLLER_ENABLED=true but WHATSAPP_TOKEN is empty and MASTER_KEY is not set — ' +
        'the poller would spin. Set WHATSAPP_TOKEN, or set MASTER_KEY and store the ' +
        'agent API key in Settings.',
    );
  }

  // The real engine is the default: silently running the scripted one in
  // production would look like the agent working while nothing real ever ran.
  const engineRaw = (env.ENGINE ?? 'antigravity').trim().toLowerCase();
  if (engineRaw !== 'scripted' && engineRaw !== 'antigravity') {
    problems.push(`ENGINE must be "scripted" or "antigravity" (got "${engineRaw}")`);
  }

  const dailyRunBudget = readInt(env.DAILY_RUN_BUDGET, 100);
  if (dailyRunBudget < 1 || dailyRunBudget > 10_000) {
    problems.push(`DAILY_RUN_BUDGET must be between 1 and 10000 (got ${dailyRunBudget})`);
  }

  const geminiApiKey = (env.GEMINI_API_KEY ?? '').trim();
  if (isProduction && engineRaw === 'antigravity' && !geminiApiKey) {
    // Warn, don't die. The key can live in Settings instead of the
    // environment: main.ts resolves it per request, and the engine refuses
    // runs honestly when no key exists anywhere. Dying here would contradict
    // DEPLOY.md, which lets the operator leave the env var empty.
    console.warn(
      '[config] ENGINE=antigravity but GEMINI_API_KEY is empty — agent runs will be ' +
        'refused until a key is stored in Settings.',
    );
  }

  const authRaw = (env.AUTH_MODE ?? 'key').trim().toLowerCase();
  if (authRaw !== 'key' && authRaw !== 'open') {
    problems.push(`AUTH_MODE must be "key" or "open" (got "${authRaw}")`);
  }
  let authMode: AppConfig['authMode'] = authRaw === 'open' ? 'open' : 'key';

  // ACCESS_KEY is the name that matches what this is now. OPERATOR_PASSWORD is
  // still read so an environment configured earlier keeps working.
  const accessKey = ((env.ACCESS_KEY ?? env.OPERATOR_PASSWORD) ?? '').trim();
  if (isProduction && authMode === 'key' && accessKey.length < 12) {
    problems.push(
      'ACCESS_KEY must be at least 12 characters in production — it is the only thing between ' +
        'the public internet and your daily run quota. Generate one with `openssl rand -hex 24`.',
    );
  }

  /**
   * A key mode with no key is a locked door with no handle.
   *
   * `checkAccessKey` compares against an empty expected value and returns false
   * for everything, so every request is refused and the sign-in screen can
   * never be passed — `npm run dev` serves an app nobody can enter. Production
   * is already covered above; this is the local case, where the honest fix is
   * to open the door *loudly* rather than make someone debug a 401 on their own
   * machine. Asking for key mode explicitly still gets you an error, so this
   * can never quietly downgrade a deployment that meant to be protected.
   */
  if (!isProduction && authMode === 'key' && accessKey.length === 0) {
    if (env.AUTH_MODE !== undefined) {
      problems.push(
        'AUTH_MODE=key needs ACCESS_KEY — set one, or use AUTH_MODE=open for a local run',
      );
    } else {
      console.warn(
        '[config] ACCESS_KEY is not set — development is running OPEN. Set ACCESS_KEY to require the ?k= link.',
      );
      authMode = 'open';
    }
  }

  if (authMode === 'open' && !isProduction) {
    console.warn(
      '[config] AUTH_MODE=open — anyone who finds this URL can run missions and spend the daily quota',
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv,
    isProduction,
    port: readInt(env.PORT, 3000),
    databaseUrl,
    sessionSecret: sessionSecret || 'dev-only-insecure-session-secret-change-me',
    /**
     * Empty when unset, rather than a placeholder of zeros.
     *
     * A fake key would make `sealSecret` succeed and the `secrets` table look
     * populated while every value in it was readable by anyone holding this
     * source file. An empty key says "encryption is unavailable", which is a
     * state the store can report honestly and the API can refuse writes over.
     */
    masterKey,
    geminiApiKey,
    whatsappToken: (env.WHATSAPP_TOKEN ?? '').trim(),
    whatsappTo: (env.WHATSAPP_TO ?? '').trim(),
    githubToken: (env.GITHUB_TOKEN ?? '').trim(),
    whatsappApiBase: (env.WHATSAPP_API_BASE ?? '').trim(),
    engineName: engineRaw === 'scripted' ? 'scripted' : 'antigravity',
    antigravityAgent: (env.ANTIGRAVITY_AGENT ?? 'antigravity-preview-09-2026').trim(),
    antigravityApiBase: (env.ANTIGRAVITY_API_BASE ?? '').trim(),
    antigravityMaxTokens: readInt(env.ANTIGRAVITY_MAX_TOKENS, 0),
    pollerMode,
    // Resolved for real by the WhatsApp service once secrets are loaded; this is
    // the honest answer available at this point: a token is reachable and
    // polling was not switched off.
    pollerEnabled: pollerMode !== 'off' && hasEnvToken,
    remindersEnabled: ['1', 'true', 'yes', 'on'].includes(
      (env.REMINDERS_ENABLED ?? '').trim().toLowerCase(),
    ),
    schedulerEnabled: !['0', 'false', 'no', 'off'].includes(
      (env.SCHEDULER_ENABLED ?? '').trim().toLowerCase(),
    ),
    authMode,
    accessKey,
    dailyRunBudget,
    eventRetentionDays: readInt(env.EVENT_RETENTION_DAYS, 14),
    artifactRetentionDays: readInt(env.ARTIFACT_RETENTION_DAYS, 7),
    appUrl: (env.APP_URL ?? '').trim(),
  };
}
