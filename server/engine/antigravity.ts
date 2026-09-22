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
 *   thinking_summaries: 'auto' live thought summaries in the stream (retried as
 *                          THINKING_SUMMARIES_AUTO if the API rejects the value)
 *   agent_config               optional hard token ceiling
 *
 * ## The three rules this file obeys
 *
 * 1. NEVER PAY TWICE, NEVER GIVE UP EARLY. A rejected request cost nothing
 *    and is re-posted with patient backoff. A 429 that lands mid-mission does
 *    not fail the run: the engine waits out the TPM window and resumes the
 *    stored interaction, so the agent continues where it stopped. Only a spent
 *    daily quota fails fast — no wait can fix that.
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
 * skipped rather than crashing the mission. Thought deltas (delta.type
 * 'thought_summary', step types 'thought'/'thought_summary') feed the Thinking
 * panel; text deltas feed the answer stream.
 */
import {
  EngineAbortedError,
  EngineError,
  type Engine,
  type EngineContext,
  type EngineResult,
} from './types.js';

/**
 * A credential, or a function that produces the current one.
 *
 * The function form exists so a key stored in Settings takes effect on the next
 * mission instead of the next deployment: the engine is built once at boot, but
 * it asks for the value every time it makes a request. Callers with a plain
 * string (tests, mostly) are unaffected.
 */
type Credential = string | (() => string);

export interface AntigravityEngineOptions {
  apiKey: Credential;
  /** Agent id, e.g. antigravity-preview-09-2026. The date suffix changes. */
  agent: Credential;
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
  /**
   * First wait when Google rate-limits the mission (TPM). Doubles each time,
   * capped at 2 minutes per wait. The engine waits instead of failing, so a
   * free-tier quota never kills a mission — it just slows it down.
   */
  rateLimitBaseDelayMs?: number;
  /**
   * Stop waiting and park the mission after this much total rate-limit delay.
   * The single mission slot cannot hang forever, however patient we are.
   */
  rateLimitMaxWaitMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_RECOVERY_ATTEMPTS = 4;
const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 30_000;
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 30 * 60_000;
/** Longest single wait between rate-limit retries. TPM windows clear per minute. */
const MAX_RATE_LIMIT_DELAY_MS = 2 * 60_000;

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
    type?: string;
    summary?: string;
    content?: unknown;
    tool_calls?: Array<{ name?: string; arguments?: Record<string, unknown> }>;
  };
  delta?: { type?: string; text?: string; content?: unknown; [key: string]: unknown };
  error?: { message?: string; code?: number | string };
}

export class AntigravityEngine implements Engine {
  readonly name = 'antigravity';

  private readonly apiBase: string;
  private readonly idleTimeoutMs: number;
  private readonly recoveryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly rateLimitBaseDelayMs: number;
  private readonly rateLimitMaxWaitMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AntigravityEngineOptions) {
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.recoveryAttempts = options.recoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? 3_000;
    this.rateLimitBaseDelayMs = options.rateLimitBaseDelayMs ?? DEFAULT_RATE_LIMIT_BASE_DELAY_MS;
    this.rateLimitMaxWaitMs = options.rateLimitMaxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Resolve a credential that may have been replaced since the last mission. */
  private static resolve(value: Credential): string {
    return (typeof value === 'function' ? value() : value).trim();
  }

  private get apiKey(): string {
    return AntigravityEngine.resolve(this.options.apiKey);
  }

  private get agent(): string {
    return AntigravityEngine.resolve(this.options.agent);
  }

  async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
    if (!this.apiKey) {
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
      agent: this.agent,
      input: [{ type: 'text', text: prompt }],
      environment: ctx.environmentId?.trim() || 'remote',
      stream: true,
      store: true,
      // Default none upstream would keep the Thinking panel silent for the
      // whole run; "auto" asks for live thought summaries.
      thinking_summaries: 'auto',
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

    // The docs say `thinking_summaries` takes "auto"/"none", but some backends
    // reject "auto" with "unknown enum value" and only accept the qualified
    // THINKING_SUMMARIES_AUTO. Retry once with the qualified name. This MUST
    // run before the field-stripping fallback below: that one matches the word
    // "unknown" too, and would strip `store` and re-send the same rejected
    // value forever — the feature would die quietly instead of recovering.
    if (!response.ok && response.status === 400 && !emitted && payload.thinking_summaries === 'auto') {
      const message = await failureDetail();
      if (/unknown enum|invalid enum/i.test(message)) {
        ctx.log(`Retrying with THINKING_SUMMARIES_AUTO: ${message}`, 'warn');
        payload.thinking_summaries = 'THINKING_SUMMARIES_AUTO';
        await repost();
      }
    }

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
    // can live without and try once more, still only before any output. The
    // once-guard matters: a 400 the strip cannot fix must fail loudly in the
    // loop below instead of re-posting forever and hanging the mission slot.
    let optionalFieldsStripped = false;
    if (!response.ok && response.status === 400 && !emitted && !optionalFieldsStripped) {
      const message = await failureDetail();
      if (/unknown|invalid|unexpected|unsupported|field/i.test(message)) {
        optionalFieldsStripped = true;
        ctx.log(`Retrying without optional fields: ${message}`, 'warn');
        delete payload.store;
        delete payload.agent_config;
        await repost();
      }
    }

    // The patient loop: TPM rate limits are waited out, not failed. A rejected
    // request cost nothing, so re-posting it is safe. A 429 that lands
    // mid-stream resumes the stored interaction instead of restarting the
    // mission, so the agent continues where it stopped and no token is ever
    // paid twice. Only a spent daily quota fails fast — waiting cannot fix
    // that, and the run is recorded honestly instead of hanging the slot.
    let waits = 0;
    let waitedMs = 0;
    for (;;) {
      if (!response.ok) {
        const error = classify(response.status, await failureDetail());
        if (error.retryable) {
          waitedMs = await this.waitForRateLimit(emit, controller, touch, waits, waitedMs);
          waits += 1;
          await repost();
          continue;
        }
        throw error;
      }
      try {
        return await this.consume(response, ctx, emit, controller, touch);
      } catch (err) {
        const limited = asResumableRateLimit(err);
        if (!limited) throw err;
        const resumeId = limited.interactionId;
        if (resumeId) {
          // Continue the stored interaction — the agent keeps its memory and
          // its sandbox instead of starting (and billing) the mission over.
          payload.previous_interaction_id = resumeId;
        } else if (emitted) {
          // Output was produced but there is no stored interaction to resume.
          // Restarting would pay twice for the same mission: do not retry.
          throw err;
        }
        waitedMs = await this.waitForRateLimit(emit, controller, touch, waits, waitedMs);
        waits += 1;
        await repost();
      }
    }
  }

  /**
   * Wait out a rate limit instead of failing the mission. TPM windows clear
   * every minute, so a bounded wait almost always succeeds; the wait is logged
   * so the operator watches patience, not a hang. Throws when the total wait
   * budget is spent — the single mission slot cannot hang forever.
   */
  private async waitForRateLimit(
    emit: { log(message: string, level?: 'info' | 'warn' | 'error'): void },
    controller: AbortController,
    touch: () => void,
    waits: number,
    waitedMs: number,
  ): Promise<number> {
    const delay = Math.min(this.rateLimitBaseDelayMs * 2 ** Math.min(waits, 2), MAX_RATE_LIMIT_DELAY_MS);
    if (waitedMs + delay > this.rateLimitMaxWaitMs) {
      throw new EngineError(
        `Google rate-limited the mission for ${Math.round(waitedMs / 60000)}m and the wait budget is spent. ` +
          'Nothing was lost — run the mission again in a few minutes when the TPM window clears.',
        'rate_limited',
        false,
        429,
      );
    }
    emit.log(
      `Rate limited by Google (TPM) — waiting ${Math.round(delay / 1000)}s, then continuing where it stopped` +
        (waitedMs > 0 ? ` (${(waitedMs / 60000).toFixed(1)}m waited so far)` : '') +
        '.',
      'warn',
    );
    // Sleep in small chunks: a deliberate wait is activity, not a stall, so
    // the idle watchdog stays quiet, and an operator cancel still lands fast.
    let remaining = delay;
    while (remaining > 0) {
      if (controller.signal.aborted) throw new EngineAbortedError();
      touch();
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 5_000)));
      remaining -= 5_000;
    }
    return waitedMs + delay;
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
        'x-goog-api-key': this.apiKey,
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
    // The upstream stream sends one summary per step, but may repeat the same
    // summary across frames — only a change is new reasoning worth showing.
    let lastSummary: string | undefined;
    // Same for live thought summaries: consecutive deltas may repeat a frame.
    let lastThought: string | undefined;

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
            throw rateLimitOrUpstream(data.error, interactionId);
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

          // The step summary is the agent's own narration of what it is doing —
          // the closest thing this stream gives us to a reasoning trace. It
          // feeds the Thinking panel as well as the step timeline, so the
          // browser shows a live narrative even though the API exposes no
          // dedicated thinking channel.
          const summary = data.step?.summary;
          if (summary) {
            emit.log(summary);
            if (summary !== lastSummary) {
              lastSummary = summary;
              emit.thinking(`${summary}\n`);
            }
          }

          for (const call of data.step?.tool_calls ?? []) {
            if (!call?.name) continue;
            emit.tool(call.name, call.arguments ?? {});
            const artifact = findArtifact(call.arguments);
            if (artifact && !artifacts.has(artifact)) {
              artifacts.add(artifact);
              emit.log(`Artifact produced: ${artifact}`);
              // First-class, not just a log line: the executor records it so
              // the file can actually be downloaded later.
              ctx.artifact?.(artifact);
            }
          }

          // step.start events carry a typed step object. A thought step may hold
          // its text as Content parts rather than a summary — that is the
          // thinking channel too. (Tool-call steps reach the tool panel through
          // the generic tool_calls loop below, for every event name.)
          const stepType = typeof data.step?.type === 'string' ? data.step.type.toLowerCase() : '';
          if (!data.step?.summary && (stepType === 'thought' || stepType === 'thought_summary')) {
            const stepThought = extractContentText(data.step?.content);
            if (stepThought && stepThought !== lastThought) {
              lastThought = stepThought;
              emit.thinking(stepThought);
            }
          }

          if (data.delta) {
            if (data.delta.type === 'thought_summary') {
              // Live reasoning deltas: the text lives in a Content object
              // (parts[]), not under a `text` key.
              const thought =
                extractContentText(data.delta.content) ||
                (typeof data.delta.text === 'string' ? data.delta.text : '');
              if (thought && thought !== lastThought) {
                lastThought = thought;
                emit.thinking(thought);
              }
            } else {
              const direct = typeof data.delta.text === 'string' ? data.delta.text : '';
              // Newer wire shape for answer text: { type: 'text', content: … }
              // with no top-level `text` key.
              const answer =
                direct || (data.delta.type === 'text' ? extractContentText(data.delta.content) : '');
              if (answer) {
                streamed += answer;
                emit.text(answer);
              }
            }
            // A few agent APIs stream reasoning under a sibling key of `text`.
            // Only these known names are forwarded — anything else is metadata
            // (a stray `type: "text"` once leaked into the Thinking panel).
            for (const key of ['reasoning', 'thinking', 'thought', 'reasoning_text']) {
              const value = data.delta[key];
              if (typeof value === 'string' && value) emit.thinking(value);
            }
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
          headers: { 'x-goog-api-key': this.apiKey },
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

/** A 429 the engine can wait out: carries the stored interaction to resume. */
export interface ResumableRateLimit extends EngineError {
  interactionId?: string;
}

/** True when the failure is a waitable rate limit rather than a fatal error. */
export function asResumableRateLimit(err: unknown): ResumableRateLimit | null {
  if (err instanceof EngineError && err.errorType === 'rate_limited' && err.retryable) {
    return err as ResumableRateLimit;
  }
  return null;
}

/**
 * An error frame is usually fatal — except a 429, which just means the
 * free-tier TPM window is full. Those are waited out and resumed, so the
 * mission survives them; everything else throws as before. A per-day quota
 * message classifies as quota_exhausted (not retryable) and still fails fast.
 */
export function rateLimitOrUpstream(
  error: { message?: string; code?: number | string },
  interactionId: string | undefined,
): EngineError {
  const message = error.message ?? 'unknown upstream error';
  const code = typeof error.code === 'string' ? Number(error.code) : error.code;
  if (code === 429 || /rate.?limit|429|resource.?exhausted|quota.?exceeded/i.test(message)) {
    const err = classify(429, message) as ResumableRateLimit;
    err.interactionId = interactionId;
    return err;
  }
  return new EngineError(message, 'upstream_error', false);
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

/**
 * Pull text out of a Content object: { parts: [{ text }] }. The Interactions
 * API wraps thought_summary and text deltas this way; parts may also be plain
 * strings. Anything else yields '' — a shape we do not recognise is skipped,
 * not crashed on.
 */
export function extractContentText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      out += part;
    } else if (part && typeof (part as { text?: unknown }).text === 'string') {
      out += (part as { text: string }).text;
    }
  }
  return out;
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
    // .html is here so a website build lands in the artifact record — the UI
    // can only preview what the record knows about.
    if (typeof value === 'string' && /\.(apk|zip|tar|tar\.gz|aab|ipa|html?)$/i.test(value)) return value;
  }
  return null;
}
