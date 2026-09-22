/**
 * Run executor — turns an engine's output into a durable, replayable stream.
 *
 * The resilience rules of this project all land here, in one place:
 *
 *   NOTHING IS LOST TO A DROPPED CONNECTION
 *     The browser is not in the loop. A run keeps going whether or not anyone
 *     is watching; every durable event goes to Postgres before it goes on the
 *     wire. A client that reconnects replays from where it stopped.
 *
 *   TERMINAL EVENTS CANNOT RACE THE FINAL TEXT
 *     Field snapshots are flushed and awaited *before* the run is closed, and
 *     the close itself is one transaction that appends `run.completed` before
 *     the status changes. So "status is terminal" implies "the whole log is
 *     readable", which is what lets the SSE handler end a finished stream
 *     without guessing.
 *
 *   TWO VIEWS OF THE STREAM, ONE TRUTH
 *     Transient `*.delta` events (no sequence number, never stored) make tokens
 *     appear instantly. Durable `*.snapshot` events carry the *full* text so
 *     far, not a delta — so replay is idempotent and a lost delta costs
 *     nothing. Deltas are decoration; snapshots are the record.
 *
 *   A FAILED DB WRITE DOES NOT KILL THE MISSION
 *     Event persistence is best effort. If Postgres blinks, the run continues
 *     and the failure is logged; the client falls back to the next snapshot.
 */
import type { Db } from './db.js';
import type { EventBus } from './events.js';
import { EngineAbortedError, type Engine, type EngineContext, type LogLevel } from './engine/types.js';
import { emitEvent, finishRun, setRunStatus, buildHistoryBlock, type Run, type TerminalStatus } from './runs.js';
import { applyMemory, extractAndStoreMemories, sourceForKind, type MemoryProfile } from './memory.js';
import { recordArtifact } from './artifacts.js';
import { parseMilestone, withPlanning } from './planning.js';

/** How often the full text so far is written to Postgres while streaming. */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 750;

/**
 * Which profile fields the memory block actually carried.
 *
 * Recorded on the `memory.recall` event so "why did it answer like that?" has a
 * visible answer. `updatedAt` is bookkeeping and is left out.
 */
function profileFieldsUsed(profile: MemoryProfile): string[] {
  const fields: Array<[string, unknown]> = [
    ['name', profile.name],
    ['role', profile.role],
    ['preferredLanguage', profile.preferredLanguage],
    ['preferredFrameworks', profile.preferredFrameworks],
    ['environment', profile.environment],
    ['customDirectives', profile.customDirectives],
  ];

  return fields
    .filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0,
    )
    .map(([field]) => field);
}

export interface ExecutorDeps {
  db: Db;
  bus: EventBus;
  engine: Engine;
  snapshotIntervalMs?: number;
  /**
   * Called once a run reaches a terminal state, after it is fully recorded.
   * Fire-and-forget by contract: it must never throw into the run, and the
   * executor guards that anyway. Used for the WhatsApp "done" ping.
   */
  onTerminal?: (run: Run, outcome: TerminalStatus) => void;
}

/**
 * Serialises durable writes so that the order events were *raised* is the order
 * they receive sequence numbers.
 *
 * Without this, two concurrent inserts can be numbered out of order and a
 * replayed stream shows a step's result before the step itself. Durable events
 * are low frequency, so a queue costs nothing and removes the whole class of
 * bug.
 */
class DurableWriter {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly runId: string,
    private readonly onError: (err: Error) => void,
  ) {}

  /** Never rejects: a persistence failure must not abort the mission. */
  write(type: string, payload: Record<string, unknown>): Promise<void> {
    const next = this.chain
      .then(async () => {
        const seq = await emitEvent(this.db, this.runId, type, payload);
        this.bus.publish(this.runId, { seq, type, payload });
      })
      .catch((err: Error) => {
        this.onError(err);
      });
    this.chain = next;
    return next;
  }

  /** Resolves once every queued write has settled. */
  idle(): Promise<void> {
    return this.chain;
  }
}

/**
 * Accumulates a streaming field and writes the complete value at a bounded rate.
 *
 * Snapshots are full text rather than deltas, so writes are throttled by time
 * instead of by chunk: a fast stream produces no more database load than a slow
 * one, which matters when the free tier counts every query and the database is
 * on the other side of the internet.
 *
 * Only one write is ever in flight, which guarantees the visible text can only
 * move forward even if the network reorders responses.
 */
class FieldBuffer {
  private value = '';
  private flushedValue = '';
  private dirty = false;
  private inFlight: Promise<void> | null = null;
  private lastFlushAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly persist: (text: string) => Promise<void>,
  ) {}

  get text(): string {
    return this.value;
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.value += chunk;
    this.dirty = true;
    this.maybeFlush(false);
  }

  private maybeFlush(force: boolean): void {
    if (this.inFlight || !this.dirty) return;
    if (!force && Date.now() - this.lastFlushAt < this.intervalMs) return;

    this.dirty = false;
    this.lastFlushAt = Date.now();
    const snapshot = this.value;

    const pending = this.persist(snapshot)
      .then(() => {
        this.flushedValue = snapshot;
      })
      .catch(() => {
        // Try again on the next tick: the text is still in memory.
        this.dirty = true;
      })
      .finally(() => {
        if (this.inFlight === pending) this.inFlight = null;
      });

    this.inFlight = pending;
  }

  /** Write whatever remains. Bounded so a dead database cannot hang shutdown. */
  async final(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.inFlight && this.value === this.flushedValue) return;
      if (!this.inFlight) {
        this.dirty = true;
        this.maybeFlush(true);
      }
      if (this.inFlight) await this.inFlight;
    }
  }
}

export class RunExecutor {
  private readonly active = new Map<string, AbortController>();
  private readonly snapshotIntervalMs: number;

  constructor(private readonly deps: ExecutorDeps) {
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Begin a run. Returns immediately — the promise is deliberately not exposed,
   * because a run outlives the HTTP request that created it.
   */
  start(run: Run): void {
    void this.execute(run).catch((err: Error) => {
      // execute() handles every expected failure itself; reaching here means a
      // bug. Log it loudly but never crash the process: on Render a crash takes
      // the whole service down, and a lost mission is better than a lost server.
      console.error(`[executor] unexpected failure for ${run.id}:`, err.stack ?? err.message);
    });
  }

  /** @returns true if a live run was aborted. */
  cancel(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Abort everything in flight (shutdown). Resolves when the map is clear. */
  async shutdown(timeoutMs = 8_000): Promise<void> {
    if (this.active.size === 0) return;
    const ids = [...this.active.keys()];
    console.log(`[executor] aborting ${ids.length} run(s) for shutdown`);
    for (const controller of this.active.values()) controller.abort();

    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.active.size > 0) {
      console.warn(`[executor] ${this.active.size} run(s) did not settle before shutdown`);
    }
  }

  private async execute(run: Run): Promise<void> {
    const { bus, engine } = this.deps;
    const controller = new AbortController();
    this.active.set(run.id, controller);

    const writer = new DurableWriter(this.deps.db, bus, run.id, (err) => {
      console.error(`[executor] event write failed for ${run.id}:`, err.message);
    });

    try {
      await setRunStatus(this.deps.db, run.id, 'running');

      // Cross-session memory, recalled before the engine sees the prompt. The
      // stored prompt stays exactly what the operator wrote — the memory block
      // exists only on the wire to the model, so history and search never show
      // a mission that "said" things the operator did not type.
      //
      // Same wire-only trick for conversation awareness: the recent turns of
      // this conversation ride along, so a follow-up ("make it shorter")
      // arrives knowing what "it" was. A first message has no history, so
      // nothing changes for it.
      const history = await buildHistoryBlock(this.deps.db, run.conversationId, run.id);
      const memory = await applyMemory(
        this.deps.db,
        history ? `${history}\n\n${run.prompt}` : run.prompt,
      );

      await writer.write('run.started', {
        kind: run.kind,
        engine: engine.name,
        prompt: run.prompt,
        conversationId: run.conversationId,
      });

      if (memory.applied) {
        await writer.write('memory.recall', {
          recalled: memory.recalled.length,
          ids: memory.recalled.map((item) => item.id),
          profileFields: profileFieldsUsed(memory.profile),
        });
      }

      const text = new FieldBuffer(this.snapshotIntervalMs, (value) =>
        writer.write('text.snapshot', { text: value }),
      );
      const thinking = new FieldBuffer(this.snapshotIntervalMs, (value) =>
        writer.write('thinking.snapshot', { text: value }),
      );

      const ctx: EngineContext = {
        runId: run.id,
        signal: controller.signal,
        previousInteractionId: run.previousInteractionId,
        environmentId: run.environmentId,

        text: (chunk) => {
          text.append(chunk);
          // Straight to the browser, never stored: the snapshot is the record.
          bus.publishTransient(run.id, 'text.delta', { chunk });
        },

        thinking: (chunk) => {
          thinking.append(chunk);
          bus.publishTransient(run.id, 'thinking.delta', { chunk });
        },

        tool: (name, args) => {
          void writer.write('tool.call', { name, args: args ?? {} });
        },

        toolResult: (name, result) => {
          void writer.write('tool.result', { name, result: result ?? {} });
        },

        log: (message, level: LogLevel = 'info') => {
          void writer.write('log', { message, level });
          // A progress line in the planning protocol becomes a durable
          // milestone the PWA renders as a checklist. Anything else is just a
          // log line, as before.
          const milestone = parseMilestone(message);
          if (milestone) {
            void writer.write('plan.milestone', { ...milestone });
          }
        },

        /**
         * A produced file. The row is written first so the durable event can
         * carry its id — that is what lets the client offer a download link
         * straight from the live stream instead of re-reading the whole run.
         */
        artifact: (filePath: string) => {
          void recordArtifact(this.deps.db, run.id, filePath)
            .then((artifact) => {
              if (!artifact) return;
              return writer.write('artifact', {
                id: artifact.id,
                name: artifact.name,
                path: artifact.path,
                mime: artifact.mime,
              });
            })
            .catch((err: Error) => {
              console.warn(`[executor] artifact record failed for ${run.id}:`, err.message);
            });
        },
      };

      let result;
      try {
        // The planning contract rides on the wire only: the stored prompt
        // stays exactly what the operator wrote, and simple questions never
        // see the preamble.
        result = await engine.run(withPlanning(memory.prompt), ctx);
      } finally {
        // Runs even on failure: whatever the engine produced is still worth
        // keeping, and the closing event must not overtake it.
        await text.final();
        await thinking.final();
        await writer.idle();
      }

      // A cancelled run is cancelled even if the engine returned normally.
      if (controller.signal.aborted) {
        await this.settle(run, 'cancelled', text.text, null, null);
        return;
      }

      // The engine's final answer beats the streamed deltas. Deltas can miss
      // their tail if the upstream stream is cut, and some engines only produce
      // the complete text at the end. Whichever is longer is the better record,
      // and the `final: true` snapshot below overwrites what the client drew.
      const streamed = text.text;
      const authoritative = result.text ?? '';
      const finalText = authoritative.length >= streamed.length ? authoritative : streamed;
      await writer.write('text.snapshot', { text: finalText, final: true });
      await writer.write('run.environment', {
        interactionId: result.interactionId ?? null,
        environmentId: result.environmentId ?? null,
      });
      const seq = await finishRun(this.deps.db, run.id, {
        status: 'completed',
        text: finalText,
        tokensIn: result.tokensIn ?? null,
        tokensOut: result.tokensOut ?? null,
        // Stored so a follow-up message resumes this sandbox instead of
        // starting a new one and losing the agent's workspace.
        interactionId: result.interactionId ?? null,
        environmentId: result.environmentId ?? null,
      });
      bus.publish(run.id, { seq, type: 'run.completed', payload: { status: 'completed' } });
      this.afterTerminal(run, 'completed');
      console.log(
        `[run] ${run.id} completed (${finalText.length} chars, ${thinking.text.length} chars thinking)`,
      );
    } catch (err) {
      const error = err as Error & { errorType?: string };
      const aborted = controller.signal.aborted || error instanceof EngineAbortedError;
      const status = aborted ? 'cancelled' : 'failed';
      // Engines label their own failures so the run records something the
      // operator can act on (quota_exceeded vs auth_failed vs engine_error)
      // rather than a bare stack-trace-shaped string.
      const type = aborted ? null : error.errorType ?? (error.name === 'Error' ? 'engine_error' : error.name);
      await this.settle(
        run,
        status,
        await this.snapshotOf(run.id),
        type,
        aborted ? null : error.message,
      );
    } finally {
      // Learning happens after the run is settled, on purpose: extraction can
      // never delay a mission or fail one. It reads the operator's own words,
      // so a cancelled mission teaches the same things a completed one does.
      void extractAndStoreMemories(this.deps.db, run.prompt, sourceForKind(run.kind));
      this.active.delete(run.id);
    }
  }

  /**
   * A hook that runs after a terminal state is fully recorded. Wrapped so a
   * buggy listener can log loudly but never take the executor down with it.
   */
  private afterTerminal(run: Run, outcome: TerminalStatus): void {
    const hook = this.deps.onTerminal;
    if (!hook) return;
    try {
      hook(run, outcome);
    } catch (err) {
      console.error(`[executor] onTerminal hook failed for ${run.id}:`, (err as Error).message);
    }
  }

  /**
   * Close a run after a failure or cancellation.
   *
   * The partial text is recovered from the database rather than memory: the
   * catch block can be reached from anywhere, and the last persisted snapshot
   * is guaranteed to exist while an in-memory copy may not.
   */
  private async settle(
    run: Run,
    status: 'failed' | 'cancelled',
    inMemoryText: string,
    errorType: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    const runId = run.id;
    const text = inMemoryText || (await this.snapshotOf(runId));
    try {
      const seq = await finishRun(this.deps.db, runId, {
        status,
        text,
        errorType,
        errorMessage,
      });
      this.deps.bus.publish(runId, { seq, type: `run.${status}`, payload: { status, errorType } });
      this.afterTerminal(run, status);
      console.log(`[run] ${runId} ${status}${errorMessage ? `: ${errorMessage}` : ''}`);
    } catch (err) {
      console.error(`[run] ${runId} could not be closed as ${status}:`, (err as Error).message);
    }
  }

  /** Best-effort read of the last persisted text snapshot. */
  private async snapshotOf(runId: string): Promise<string> {
    try {
      const rows = await this.deps.db.query<{ text: string | null }>(
        `SELECT payload->>'text' AS text FROM run_events
          WHERE run_id = $1 AND type = 'text.snapshot'
          ORDER BY seq DESC LIMIT 1`,
        [runId],
      );
      return rows[0]?.text ?? '';
    } catch {
      return '';
    }
  }
}
