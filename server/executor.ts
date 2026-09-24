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
import type { SecretsStore } from './settings.js';
import { EngineAbortedError, EngineError, type Engine, type EngineContext, type EngineResult, type LogLevel } from './engine/types.js';
import { emitEvent, finishRun, getRun, setRunStatus, TERMINAL_STATUSES, buildHistoryBlock, type PlanStep, type Run, type TerminalStatus } from './runs.js';
import { applyMemory, extractAndStoreMemories, sourceForKind, type MemoryProfile } from './memory.js';
import { recordArtifact } from './artifacts.js';
import { parseMilestone, withGoogle, withLinkedIn, withPlanning, planOnlyPrompt, buildPlanPreamble } from './planning.js';
import { withDesignGuide } from './design.js';
import { MAX_SEEN_URLS, extractUrls, checkSources, searchQueryOf, urlsIn } from './sources.js';
import { extractLinkedInDraft, recordLinkedInDraft } from './linkedin.js';
import { maybeAskDraftApproval } from './whatsapp/approvals.js';
import {
  executeGoogleRead,
  extractGoogleReadRequests,
  loadGoogleToken,
  type GoogleReadRequest,
  type GoogleReadResult,
} from './google.js';
import {
  buildResumePreamble,
  recordMissionStep,
} from './mission_steps.js';
import {
  verifyMission,
  verificationPassed,
  type VerificationCheck,
} from './mission_verify.js';

/** How often the full text so far is written to Postgres while streaming. */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 750;

/**
 * Deep-research mode: one logical mission, several engine passes, one
 * wall-clock budget. The engine already waits out TPM rate limits patiently
 * inside each pass — the executor only decides when to send the next pass and
 * when to ask for the final report. No retry logic around the engine: a pass
 * that throws is a failed run, exactly like a one-shot mission.
 */
const MAX_RESEARCH_PASSES = 8;
/** The last pass inside this window is spent synthesising, not digging. */
const FINAL_SYNTHESIS_MS = 3 * 60_000;

/**
 * Google reads: the engine requests Gmail/Calendar data with fenced blocks;
 * the server runs them (read-only, sealed token) and feeds the results back
 * in follow-up passes. Capped rounds, so a chatty mission cannot loop on
 * reads and burn the token budget.
 */
const MAX_GOOGLE_READ_ROUNDS = 3;
const MAX_GOOGLE_READS_PER_ROUND = 5;

function deepResearchFirstPrompt(mission: string, budgetMinutes: number): string {
  return (
    `[Deep-research mode — up to ${budgetMinutes} minutes of wall-clock time. ` +
    `I will send follow-up passes until the budget is spent, then ask for the final report.]\n\n` +
    `Work this task exhaustively, in depth:\n` +
    `- explore broadly first, then drill into the most promising leads\n` +
    `- verify key claims against independent sources before asserting them\n` +
    `- prefer primary sources over summaries; mark where evidence is thin\n` +
    `- keep a running record of findings, sources and open questions — each follow-up pass ` +
    `continues this same task and builds on your notes\n\n` +
    `Do NOT write the final report yet. End this pass with: (1) what you found, ` +
    `(2) what is still unverified, (3) where you would dig next.\n\n` +
    `Task:\n${mission}`
  );
}

function researchContinuationPrompt(pass: number, remainingMinutes: number): string {
  return (
    `[Deep-research, pass ${pass} — about ${remainingMinutes} minute(s) left. ` +
    `This is the SAME task: you still have your notes, findings and sandbox from the earlier passes.]\n\n` +
    `Build on your prior findings — do NOT repeat research you already did or re-verify settled claims.\n` +
    `Go deeper and wider: verify the uncertain claims with independent sources, ` +
    `chase the most promising open leads, expand thin sections, close contradictions.\n\n` +
    `End this pass with: (1) new findings, (2) still-open questions, ` +
    `(3) where to dig next if time allows. Do NOT write the final report yet.`
  );
}

function researchSynthesisPrompt(remainingMinutes: number): string {
  return (
    `[Deep-research, final pass — about ${remainingMinutes} minute(s) left. No more digging after this.]\n\n` +
    `Write the final synthesized report now:\n` +
    `- the question and the bottom-line answer up front\n` +
    `- findings organised by theme with clear headings\n` +
    `- every factual claim carries its source as an inline link [label](url); a claim without a verifiable URL is marked uncertain, never stated as fact\n` +
    `- confidence on key claims: verified / single-source / uncertain\n` +
    `- a Sources section listing every URL you cite, then open questions and recommended next steps`
  );
}

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
  /**
   * Enables the Google read capability (Gmail/Calendar). Optional so tests
   * can construct the executor without credentials; when absent the
   * capability is simply off and missions run exactly as before.
   */
  masterKey?: string;
  secrets?: SecretsStore;
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
      // Last resort: execute() rejected before its own try/catch could settle
      // the run, so nothing else will close it — fail it here or it holds the
      // single-active slot forever. Only a run that never reached a terminal
      // state is touched; one execute() already settled is left exactly alone.
      void (async () => {
        try {
          const current = await getRun(this.deps.db, run.id);
          if (current && !TERMINAL_STATUSES.includes(current.status)) {
            await setRunStatus(this.deps.db, run.id, 'failed', {
              errorType: 'executor_crashed',
              errorMessage: (err.message ?? 'executor failed before the run settled').slice(0, 500),
            });
          }
        } catch {
          // Best effort — the original failure is already logged loudly above.
        }
      })();
    });
  }

  /** @returns true if a live run was aborted. */
  cancel(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * The planning pass: one short engine call that asks for the plan and
   * nothing else.
   *
   * The run is NOT started — no status change, no `run.started` event; the
   * caller decides what to do with the steps. Milestones are collected from
   * the same "Step k/N" protocol the executor already parses, so a plan the
   * engine announces here lands on the same checklist shape it will tick off
   * during execution.
   *
   * A plan that never arrives (timeout, empty answer, engine error) is an
   * empty list, and the caller falls back to normal execution rather than
   * stranding the mission in a waiting state with nothing to show.
   */
  async planMission(run: Run): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];
    const controller = new AbortController();
    // A plan is a short answer. If the engine is still talking after a
    // minute it has misunderstood "plan only" — stop paying for it.
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const ctx: EngineContext = {
        runId: run.id,
        signal: controller.signal,
        previousInteractionId: null,
        environmentId: null,
        text: () => {},
        thinking: () => {},
        tool: () => {},
        toolResult: () => {},
        log: (message) => {
          const milestone = parseMilestone(message);
          if (milestone) {
            steps.push({ index: milestone.index, total: milestone.total, label: milestone.label });
          }
        },
      };
      await this.deps.engine.run(planOnlyPrompt(run.prompt), ctx);
    } catch (err) {
      console.warn(`[run] ${run.id} planning pass failed:`, (err as Error).message);
    } finally {
      clearTimeout(timeout);
    }
    // Normalise: first label announced wins per index, ordered 1..N, with a
    // single total so the checklist renders as one plan.
    const seen = new Map<number, PlanStep>();
    for (const s of steps) if (!seen.has(s.index)) seen.set(s.index, s);
    const announced = [...seen.values()].map((s) => s.total);
    const total = announced.length ? Math.max(...announced) : 0;
    return [...seen.values()]
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ index: s.index, total: total || seen.size, label: s.label }));
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

    /* Where this run has looked, as it looks: deduped, bounded, and durable so
       a reconnect rebuilds the same rail. Kept next to the writer because it
       describes what the writer is about to announce. */
    const seenSources = new Set<string>();
    let seenSourceEvents = 0;
    const noteSource = (payload: { kind: 'site' | 'search'; url?: string; query?: string; via?: string }): void => {
      const key = payload.url ?? `${payload.kind}:${payload.query ?? ''}`;
      if (!key || seenSources.has(key)) return;
      if (seenSourceEvents >= MAX_SEEN_URLS) return;
      seenSources.add(key);
      seenSourceEvents += 1;
      void writer.write('sources.seen', payload);
    };

    const writer = new DurableWriter(this.deps.db, bus, run.id, (err) => {
      console.error(`[executor] event write failed for ${run.id}:`, err.message);
    });

    // Every milestone checkpoint is fired without awaiting (a slow database
    // must not stall the mission), but the pre-close verification below reads
    // mission_steps — so the promises are collected here and settled there,
    // closing the race between the last checkpoint and the check.
    const checkpointWrites: Array<Promise<void>> = [];

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
        deepResearch: run.deepResearch,
        researchBudgetMinutes: run.researchBudgetMinutes,
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
          // A lookup is the moment the operator most wants to see what is
          // happening, and the call itself says where it is going: the URL it
          // is opening, or the question it is asking.
          for (const url of urlsIn(args)) noteSource({ kind: 'site', url, via: name });
          const query = searchQueryOf(name, args);
          if (query) noteSource({ kind: 'search', query, via: name });
        },

        toolResult: (name, result) => {
          void writer.write('tool.result', { name, result: result ?? {} });
        },

        log: (message, level: LogLevel = 'info') => {
          void writer.write('log', { message, level });
          // The agent's own narration often names the page it is reading
          // before any tool call arrives; those URLs belong on the rail too.
          for (const url of urlsIn(message, 2)) noteSource({ kind: 'site', url, via: 'reading' });
          // A progress line in the planning protocol becomes a durable
          // milestone the PWA renders as a checklist. Anything else is just a
          // log line, as before. Milestones are also checkpointed to
          // mission_steps, so a crash mid-mission loses nothing finished.
          const milestone = parseMilestone(message);
          if (milestone) {
            void writer.write('plan.milestone', { ...milestone });
            checkpointWrites.push(
              recordMissionStep(this.deps.db, run.id, milestone).catch((err: Error) =>
                console.warn(`[run] ${run.id} checkpoint failed:`, err.message),
              ),
            );
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
        // A resumed mission carries its finished steps on the wire, so the
        // engine continues from the first unfinished step instead of redoing
        // the mission. The stored prompt is untouched — this is wire-only.
        const resumePreamble =
          run.resumeFromStep != null
            ? await buildResumePreamble(this.deps.db, run.id, run.resumeFromStep).catch(
                (err: Error) => {
                  console.warn(`[run] ${run.id} resume preamble failed:`, err.message);
                  return '';
                },
              )
            : '';
        // The operator approved this plan before execution started. It rides
        // on the wire so the engine follows the approved steps instead of
        // re-planning; the stored prompt is untouched.
        const planPreamble = run.plan?.length ? buildPlanPreamble(run.plan) : '';
        // Google reads ride on the wire only when the account is actually
        // connected — otherwise the contract would promise reads the server
        // cannot perform and burn a pass finding that out.
        const googleConnected = await this.googleConnected();
        const mission =
          resumePreamble +
          planPreamble +
          withGoogle(withDesignGuide(withLinkedIn(withPlanning(memory.prompt))), googleConnected);
        result =
          run.deepResearch && (run.researchBudgetMinutes ?? 0) > 0
            ? await this.runDeepResearch(run, mission, ctx, controller, writer, text, thinking)
            : await this.runWithGoogleReads(
                run,
                mission,
                ctx,
                controller,
                writer,
                text,
                thinking,
                googleConnected,
              );
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
      // Source check before the run closes: every URL in the final text is
      // fetched (HEAD, short timeout, capped concurrency) and the verdict is
      // recorded as an event, so the UI can show "3 links dead" instead of
      // shipping unverified citations. Never rejects and never fails the run;
      // it only delays "done" by the checks themselves.
      const sourceChecks = await checkSources(extractUrls(finalText));
      if (sourceChecks.length > 0) {
        await writer.write('sources.checked', {
          checked: sourceChecks.length,
          alive: sourceChecks.filter((s) => s.ok).length,
          dead: sourceChecks.filter((s) => !s.ok).map((s) => s.url),
        });
      }
      await writer.write('run.environment', {
        interactionId: result.interactionId ?? null,
        environmentId: result.environmentId ?? null,
        // Whether this run inherited the workspace or was handed a new one. The
        // client renders that sentence; the id itself is a 32-character hex
        // string that means nothing to the operator and reads like a bug.
        continued: run.previousInteractionId !== null,
      });
      // Prove-it's-done: re-check the output against the durable record
      // before the run is marked done. Deterministic only — no engine calls,
      // so verification can never blow the token budget. A run whose checks
      // fail is failed, never silently marked done.
      //
      // Settle the milestone checkpoints first: they are fired without
      // awaiting during the mission, and the checks below read the same
      // table — verifying before the last checkpoint lands would check
      // stale state.
      await Promise.allSettled(checkpointWrites);
      const checks = await verifyMission(this.deps.db, run.id, finalText).catch(
        (err: Error) => {
          // A verifier that throws must not take the mission down: degrade
          // to "skipped" and log it loudly.
          console.error(`[run] ${run.id} verification errored:`, err.message);
          return [] as VerificationCheck[];
        },
      );
      const verification: VerificationCheck[] | null = checks.length > 0 ? checks : null;
      if (verification) {
        await writer.write('verification.checked', {
          checked: verification.length,
          passed: verification.filter((c) => c.passed).length,
          failed: verification.filter((c) => !c.passed).map((c) => c.name),
        });
      }
      if (verification && !verificationPassed(verification)) {
        const failed = verification.filter((c) => !c.passed);
        await this.settle(
          run,
          'failed',
          finalText,
          'verification_failed',
          `The agent said it was done, but the checks failed: ${failed
            .map((c) => `${c.name} — ${c.evidence}`)
            .join('; ')}.`,
          verification,
        );
        return;
      }
      const seq = await finishRun(this.deps.db, run.id, {
        status: 'completed',
        text: finalText,
        tokensIn: result.tokensIn ?? null,
        tokensOut: result.tokensOut ?? null,
        // Stored so a follow-up message resumes this sandbox instead of
        // starting a new one and losing the agent's workspace.
        interactionId: result.interactionId ?? null,
        environmentId: result.environmentId ?? null,
        verification,
      });
      // LinkedIn drafts: the agent may end a "post this on LinkedIn" mission
      // with a fenced draft. Best-effort, like memory extraction below — a
      // draft that fails to file must never fail the run.
      const linkedInDraft = await recordLinkedInDraft(this.deps.db, run.id, finalText).catch(
        (err: Error) => {
          console.warn(`[linkedin] draft record failed for ${run.id}:`, err.message);
          return null;
        },
      );
      // One WhatsApp ask to review the draft (YES / NO / CHANGE) — the same
      // one-ask, silent-without-token contract as the plan ask. Never throws.
      if (linkedInDraft && this.deps.secrets) {
        const draftText = extractLinkedInDraft(finalText);
        if (draftText) {
          void maybeAskDraftApproval(
            { db: this.deps.db, secrets: this.deps.secrets },
            linkedInDraft,
            draftText,
          );
        }
      }
      bus.publish(run.id, {
        seq,
        type: 'run.completed',
        payload: {
          status: 'completed',
          linkedInDraft: linkedInDraft ?? null,
          verification,
          // What the answer cost, when the engine says. The client shows it
          // under the answer the way a lab notebook shows the run conditions:
          // the operator's quota is the reason to care.
          usage: { tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null },
        },
      });
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
   * Deep-research mode: one logical mission, several engine passes, one
   * wall-clock budget.
   *
   * The first pass starts from the run's own continuation handles (so a
   * follow-up in the same conversation keeps its sandbox); every later pass
   * continues via the previous pass's interactionId/environmentId, which is
   * what keeps the agent's workspace and memory on the same mission instead
   * of starting a fresh sandbox each time. Each continuation prompt tells the
   * agent to build on prior findings, never repeat them, so the budget is not
   * burned on duplicates.
   *
   * The engine's patient 429 handling stretches wall-clock inside a pass —
   * that is expected and absorbed; the deadline is only checked between
   * passes. No retry logic around the engine: a throwing pass fails the run
   * exactly like a one-shot mission.
   *
   * Everything lands in the same text/thinking buffers, so the run's event
   * log, stream and final message read as one mission, not N runs.
   */
  private async runDeepResearch(
    run: Run,
    mission: string,
    ctx: EngineContext,
    controller: AbortController,
    writer: DurableWriter,
    text: FieldBuffer,
    thinking: FieldBuffer,
  ): Promise<EngineResult> {
    const engine = this.deps.engine;
    const budgetMinutes = run.researchBudgetMinutes ?? 15;
    const deadline = Date.now() + budgetMinutes * 60_000;

    // The conversation's own continuation rides on pass one; later passes
    // chain off whatever the previous pass returned.
    let previousInteractionId = run.previousInteractionId;
    let environmentId = run.environmentId;
    let result: EngineResult | null = null;

    await writer.write('research.started', {
      budgetMinutes,
      deadlineAt: new Date(deadline).toISOString(),
    });
    ctx.log(
      `Deep research: up to ${budgetMinutes} minute(s) — chaining passes until the budget is spent.`,
    );

    for (let pass = 1; pass <= MAX_RESEARCH_PASSES; pass++) {
      if (controller.signal.aborted) throw new EngineAbortedError();

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        ctx.log('Research budget spent — finalising with what was gathered.', 'warn');
        break;
      }
      const remainingMinutes = Math.max(1, Math.round(remainingMs / 60_000));
      const lastChance = pass === MAX_RESEARCH_PASSES || remainingMs <= FINAL_SYNTHESIS_MS;

      const prompt =
        pass === 1
          ? deepResearchFirstPrompt(mission, budgetMinutes)
          : lastChance
            ? researchSynthesisPrompt(remainingMinutes)
            : researchContinuationPrompt(pass, remainingMinutes);

      // A fresh context per pass carrying the continuation handles — the
      // streaming callbacks stay shared, so output keeps accumulating.
      const passCtx: EngineContext = { ...ctx, previousInteractionId, environmentId };
      await writer.write('research.pass', { pass, lastChance, remainingMinutes });
      result = await engine.run(prompt, passCtx);

      // Flush between passes: the browser and the database see each pass land
      // instead of one giant dump at the end.
      await text.final();
      await thinking.final();
      await writer.idle();

      previousInteractionId = result.interactionId ?? previousInteractionId;
      environmentId = result.environmentId ?? environmentId;

      // The continuation handles live in locals above; a crash or redeploy
      // between passes would lose them and the retry would start (and pay for)
      // a fresh sandbox. Persist them the first time each pass's id is seen —
      // a failed DB write is best effort and never fails the mission.
      await this.persistContinuation(run.id, previousInteractionId, environmentId);

      if (lastChance) break;
      // An empty pass produced nothing to build on — another pass would only
      // burn budget re-asking.
      if (!result.text.trim() && !text.text.trim()) break;
    }

    if (!result) {
      throw new EngineError('The research task produced no output.', 'truncated');
    }
    return result;
  }

  /**
   * Whether this executor can perform Google reads right now: credentials
   * wired, client configured, and a token stored. Checked once per mission,
   * before the engine ever sees the prompt.
   */
  private async googleConnected(): Promise<boolean> {
    const { masterKey, secrets } = this.deps;
    if (!masterKey || !secrets) return false;
    if (!secrets.get('google_client_id') || !secrets.get('google_client_secret')) return false;
    try {
      return (await loadGoogleToken(this.deps.db, masterKey)) !== null;
    } catch {
      return false;
    }
  }

  /** One read request, executed and logged as a `google.read` event. */
  private async runGoogleRead(
    writer: DurableWriter,
    request: GoogleReadRequest,
  ): Promise<GoogleReadResult> {
    const { db, masterKey, secrets } = this.deps;
    const outcome = await executeGoogleRead({
      db,
      masterKey: masterKey ?? '',
      clientId: secrets?.get('google_client_id') ?? '',
      clientSecret: secrets?.get('google_client_secret') ?? '',
      request,
    }).catch(
      (err: Error): GoogleReadResult => ({
        request,
        ok: false,
        summary: 'read failed',
        detail: err.message,
      }),
    );
    // The access log: what was read, not the content — the content travels
    // to the engine in the follow-up pass, and the final answer carries it.
    await writer.write('google.read', {
      kind: request.kind,
      ok: outcome.ok,
      summary: outcome.summary,
      query:
        request.kind === 'gmail-search'
          ? request.query
          : request.kind === 'calendar-list'
            ? `next ${request.days} day(s)`
            : undefined,
    });
    return outcome;
  }

  /**
   * The standard (non-deep-research) engine path with Google reads. After
   * each pass, fenced read requests in the engine's answer are executed and
   * the results fed back in a follow-up pass — at most MAX_GOOGLE_READ_ROUNDS
   * rounds, so the loop always terminates. Streaming buffers are shared across
   * passes, so a read round appends to the answer the operator already sees
   * rather than starting a second one.
   */
  private async runWithGoogleReads(
    run: Run,
    mission: string,
    ctx: EngineContext,
    controller: AbortController,
    writer: DurableWriter,
    text: FieldBuffer,
    thinking: FieldBuffer,
    googleConnected: boolean,
  ): Promise<EngineResult> {
    const engine = this.deps.engine;
    let previousInteractionId = run.previousInteractionId;
    let environmentId = run.environmentId;

    // One engine pass; returns the pass's own text (the longer of the
    // authoritative result and what this pass streamed).
    const pass = async (prompt: string): Promise<{ result: EngineResult; passText: string }> => {
      const before = text.text.length;
      const result = await engine.run(prompt, { ...ctx, previousInteractionId, environmentId });
      previousInteractionId = result.interactionId ?? previousInteractionId;
      environmentId = result.environmentId ?? environmentId;
      await this.persistContinuation(run.id, previousInteractionId, environmentId);
      const streamed = text.text.slice(before);
      const authoritative = result.text ?? '';
      return {
        result,
        passText: authoritative.length >= streamed.length ? authoritative : streamed,
      };
    };

    let { result, passText } = await pass(mission);
    if (!googleConnected) return result;

    // Requests already executed are never run twice, even if the engine
    // repeats them in a later answer.
    const seen = new Set<string>();
    for (let round = 0; round < MAX_GOOGLE_READ_ROUNDS; round++) {
      if (controller.signal.aborted) break;
      const requests = extractGoogleReadRequests(passText)
        .filter((request) => {
          const key = JSON.stringify(request);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, MAX_GOOGLE_READS_PER_ROUND);
      if (requests.length === 0) break;

      const lines: string[] = [];
      for (const request of requests) {
        const outcome = await this.runGoogleRead(writer, request);
        lines.push(
          `- ${request.kind}: ${outcome.ok ? 'OK' : 'FAILED'} — ${outcome.summary}\n${outcome.detail}`,
        );
      }
      await text.final();
      await thinking.final();
      await writer.idle();
      ctx.log(`Google reads: ${requests.length} request(s), round ${round + 1}.`);

      const followUp = await pass(
        `[Google reads — the results of your requests. Report only what is here; never invent email or calendar content.]\n` +
          lines.join('\n') +
          `\n\nContinue the task with these results. Request more reads only if you need different data.`,
      );
      result = followUp.result;
      passText = followUp.passText;
    }
    return result;
  }

  /**
   * Persist the sandbox continuation handles mid-run. The run row already
   * records them at close (finishRun); this covers the window between passes
   * of a deep-research mission, where the handles otherwise live only in
   * memory. Best effort by design: a persistence failure must not kill the
   * mission, per the header rule above.
   */
  private async persistContinuation(
    runId: string,
    interactionId: string | null | undefined,
    environmentId: string | null | undefined,
  ): Promise<void> {
    try {
      await this.deps.db.query(
        `UPDATE runs
            SET interaction_id = COALESCE($2, interaction_id),
                environment_id = COALESCE($3, environment_id)
          WHERE id = $1`,
        [runId, interactionId ?? null, environmentId ?? null],
      );
    } catch (err) {
      console.warn(`[executor] continuation persist failed for ${runId}:`, (err as Error).message);
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
    verification: VerificationCheck[] | null = null,
  ): Promise<void> {
    const runId = run.id;
    const text = inMemoryText || (await this.snapshotOf(runId));
    try {
      const seq = await finishRun(this.deps.db, runId, {
        status,
        text,
        errorType,
        errorMessage,
        verification,
      });
      this.deps.bus.publish(runId, {
        seq,
        type: `run.${status}`,
        payload: { status, errorType, verification },
      });
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
