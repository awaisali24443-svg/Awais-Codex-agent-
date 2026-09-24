/**
 * Scripted engine — a real engine that spends nothing.
 *
 * It exists for three reasons:
 *   1. the whole pipeline (executor, event log, SSE, cancel, reconnect) can be
 *      tested end to end without consuming a single one of the ~100 daily runs
 *   2. the UI can be built and demonstrated on wifi without touching the quota
 *   3. it is the reference implementation of EngineContext, so the real
 *      Antigravity engine has a worked example to match
 *
 * It is not a stub and not a mock: it streams, it takes time, it yields to the
 * event loop, and it honours cancellation exactly like a network engine does.
 */
import { EngineAbortedError, type Engine, type EngineContext, type EngineResult } from './types.js';

export interface ScriptStep {
  /** Pause before this step runs. */
  delayMs?: number;
  /** Text appended to the visible answer. */
  text?: string;
  /** Text appended to the reasoning trace. */
  thinking?: string;
  /** Start of a named step. */
  tool?: string;
  toolArgs?: unknown;
  /** Result of the step named by the most recent `tool`. */
  toolResult?: unknown;
  log?: string;
  logLevel?: 'info' | 'warn' | 'error';
  /** A file this step produced, e.g. a built `.apk`. */
  artifact?: string;
  /** Make the run fail at this point, with this message. */
  fail?: string;
  errorType?: string;
}

export interface ScriptedEngineOptions {
  steps?: ScriptStep[];
  /** Multiplier applied to every step delay. Tests pass 0. */
  speed?: number;
}

const DEFAULT_SCRIPT: ScriptStep[] = [
  { log: 'Task received', delayMs: 120 },
  { thinking: 'Reading the request and deciding what actually needs doing.', delayMs: 200 },
  { thinking: ' Checking what already exists in the project.', delayMs: 160 },
  { tool: 'read_project', toolArgs: { path: '.' }, delayMs: 180 },
  { toolResult: { files: 42, entry: 'server/main.ts' }, delayMs: 120 },
  { log: 'Project scanned', logLevel: 'info' },
  {
    text: 'This is the scripted engine.\n\n',
    delayMs: 150,
  },
  {
    text: 'The pipeline around me is real: this text is being written to Postgres, ',
    delayMs: 90,
  },
  {
    text: 'pushed through the event bus, and delivered to your browser over SSE. ',
    delayMs: 90,
  },
  {
    text: 'Close the tab mid-task and reopen it — the stream replays from the last ',
    delayMs: 90,
  },
  {
    text: 'event you acknowledged, so nothing is lost.\n\n',
    delayMs: 90,
  },
  {
    text: 'The real Antigravity engine replaces this by implementing the same interface. ',
    delayMs: 110,
  },
  { text: 'Nothing above it changes.', delayMs: 90 },
  { log: 'Task complete', logLevel: 'info', delayMs: 100 },
];

export class ScriptedEngine implements Engine {
  readonly name = 'scripted';

  private readonly steps: ScriptStep[];
  private readonly speed: number;

  constructor(options: ScriptedEngineOptions = {}) {
    this.steps = options.steps ?? DEFAULT_SCRIPT;
    this.speed = options.speed ?? 1;
  }

  async run(prompt: string, ctx: EngineContext): Promise<EngineResult> {
    let text = '';
    let lastTool = 'unknown';

    ctx.log(`Scripted engine start (${this.steps.length} steps)`);
    if (prompt.trim()) ctx.thinking(`Prompt is ${prompt.trim().length} characters. `);

    for (const step of this.steps) {
      if (ctx.signal.aborted) throw new EngineAbortedError();

      const delay = (step.delayMs ?? 0) * this.speed;
      if (delay > 0) await this.sleep(delay, ctx.signal);

      // Re-check after the wait: abort during a sleep must not produce output.
      if (ctx.signal.aborted) throw new EngineAbortedError();

      if (step.fail) throw new Error(step.fail);
      if (step.log) ctx.log(step.log, step.logLevel);
      if (step.tool) {
        lastTool = step.tool;
        ctx.tool(step.tool, step.toolArgs);
      }
      if (step.toolResult !== undefined) ctx.toolResult(lastTool, step.toolResult);
      // Scripted missions can produce artifacts too, which is what lets the
      // record → download path be tested without a real sandbox.
      if (step.artifact) ctx.artifact?.(step.artifact);
      if (step.thinking) ctx.thinking(step.thinking);
      if (step.text) {
        text += step.text;
        ctx.text(step.text);
      }
    }

    return {
      text,
      interactionId: `scripted_${ctx.runId}`,
      tokensIn: Math.ceil(prompt.length / 4),
      tokensOut: Math.ceil(text.length / 4),
    };
  }

  /** Abort-aware sleep: resolves early when cancelled so cancel feels instant. */
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
      const onAbort = () => {
        clearTimeout(timer);
        reject(new EngineAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
