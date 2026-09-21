/**
 * Antigravity engine — the real one.
 *
 * Talks to the Gemini Interactions API (`/v1beta/interactions`) with the
 * `antigravity-preview` managed agent, in a remote sandbox, streaming.
 *
 * ## What it sends
 *
 * POST /v1beta/interactions
 *   agent: <agent id>          e.g. antigravity-preview-09-2026
 *   input: [{type:'text', ...}] the mission prompt
 *   environment: 'remote'      or a previous environment id, to resume a sandbox
 *   previous_interaction_id    when continuing, so the agent keeps its memory
 *   stream: true               tokens as they are produced
 *   store: true                so the interaction can be re-read if the stream dies
 *   agent_config               optional hard token ceiling
 *
 * ## The three rules this file obeys
 *
 * 1. NEVER RETRY SOMETHING THAT WAS PAID FOR. A mission costs one of ~100 daily
 *    runs and every token counts against a 100K TPM ceiling. Retries happen
 *    only for 429/503 *and* only while nothing has been emitted yet.
 *
 * 2. NEVER LOSE OUTPUT. Google's stream can be cut mid-mission. Rather than
 *    returning a truncated answer, the engine re-reads the stored interaction by
 *    id and recovers the complete text. Streaming is for feel; the stored
 *    interaction is the record.
 *
 * 3. NEVER HANG THE ONLY MISSION SLOT. There is exactly one run at a time. A
 *    stalled socket would block every future mission, so an idle watchdog
 *    aborts a connection that has gone quiet for too long.
 *
 * ## Parsing
 *
 * The upstream event schema is tolerated rather than assumed: the agent preview
 * is a beta and v1's parser already had to accept several shapes for the same
 * field. Everything is read defensively, and a shape we do not recognise is
 * skipped rather than crashing the mission.
 */
import {
  EngineAbortedError,
  EngineError,
  type Engine,
  type EngineContext,
  type EngineResult,
} from './types.js';

export interface AntigravityEngineOptions {
  apiKey: string;
  /** Agent id, e.g. antigravity-preview-09-2026. The date suffix changes. */
  agent: string;
  /** Base URL, overridable so tests can run against a local fake. */
  apiBase?: string;
  /** Optional hard ceiling on tokens for one interaction. */
  maxTotalTokens?: number;
  /** Give up on a socket that has produced nothing for this long. */
  idleTimeoutMs?: number;
  /** How long to keep polling a stored interaction after a cut stream. */
  recoveryAttempts?: number;
  /** Backoff before the single retry-safe retry. Tests set 0. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RECOVERY_ATTEMPTS = 4;

/** Shape of one streamed event. Every field optional: the schema is a beta. */
interface StreamPayload {
  event_type?: string;
  type?: string;
  status?: string;
  interaction?: {
    id?: string;
    environment_id?: string;
    output_text?: string;
    status?: string;
    steps?: unknown[];
  };
  step?: {
    summary?: string;
    tool_calls?: Array<{ name?: string; arguments?: Record<string, unknown> }>;
  };
  delta?: { text?: string };
  error?: { message?: string; code?: number | string };
}

export class AntigravityEngine implements Engine {
  readonly name = 'antigravity';

  private readonly apiBase: string;
  private readonly idleTimeoutMs: number;
  private readonly recoveryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AntigravityEngineOptions) {
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.recoveryAttempts = options.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
    if (!this.options.apiKey) {
      throw new EngineError(
        'No API key configured. Add GEMINI_API_KEY in Settings, or set it in the environment.',
        'auth_failed',
      );
    }

    // One controller for the whole mission: the operator's cancel, the idle
    // watchdog and shutdown all funnel into it.
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    ctx.signal.addEventListener('abort', forwardAbort, { once: true });

    let lastActivity = Date.now();
    let idleTimedOut = false;

    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > this.idleTimeoutMs) {
        console.warn(`[antigravity] idle for ${this.idleTimeoutMs}ms — aborting upstream`);
        idleTimedOut = true;
        controller.abort();
      }
    }, Math.min(15_000, Math.max(250, this.idleTimeoutMs / 4)));

    try {
      return await this.attempt(prompt, ctx, controller, () => {
        lastActivity = Date.now();
      });
    } catch (err) {
      // The watchdog aborts the same controller as an operator cancel, so the
      // abort surfaces as EngineAbortedError. Translate it back: a stalled
      // agent is a failure to report, not a cancellation the operator asked for.
      if (idleTimedOut && err instanceof EngineAbortedError) {
        throw new EngineError(
          `The agent stopped responding for ${Math.round(this.idleTimeoutMs / 1000)}s. ` +
            'The mission was closed so the slot stays free.',
          'idle_timeout',
        );
      }
      throw err;
    } finally {
      clearInterval(watchdog);
      ctx.signal.removeEventListener('abort', forwardAbort);
    }
  }

  private async attempt(
    prompt: string,
    ctx: EngineContext,
    controller: AbortController,
    touch: () => void,
  ): Promise<EngineResult> {
    let emitted = false;
    const emit = {
      text: (chunk: string): void => {
        if (chunk) emitted = true;
        ctx.text(chunk);
      },
      thinking: (chunk: string): void => {
        if (chunk) emitted = true;
        ctx.thinking(chunk);
      },
      tool: (name: string, args?: unknown): void => {
        emitted = true;
        ctx.tool(name, args);
      },
      log: (message: string, level?: 'info' | 'warn' | 'error'): void => ctx.log(message, level),
    };

    const payload: Record<string, unknown> = {
      agent: this.options.agent,
      input: [{ type: 'text', text: prompt }],
      environment: ctx.environmentId?.trim() || 'remote',
      stream: true,
      store: true,
    };
    if (ctx.previousInteractionId) {
      payload.previous_interaction_id = ctx.previousInteractionId;
    }
    if (this.options.maxTotalTokens && this.options.maxTotalTokens > 0) {
      payload.agent_config = { type: 'antigravity', max_total_tokens: this.options.maxTotalTokens };
    }

    let response = await this.post(payload, controller, touch);
    // The error body can only be read once, so cache it per response.
    let detail: string | null = null;
    const failureDetail = async (): Promise<string> => {
      if (detail === null) detail = await this.readError(response);
      return detail;
    };
    const repost = async (): Promise<void> => {
      response = await this.post(payload, controller, touch);
      detail = null;
    };

    // A stale sandbox is a normal, expected failure: environments expire. Fall
    // back to a fresh remote sandbox, but only if this mission was a
    // continuation and nothing has been produced yet — otherwise we would pay
    // twice for the same mission.
    const canStillChoose = !emitted && response.status !== 429 && response.status !== 503;
    if (
      !response.ok &&
      canStillChoose &&
      (response.status === 400 || response.status === 404) &&
      (payload.environment !== 'remote' || payload.previous_interaction_id !== undefined)
    ) {
      const message = await failureDetail();
      ctx.log(`Sandbox unavailable (${response.status}): ${message}. Starting a fresh one.`, 'warn');
      delete payload.previous_interaction_id;
      payload.environment = 'remote';
      await repost();
    }

    // The beta may not accept optional fields such as `store`. Drop the ones we
    // can live without and try once more, still only before any output.
    if (!response.ok && response.status === 400 && !emitted) {
      const message = await failureDetail();
      if (/unknown|invalid|unexpected|unsupported|field/i.test(message)) {
        ctx.log(`Retrying without optional fields: ${message}`, 'warn');
        delete payload.store;
        delete payload.agent_config;
        await repost();
      }
    }

    if (!response.ok) {
      const error = classify(response.status, await failureDetail());

      // Retry-safe statuses, and only before anything was produced: a retry
      // re-runs the whole mission, and on a ~100-run daily quota a wrong retry
      // is a wasted day.
      if (error.retryable && !emitted) {
        ctx.log(`${error.errorType} (${response.status}) — retrying once`, 'warn');
        await this.sleep(this.retryDelayMs, controller.signal);
        await repost();
        if (response.ok) return this.consume(response, ctx, emit, controller, touch);
        throw classify(response.status, await failureDetail());
      }
      throw error;
    }

    return this.consume(response, ctx, emit, controller, touch);
  }

  private post(
    payload: Record<string, unknown>,
    controller: AbortController,
    touch: () => void,
  ): Promise<Response> {
    touch();
    return this.fetchImpl(`${this.apiBase}/interactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header only, never a `?key=` query string: URLs end up in logs.
        'x-goog-api-key': this.options.apiKey,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch((err: Error) => {
      if (controller.signal.aborted) throw new EngineAbortedError();
      throw new EngineError(`Could not reach the agent: ${err.message}`, 'network_error', true);
    });
  }

  private async consume(
    response: Response,
    ctx: EngineContext,
    emit: {
      text: (chunk: string) => void;
      thinking: (chunk: string) => void;
      tool: (name: string, args?: unknown) => void;
      log: (message: string, level?: 'info' | 'warn' | 'error') => void;
    },
    controller: AbortController,
    touch: () => void,
  ): Promise<EngineResult> {
    let interactionId: string | undefined;
    let environmentId: string | undefined;
    let streamed = '';
    let authoritative = '';
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let sawTerminal = false;
    const artifacts = new Set<string>();

    if (!response.body) {
      throw new EngineError('The agent returned no stream body', 'upstream_error');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;

          const data = parsed as StreamPayload;

          if (data.error?.message) {
            throw new EngineError(data.error.message, 'upstream_error', false);
          }

          if (data.interaction?.id) interactionId = data.interaction.id;
          if (data.interaction?.environment_id) environmentId = data.interaction.environment_id;
          if (data.interaction?.status === 'completed') sawTerminal = true;
          if (data.status === 'completed') sawTerminal = true;

          if (data.interaction?.output_text) {
            authoritative = data.interaction.output_text;
            sawTerminal = true;
          } else if (Array.isArray(data.interaction?.steps)) {
            const extracted = extractOutputText(data.interaction.steps);
            if (extracted) authoritative = extracted;
          }

          if (Array.isArray(data.interaction?.steps)) {
            const usage = extractUsage(data.interaction.steps);
            tokensIn = usage.tokensIn ?? tokensIn;
            tokensOut = usage.tokensOut ?? tokensOut;
          }

          const summary = data.step?.summary;
          if (summary) emit.log(summary);

          for (const call of data.step?.tool_calls ?? []) {
            if (!call?.name) continue;
            emit.tool(call.name, call.arguments ?? {});
            const artifact = findArtifact(call.arguments);
            if (artifact && !artifacts.has(artifact)) {
              artifacts.add(artifact);
              emit.log(`Artifact produced: ${artifact}`);
            }
          }

          if (data.delta?.text) {
            streamed += data.delta.text;
            emit.text(data.delta.text);
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) throw new EngineAbortedError();
      if (err instanceof EngineError) throw err;

      // A cut stream is not a failure yet: the interaction is stored, so try to
      // recover the real answer before giving up on the mission.
      if (interactionId) {
        ctx.log('Stream interrupted — recovering the stored interaction.', 'warn');
        const recovered = await this.recover(interactionId, controller, touch);
        if (recovered) {
          if (recovered.text && recovered.text.length > streamed.length) {
            emit.text(recovered.text.slice(streamed.length));
          }
          return {
            text: pickLonger(recovered.text, streamed),
            interactionId,
            environmentId: recovered.environmentId ?? environmentId,
            tokensIn: recovered.tokensIn ?? tokensIn,
            tokensOut: recovered.tokensOut ?? tokensOut,
          };
        }
      }
      throw new EngineError(
        `The agent stream failed: ${(err as Error).message}`,
        'network_error',
        !interactionId,
      );
    } finally {
      reader.releaseLock?.();
    }

    if (!sawTerminal && !streamed && !authoritative) {
      throw new EngineError(
        'The agent finished without producing an answer. It may have refused the mission or hit a limit.',
        'truncated',
        false,
      );
    }

    return {
      text: pickLonger(authoritative, streamed),
      interactionId,
      environmentId,
      tokensIn,
      tokensOut,
    };
  }

  /**
   * Re-read a stored interaction after the stream died.
   *
   * Best effort by design: if the interaction was not stored this returns null
   * and the mission keeps whatever it had already streamed.
   */
  private async recover(
    interactionId: string,
    controller: AbortController,
    touch: () => void,
  ): Promise<{
    text: string;
    environmentId?: string;
    tokensIn?: number;
    tokensOut?: number;
  } | null> {
    for (let attempt = 0; attempt < this.recoveryAttempts; attempt++) {
      if (controller.signal.aborted) return null;
      await this.sleep(1_500 * (attempt + 1), controller.signal).catch(() => {});

      try {
        touch();
        const res = await this.fetchImpl(`${this.apiBase}/interactions/${encodeURIComponent(interactionId)}`, {
          headers: { 'x-goog-api-key': this.options.apiKey },
          signal: controller.signal,
        });
        if (!res.ok) continue;

        const data = (await res.json()) as StreamPayload['interaction'] & { status?: string };
        const steps = Array.isArray(data?.steps) ? data.steps : [];
        const text = data?.output_text || extractOutputText(steps);
        const usage = extractUsage(steps);

        // Keep polling while it is still running and we have nothing to show.
        if (!text && data?.status && data.status !== 'completed' && data.status !== 'failed') {
          continue;
        }
        return {
          text,
          environmentId: data?.environment_id,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
        };
      } catch {
        // Ignore and try again; the loop is bounded.
      }
    }
    return null;
  }

  private async readError(response: Response): Promise<string> {
    try {
      const body = await response.text();
      if (!body) return `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        return parsed.error?.message ?? body.slice(0, 300);
      } catch {
        return body.slice(0, 300);
      }
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new EngineAbortedError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new EngineAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Map an HTTP status to a failure the operator can act on. */
export function classify(status: number, detail: string): EngineError {
  if (status === 429) {
    // Google returns 429 both for "you are going too fast" and for "you have
    // spent the day". Only an explicit per-day marker is treated as spent:
    // messages like "Resource has been exhausted" are ambiguous, and the first
    // version of this treated the word "exhausted" as a spent quota, which
    // would have killed missions on a transient blip.
    //
    // Retrying an ambiguous 429 is safe here because a retry only ever happens
    // BEFORE any tokens have been produced — nothing was paid for, and the
    // daily budget guard is what actually stops over-spending.
    const spent = /per[\s_-]?day|perday|daily|\bday\b/i.test(detail);
    return spent
      ? new EngineError(`Daily quota reached: ${detail}`, 'quota_exceeded', false, status)
      : new EngineError(`Rate limited: ${detail}`, 'rate_limited', true, status);
  }
  if (status === 503) return new EngineError(`Agent unavailable: ${detail}`, 'upstream_error', true, status);
  if (status === 401 || status === 403) {
    return new EngineError(`API key rejected: ${detail}`, 'auth_failed', false, status);
  }
  if (status === 404) {
    return new EngineError(
      `Agent not found (${detail}). The agent id is date-stamped — set ANTIGRAVITY_AGENT to a current one.`,
      'agent_unavailable',
      false,
      status,
    );
  }
  if (status === 400 || status === 422) {
    return new EngineError(`The agent rejected the request: ${detail}`, 'invalid_request', false, status);
  }
  return new EngineError(`Agent error ${status}: ${detail}`, 'upstream_error', status >= 500, status);
}

/** Longer wins: the authoritative text can be complete while deltas were cut. */
export function pickLonger(a: string, b: string): string {
  return a.length >= b.length ? a : b;
}

/**
 * Read one `event:`/`data:` block from the upstream stream.
 *
 * Tolerant on purpose. Multi-line `data:` is joined per the SSE spec, a
 * comment-only block is ignored, and a payload that is not JSON is dropped
 * rather than thrown — one malformed frame must not kill a running mission.
 */
export function parseSseBlock(block: string): StreamPayload | null {
  if (!block.trim()) return null;

  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim());
  }

  const raw = dataLines.join('\n');
  if (!raw || raw === '[DONE]') return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StreamPayload) : null;
  } catch {
    return null;
  }
}

/** Pull the model's text out of an interaction's step list. */
export function extractOutputText(steps: unknown[]): string {
  let out = '';
  for (const raw of steps) {
    const step = raw as {
      type?: string;
      content?: unknown;
      text?: string;
    };
    if (step?.type !== 'model_output' && !step?.text) continue;

    if (typeof step.text === 'string') {
      out += step.text;
      continue;
    }
    if (Array.isArray(step.content)) {
      for (const part of step.content) {
        if (typeof part === 'string') out += part;
        else if (part && typeof (part as { text?: string }).text === 'string') {
          out += (part as { text: string }).text;
        }
      }
    } else if (typeof step.content === 'string') {
      out += step.content;
    } else if (step.content && typeof (step.content as { text?: string }).text === 'string') {
      out += (step.content as { text: string }).text;
    }
  }
  return out;
}

/** Token usage, wherever the beta decided to put it this week. */
export function extractUsage(steps: unknown[]): { tokensIn?: number; tokensOut?: number } {
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  for (const raw of steps) {
    const step = raw as { usage?: Record<string, unknown>; usage_metadata?: Record<string, unknown> };
    const usage = step?.usage ?? step?.usage_metadata;
    if (!usage) continue;
    const input = usage.input_tokens ?? usage.prompt_token_count ?? usage.input_token_count;
    const output =
      usage.output_tokens ?? usage.candidates_token_count ?? usage.total_token_count ?? usage.output_token_count;
    if (typeof input === 'number') tokensIn = input;
    if (typeof output === 'number') tokensOut = output;
  }
  return { tokensIn, tokensOut };
}

/** A path that looks like something worth handing back to the operator. */
export function findArtifact(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ['TargetFile', 'target_file', 'path', 'file', 'filename']) {
    const value = args[key];
    if (typeof value === 'string' && /\.(apk|zip|tar|tar\.gz|aab|ipa)$/i.test(value)) return value;
  }
  return null;
}
