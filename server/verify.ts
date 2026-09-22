/**
 * Verifying the two credentials this app depends on.
 *
 * A settings screen can tell you a key was stored. It cannot tell you the key
 * works — that requires calling the provider, and the provider's answer is the
 * only answer that counts. This module does exactly that, and nothing else:
 * it never touches the database, never starts the server, and never prints a
 * credential. Run it wherever there is internet (`npm run verify`, or the
 * "Verify integrations" workflow) and it says, in the platform's own words,
 * whether each key is good.
 *
 * Three checks, cheapest first:
 *
 *   1. **Gemini key** — a GET on the models list. One request, no tokens spent,
 *      and it separates "key rejected" from "network unreachable".
 *   2. **The agent** — a real mission through the *real* `AntigravityEngine`,
 *      with our own request shape and the configured agent id. This is the only
 *      thing that can prove `antigravity-preview-09-2026` still exists: the
 *      models list says nothing about managed agents (a GET on the agents
 *      resource returns an empty list even for a healthy key).
 *   3. **WhatsApp** — a read-only long poll (`getUpdates`, zero-second timeout)
 *      proves the token authenticates; an optional send puts a message in the
 *      agent's chat, which is the one recipient this platform allows.
 *
 * Every failure is classified rather than thrown, because "it did not work" is
 * not a useful thing to tell someone at midnight: the difference between a bad
 * key, a bad agent id, an exhausted quota and a blocked network is the whole
 * value of running this.
 */
import { AntigravityEngine } from './engine/antigravity.js';
import { EngineAbortedError, EngineError, type EngineContext, type EngineErrorType } from './engine/types.js';
import { WhatsAppClient, WhatsAppError } from './whatsapp/api.js';
import { fingerprintOf, maskSecret } from './crypto.js';

export const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_AGENT = 'antigravity-preview-09-2026';
export const DEFAULT_WHATSAPP_BASE = 'https://api.whatsapp.com/agent/v1';

/** A plain-language outcome, plus the machine-readable cause behind it. */
export type Verdict =
  | 'ok'
  | 'not_configured'
  | 'auth_failed'
  | 'agent_unavailable'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'invalid_request'
  | 'upstream_error'
  | 'network'
  | 'timeout'
  /** 409 from the platform: another process is polling this agent right now. */
  | 'conflict';

export interface CheckResult {
  /** Which credential or capability was checked. */
  check: 'gemini_key' | 'agent' | 'whatsapp_token' | 'whatsapp_send';
  verdict: Verdict;
  /** One sentence a human can act on. */
  summary: string;
  /** Where the answer came from, for the record. Never a credential. */
  evidence?: Record<string, unknown>;
  /** How long the check took. */
  ms?: number;
}

const OK: Verdict = 'ok';

/** Turn an engine failure into the same vocabulary the other checks use. */
export function verdictForEngineError(errorType: EngineErrorType): Verdict {
  switch (errorType) {
    case 'auth_failed':
      return 'auth_failed';
    case 'agent_unavailable':
    case 'invalid_request':
      return errorType === 'invalid_request' ? 'invalid_request' : 'agent_unavailable';
    case 'quota_exceeded':
      return 'quota_exceeded';
    case 'rate_limited':
      return 'rate_limited';
    case 'network_error':
      return 'network';
    case 'idle_timeout':
    case 'truncated':
      return 'timeout';
    default:
      return 'upstream_error';
  }
}

/** Only the part of a WhatsApp failure that is safe and useful to show. */
function describeWhatsAppError(err: WhatsAppError): string {
  return err.message;
}

function verdictForWhatsAppError(err: WhatsAppError): Verdict {
  // `forbidden` is a token the platform will not accept: same fix as `auth`.
  if (err.kind === 'auth' || err.kind === 'forbidden') return 'auth_failed';
  if (err.kind === 'rate_limited') return 'rate_limited';
  if (err.kind === 'network') return 'network';
  // One poller per agent. A 409 here means the token is *fine* and something
  // else already holds the connection — usually the other deployment, and the
  // one case where the fix is not to touch the key.
  if (err.kind === 'poll_replaced') return 'conflict';
  if (err.kind === 'not_found') return 'invalid_request';
  if (err.status && err.status >= 500) return 'upstream_error';
  return 'invalid_request';
}

function isNetworkFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|network|socket hang up|SSL/i.test(
    message,
  );
}

/**
 * The credential's identity, for the report. A fingerprint says "this is the
 * value I was given" without ever being the value.
 */
export function identify(secret: string): string {
  if (!secret) return '(none)';
  return `${fingerprintOf(secret)} · ${maskSecret(secret)}`;
}

// ---------------------------------------------------------------------------
// 1. the key
// ---------------------------------------------------------------------------

export interface GeminiCheckOptions {
  apiKey: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Is the key accepted by the API?
 *
 * A GET on the models list is the cheapest request that distinguishes a rejected
 * key from a broken network, and it costs nothing.
 */
export async function checkGeminiKey(options: GeminiCheckOptions): Promise<CheckResult> {
  const startedAt = Date.now();
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    return {
      check: 'gemini_key',
      verdict: 'not_configured',
      summary: 'No Gemini key was provided (GEMINI_API_KEY, or store one in Settings).',
    };
  }

  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(`${base}/models?key=${encodeURIComponent(apiKey)}`, {
      signal: options.signal,
    });
    const text = await res.text();
    const ms = Date.now() - startedAt;

    if (res.ok) {
      let count: number | null = null;
      try {
        const body = JSON.parse(text) as { models?: unknown[] };
        count = Array.isArray(body.models) ? body.models.length : null;
      } catch {
        /* a 200 that is not JSON is still a 200: the key was accepted */
      }
      return {
        check: 'gemini_key',
        verdict: OK,
        summary: `Key accepted — ${count ?? 'unknown'} models visible to it.`,
        evidence: { status: res.status, models: count, fingerprint: fingerprintOf(apiKey) },
        ms,
      };
    }

    // The API's own words are more useful than any paraphrase of them.
    let apiMessage = text.slice(0, 300);
    let apiReason = '';
    try {
      const body = JSON.parse(text) as { error?: { message?: string; status?: string; details?: unknown[] } };
      apiMessage = body.error?.message ?? apiMessage;
      apiReason = body.error?.status ?? '';
    } catch {
      /* not JSON: keep the raw prefix */
    }

    const verdict: Verdict =
      res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID/i.test(apiMessage)
        ? 'auth_failed'
        : res.status === 429
          ? 'rate_limited'
          : res.status >= 500
            ? 'upstream_error'
            : 'invalid_request';

    return {
      check: 'gemini_key',
      verdict,
      summary:
        verdict === 'auth_failed'
          ? `The API rejected this key: ${apiMessage}`
          : `The API answered ${res.status}: ${apiMessage}`,
      evidence: { status: res.status, reason: apiReason, fingerprint: fingerprintOf(apiKey) },
      ms,
    };
  } catch (err) {
    return {
      check: 'gemini_key',
      verdict: isNetworkFailure(err) ? 'network' : 'upstream_error',
      summary: `Could not reach ${base} — ${(err as Error).message}. If this machine has no outbound internet, the check has to run somewhere that does.`,
      evidence: { fingerprint: fingerprintOf(apiKey) },
      ms: Date.now() - startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. the agent
// ---------------------------------------------------------------------------

export interface AgentCheckOptions {
  apiKey: string;
  agent?: string;
  apiBase?: string;
  /** Kept tiny on purpose: this is a smoke test, not a mission. */
  prompt?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTotalTokens?: number;
}

export interface AgentCheckResult extends CheckResult {
  text?: string;
  thinking?: string;
  interactionId?: string;
  environmentId?: string;
  toolCalls?: string[];
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Does the configured agent actually answer?
 *
 * This runs the production engine — the same class, the same request shape, the
 * same continuation fields — with a hand-built context, so a pass here means the
 * real path works rather than that a hand-written probe does. It costs one
 * interaction, so the prompt is deliberately trivial.
 */
export async function checkAgent(options: AgentCheckOptions): Promise<AgentCheckResult> {
  const startedAt = Date.now();
  const apiKey = options.apiKey.trim();
  const agent = (options.agent ?? DEFAULT_AGENT).trim();

  if (!apiKey) {
    return {
      check: 'agent',
      verdict: 'not_configured',
      summary: 'No Gemini key was provided, so the agent cannot be tried.',
    };
  }

  const engine = new AntigravityEngine({
    apiKey,
    agent,
    apiBase: options.apiBase,
    maxTotalTokens: options.maxTotalTokens,
    fetchImpl: options.fetchImpl,
  });

  const answer: string[] = [];
  const thinking: string[] = [];
  const toolCalls: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);

  /**
   * A context built by hand. Deliberately minimal: the engine only ever pushes
   * output through these callbacks, which is what keeps it independent of the
   * database, the run lifecycle and the SSE stream.
   */
  const ctx: EngineContext = {
    runId: 'verify',
    signal: controller.signal,
    previousInteractionId: null,
    environmentId: null,
    text: (chunk) => answer.push(chunk),
    thinking: (chunk) => thinking.push(chunk),
    tool: (name) => toolCalls.push(name),
    toolResult: () => {},
    log: () => {},
  };

  try {
    const result = await engine.run(
      options.prompt ?? 'Reply with the single word: ready',
      ctx,
    );
    const text = (result.text || answer.join('')).trim();

    return {
      check: 'agent',
      verdict: OK,
      summary: `Agent "${agent}" answered: ${text.slice(0, 200) || '(empty)'}`,
      evidence: { agent, interactionId: result.interactionId ?? null, toolCalls },
      text,
      thinking: thinking.join(''),
      interactionId: result.interactionId,
      environmentId: result.environmentId,
      toolCalls,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    const ms = Date.now() - startedAt;

    if (err instanceof EngineAbortedError || controller.signal.aborted) {
      return {
        check: 'agent',
        verdict: 'timeout',
        summary: `The agent did not finish within ${Math.round((options.timeoutMs ?? 180_000) / 1000)}s.`,
        evidence: { agent },
        ms,
      };
    }

    if (err instanceof EngineError) {
      const verdict = verdictForEngineError(err.errorType);
      return {
        check: 'agent',
        verdict,
        summary:
          verdict === 'auth_failed'
            ? `The agent refused the key: ${err.message}`
            : verdict === 'agent_unavailable'
              ? `Agent "${agent}" is not available: ${err.message}. The date suffix on the agent id changes — check ANTIGRAVITY_AGENT.`
              : `Agent check failed (${err.errorType}): ${err.message}`,
        evidence: { agent, errorType: err.errorType, status: err.status ?? null, retryable: err.retryable },
        ms,
      };
    }

    return {
      check: 'agent',
      verdict: isNetworkFailure(err) ? 'network' : 'upstream_error',
      summary: `Agent check failed: ${(err as Error).message}`,
      evidence: { agent },
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 3. WhatsApp
// ---------------------------------------------------------------------------

export interface WhatsAppCheckOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Does the token authenticate?
 *
 * A zero-second long poll is the read-only way to ask: 204 means "nothing
 * waiting, and your token is fine", 200 means the same with messages attached.
 * Nothing is consumed and nothing is sent, so the message the user may have
 * already typed is not lost.
 */
export async function checkWhatsAppToken(options: WhatsAppCheckOptions): Promise<CheckResult> {
  const startedAt = Date.now();
  const token = options.token.trim();
  if (!token) {
    return {
      check: 'whatsapp_token',
      verdict: 'not_configured',
      summary:
        'No WhatsApp token was provided (WHATSAPP_TOKEN, or store the agent API key in Settings).',
    };
  }

  try {
    const client = new WhatsAppClient({
      token,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    const updates = await client.getUpdates({ timeoutSeconds: 0, signal: options.signal });
    const ms = Date.now() - startedAt;

    const pending = updates?.messages?.length ?? 0;
    return {
      check: 'whatsapp_token',
      verdict: OK,
      summary:
        pending > 0
          ? `Token accepted — ${pending} message(s) waiting in the agent's inbox.`
          : 'Token accepted — the agent\'s inbox is empty and the connection is live.',
      evidence: {
        status: updates ? 200 : 204,
        pending,
        nextOffset: updates?.nextOffset ?? null,
        fingerprint: fingerprintOf(token),
      },
      ms,
    };
  } catch (err) {
    const ms = Date.now() - startedAt;

    if (err instanceof WhatsAppError) {
      const verdict = verdictForWhatsAppError(err);
      return {
        check: 'whatsapp_token',
        verdict,
        summary:
          verdict === 'network'
            ? `Could not reach the WhatsApp Agent Platform — ${describeWhatsAppError(err)}. This check needs outbound internet from wherever it runs.`
            : verdict === 'auth_failed'
            ? `The platform rejected this token: ${describeWhatsAppError(err)}. Generate a new API key in WhatsApp → Settings → Agents → the agent's chat → Chat info.`
              : verdict === 'conflict'
                ? 'Another process is already polling this agent, so the token works — that connection is just held elsewhere. Exactly one poller is allowed; set POLLER_ENABLED=false on whichever host should stay quiet.'
                : `The platform answered: ${describeWhatsAppError(err)}`,
        evidence: { status: err.status ?? null, kind: err.kind, fingerprint: fingerprintOf(token) },
        ms,
      };
    }

    return {
      check: 'whatsapp_token',
      verdict: isNetworkFailure(err) ? 'network' : 'upstream_error',
      summary: `Could not reach the WhatsApp Agent Platform — ${(err as Error).message}. This check needs outbound internet.`,
      evidence: { fingerprint: fingerprintOf(token) },
      ms,
    };
  }
}

/**
 * Put a test message in the agent's chat.
 *
 * The platform routes a send to the single account that created the agent, which
 * is why no recipient is passed: there is exactly one place a message can go,
 * and guessing an identifier is how a send ends up somewhere unintended.
 */
export async function sendWhatsAppTestMessage(
  options: WhatsAppCheckOptions & { text?: string },
): Promise<CheckResult> {
  const startedAt = Date.now();
  const token = options.token.trim();
  if (!token) {
    return {
      check: 'whatsapp_send',
      verdict: 'not_configured',
      summary: 'No WhatsApp token was provided, so nothing could be sent.',
    };
  }

  const text =
    options.text ??
    'Awais Codex check-in: this connection works. Reply with any task and it will run.';

  try {
    const client = new WhatsAppClient({
      token,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    const { messageId, waId } = await client.sendText(text);
    return {
      check: 'whatsapp_send',
      verdict: OK,
      summary: `Message delivered to the agent's chat${messageId ? ` (id ${messageId})` : ''}. It should be on your phone now.`,
      evidence: { status: 200, messageId, waId, fingerprint: fingerprintOf(token) },
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    const ms = Date.now() - startedAt;

    if (err instanceof WhatsAppError) {
      const verdict = verdictForWhatsAppError(err);
      return {
        check: 'whatsapp_send',
        verdict,
        summary:
          verdict === 'auth_failed'
            ? `The platform refused the send because the token is not valid: ${describeWhatsAppError(err)}`
            : `The send failed: ${describeWhatsAppError(err)}`,
        evidence: { status: err.status ?? null, kind: err.kind, fingerprint: fingerprintOf(token) },
        ms,
      };
    }

    return {
      check: 'whatsapp_send',
      verdict: isNetworkFailure(err) ? 'network' : 'upstream_error',
      summary: `Could not reach the platform to send: ${(err as Error).message}`,
      evidence: { fingerprint: fingerprintOf(token) },
      ms,
    };
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const MARK: Record<Verdict, string> = {
  ok: 'PASS',
  not_configured: 'SKIP',
  auth_failed: 'FAIL',
  agent_unavailable: 'FAIL',
  quota_exceeded: 'FAIL',
  rate_limited: 'FAIL',
  invalid_request: 'FAIL',
  upstream_error: 'FAIL',
  network: 'FAIL',
  timeout: 'FAIL',
  conflict: 'FAIL',
};

/** A report with no credentials in it — asserted by the tests. */
export function formatReport(results: CheckResult[]): string {
  const lines = results.map((result, index) => {
    const timing = result.ms === undefined ? '' : ` (${result.ms} ms)`;
    const detail = result.evidence
      ? `\n     evidence: ${JSON.stringify(result.evidence)}`
      : '';
    return `${index + 1}. [${MARK[result.verdict]}] ${result.check}${timing}\n     ${result.summary}${detail}`;
  });

  const failed = results.filter((r) => MARK[r.verdict] === 'FAIL').length;
  const skipped = results.filter((r) => r.verdict === 'not_configured').length;
  const passed = results.length - failed - skipped;

  const header = [
    'Awais Codex — credential verification',
    `${passed} passed · ${failed} failed · ${skipped} skipped`,
    '',
  ].join('\n');

  return `${header}${lines.join('\n')}\n`;
}

export function hasFailure(results: CheckResult[]): boolean {
  return results.some((result) => MARK[result.verdict] === 'FAIL');
}
