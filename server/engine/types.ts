/**
 * The engine seam.
 *
 * Everything above this interface — the run lifecycle, the event log, the SSE
 * stream, the budget guard — is engine agnostic. Swapping the scripted engine
 * for the real Antigravity client is a one-line change in one place, and it
 * cannot accidentally change how runs are recorded.
 *
 * Engines only push output. They never touch the database, never know a run id
 * exists in a table, and never decide their own retries. That keeps the
 * "nothing is lost to a dropped connection" guarantee in a single place
 * (executor.ts) instead of spread across every provider integration.
 */

export interface EngineContext {
  readonly runId: string;
  /** Aborted when the operator cancels, or on shutdown. Engines must honour it. */
  readonly signal: AbortSignal;

  /**
   * Continuation handles. When set, the engine should resume that sandbox
   * rather than start a new one, so the agent keeps its workspace and its
   * memory of the previous mission.
   */
  readonly previousInteractionId: string | null;
  readonly environmentId: string | null;

  /** Append to the assistant's visible answer. */
  text(chunk: string): void;
  /** Append to the reasoning trace. Kept separate from the answer. */
  thinking(chunk: string): void;
  /** A tool/step the agent is starting. */
  tool(name: string, args?: unknown): void;
  /** The outcome of that step. */
  toolResult(name: string, result: unknown): void;
  /** A line in the run log, surfaced in the thinking panel. */
  log(message: string, level?: LogLevel): void;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface EngineResult {
  /** The complete answer. The executor also accumulates from `text()`. */
  text: string;
  /** Engine-side identifiers, stored on the run for continuation. */
  interactionId?: string;
  environmentId?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Engine {
  readonly name: string;
  /**
   * Produce an answer. Must not throw for ordinary failures — throw only for
   * genuine errors, and the executor will record them as `run.failed`.
   */
  run(prompt: string, ctx: EngineContext): Promise<EngineResult>;
}

/** Raised by engines when the operator cancels; recorded as `cancelled`, not `failed`. */
export class EngineAbortedError extends Error {
  constructor() {
    super('Run cancelled by operator');
    this.name = 'EngineAbortedError';
  }
}

/** Machine-readable failure kinds, stored on the run as `error_type`. */
export type EngineErrorType =
  | 'auth_failed'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'agent_unavailable'
  | 'invalid_request'
  | 'upstream_error'
  | 'network_error'
  | 'idle_timeout'
  | 'truncated';

/**
 * An engine failure that says what went wrong and whether retrying is safe.
 *
 * `retryable` is deliberately narrow. A retry re-sends the whole mission, and
 * on a ~100-run daily quota a wrong retry is a wasted run. Only 429 and 503
 * qualify, and only before the engine has produced any output — once tokens
 * have been generated, the run has been paid for and retrying would pay twice.
 */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly errorType: EngineErrorType,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
