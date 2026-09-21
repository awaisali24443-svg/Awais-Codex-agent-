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
