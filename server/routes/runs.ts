/**
 * Run routes, including the live stream.
 *
 * ## How the stream stays correct
 *
 * The hard case is a client that connects *while* a run is producing events.
 * A naive "read history, then subscribe" loses whatever lands in between. The
 * fix is to subscribe first and read second:
 *
 *   1. subscribe, buffering everything the bus publishes
 *   2. read the durable history from (Last-Event-ID, +∞)
 *   3. flush the buffer synchronously — no await between steps 2 and 3
 *   4. only now go live
 *
 * Between step 1 and step 2 there is no gap, because anything published after
 * the subscribe is buffered *and* anything published before it was persisted
 * before the history query ran. Steps 3 and 4 contain no awaits, so the bus
 * cannot deliver anything that misses both paths.
 *
 * Buffered *transient* events are dropped, not flushed. They carry no sequence
 * number and no identity, so replaying them after a snapshot would double the
 * text on screen; the next snapshot carries the complete value anyway. Deltas
 * are decoration — losing a fraction of a second of animation costs nothing,
 * losing text would not be acceptable.
 *
 * ## Why the stream can end by itself
 *
 * The executor appends the terminal event *before* flipping the run's status,
 * so observing a terminal status proves the whole log is readable. That is what
 * makes it safe to drain, send `end`, and close without racing the last event.
 * Ordered, gap-free sequences make the replay idempotent: any event the client
 * already has is skipped by `seq <= maxSeq`.
 */
import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { EventBus, StreamEvent } from '../events.js';
import type { RunExecutor } from '../executor.js';
import type { SecretsStore } from '../settings.js';
import { budgetSnapshot } from '../budget.js';
import { listArtifacts } from '../artifacts.js';
import { BUCKET_FOR_KIND, acceptRun, estimateRunCost, type AcceptResult } from '../accept.js';
import {
  TERMINAL_STATUSES,
  approveRunPlan,
  emitEvent,
  finishRun,
  getActiveRun,
  getRun,
  listConversations,
  listMessages,
  listRuns,
  latestEventSeq,
  readEvents,
  updateRunPlan,
  setShareToken,
  type RunKind,
  type RunStatus,
} from '../runs.js';
import { forkBranch, listBranches } from '../branches.js';
import { getMissionSteps, resumeFromStep } from '../mission_steps.js';
import { canShareRun, newShareToken, shareUrl } from '../share.js';

export interface RunRouteDeps {
  db: Db;
  bus: EventBus;
  executor: RunExecutor;
  config: AppConfig;
  secrets: SecretsStore;
}

const MAX_PROMPT_CHARS = 8_000;
/** Replies are truncated on the wire, never in the log. ~4 MB is ample. */
const MAX_REPLAY_EVENTS = 5_000;
/** Above this many unflushed bytes a client is too slow to receive decoration. */
const TRANSIENT_BACKPRESSURE_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;

const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** Deep-research presets: 15 minutes, 1 hour, or a custom whole-minutes budget. */
const RESEARCH_BUDGET_DEFAULT_MIN = 15;
const RESEARCH_BUDGET_MIN_MIN = 5;
const RESEARCH_BUDGET_MAX_MIN = 480;

/**
 * Parse and validate the deep-research option. Returns the budget in minutes,
 * or null when deep-research is off. Throws a plain Error with a client-safe
 * message when the budget is invalid — the caller turns it into a 400.
 */
function parseResearchBudget(body: {
  deepResearch?: unknown;
  researchBudgetMinutes?: unknown;
}): { deepResearch: boolean; researchBudgetMinutes: number | null } {
  const deepResearch = body.deepResearch === true;
  if (!deepResearch) return { deepResearch: false, researchBudgetMinutes: null };

  const raw = body.researchBudgetMinutes;
  if (raw === undefined || raw === null || raw === '') {
    return { deepResearch: true, researchBudgetMinutes: RESEARCH_BUDGET_DEFAULT_MIN };
  }
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < RESEARCH_BUDGET_MIN_MIN || minutes > RESEARCH_BUDGET_MAX_MIN) {
    throw new Error(
      `researchBudgetMinutes must be a whole number of minutes between ${RESEARCH_BUDGET_MIN_MIN} and ${RESEARCH_BUDGET_MAX_MIN}`,
    );
  }
  return { deepResearch: true, researchBudgetMinutes: minutes };
}

function sseFrame(event: StreamEvent): string {
  // `id` is omitted for transient events on purpose: Last-Event-ID must only
  // ever point at a durable position, or a reconnect would replay from a
  // sequence number that does not exist in the database.
  const lines: string[] = [];
  if (event.seq !== undefined) lines.push(`id: ${event.seq}`);
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event.payload)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Fresh connects use ?after=; EventSource's own reconnect sends Last-Event-ID. */
function resumeFrom(req: Request): number {
  const header = req.headers['last-event-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  const candidate = raw ?? req.query.after;
  const parsed = Number(Array.isArray(candidate) ? candidate[0] : candidate);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** One response shape for every route that starts a run. */
function sendAccepted(res: Response, result: AcceptResult, config: AppConfig, branchId?: string | null): void {
  if (!result.ok && result.reason === 'in_progress') {
    res.status(409).json({
      error: 'run_in_progress',
      message: `"${result.active.prompt.slice(0, 80)}" is already running`,
      activeRunId: result.active.id,
    });
    return;
  }

  if (!result.ok) {
    res.status(429).json({
      error: 'daily_budget_exceeded',
      message: result.message,
      used: result.used,
      limit: result.limit,
      resetsAt: result.resetsAt,
    });
    return;
  }

  res.status(201).json({
    run: result.run,
    branchId: branchId ?? null,
    budget: { bucket: result.bucket, remaining: result.remaining, limit: config.dailyRunBudget },
  });
}

export function createRunRoutes(deps: RunRouteDeps): Router {
  const { db, bus, executor, config, secrets } = deps;
  const router = Router();

  // ---- create a run -------------------------------------------------------

  router.post('/runs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      prompt?: unknown;
      kind?: unknown;
      conversationId?: unknown;
      branchId?: unknown;
      notifyWhatsapp?: unknown;
      deepResearch?: unknown;
      researchBudgetMinutes?: unknown;
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

    if (!prompt) {
      res.status(400).json({ error: 'prompt_required', message: 'prompt must be a non-empty string' });
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      res.status(413).json({
        error: 'prompt_too_long',
        message: `prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`,
      });
      return;
    }

    const kind: RunKind =
      body.kind === 'whatsapp' || body.kind === 'api' || body.kind === 'chat' ? body.kind : 'chat';

    let research: { deepResearch: boolean; researchBudgetMinutes: number | null };
    try {
      research = parseResearchBudget(body);
    } catch (err) {
      res.status(400).json({ error: 'invalid_research_budget', message: (err as Error).message });
      return;
    }

    // Same rules as the phone: one task at a time, one budget, one code path.
    const result = await acceptRun(
      { db, executor, config, secrets },
      {
        prompt,
        kind,
        conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
        branchId: typeof body.branchId === 'string' && body.branchId ? body.branchId : null,
        // Opt-in WhatsApp "done" ping for this run. Strictly boolean: anything
        // else is not an opt-in.
        notifyWhatsapp: body.notifyWhatsapp === true,
        deepResearch: research.deepResearch,
        researchBudgetMinutes: research.researchBudgetMinutes,
        // Optional per-mission token cap. A non-number is not a cap.
      },
    );

    sendAccepted(res, result, config);
  });

  /**
   * Pre-flight cost estimate for the composer: "≈8k tokens". Read-only —
   * estimating never spends budget and never starts anything.
   */
  router.post('/runs/estimate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { prompt?: unknown; deepResearch?: unknown; researchBudgetMinutes?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      res.status(400).json({ error: 'prompt_required' });
      return;
    }
    let research: { deepResearch: boolean; researchBudgetMinutes: number | null };
    try {
      research = parseResearchBudget(body);
    } catch (err) {
      res.status(400).json({ error: 'invalid_research_budget', message: (err as Error).message });
      return;
    }
    const estimate = await estimateRunCost(db, {
      prompt,
      deepResearch: research.deepResearch,
      researchBudgetMinutes: research.researchBudgetMinutes,
    });
    res.json(estimate);
  });

  // ---- read ---------------------------------------------------------------

  router.get('/runs', async (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 25);
    res.json({ runs: await listRuns(db, Number.isFinite(limit) ? limit : 25) });
  });

  // Declared before /runs/:id so "active" is not swallowed as an id.
  router.get('/runs/active', async (_req: Request, res: Response) => {
    const run = await getActiveRun(db);
    res.json({ run, streaming: run ? executor.isRunning(run.id) : false });
  });

  router.get('/runs/:id', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const [events, artifacts] = await Promise.all([
      readEvents(db, run.id, resumeFrom(req), MAX_REPLAY_EVENTS),
      listArtifacts(db, run.id),
    ]);
    res.json({
      run,
      events,
      streaming: executor.isRunning(run.id),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        mime: artifact.mime,
        size: artifact.size,
        downloadUrl: `/api/artifacts/${artifact.id}/download`,
      })),
    });
  });

  router.post('/runs/:id/cancel', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (isTerminal(run.status)) {
      res.json({ ok: true, alreadyFinished: true, status: run.status });
      return;
    }

    const signalled = executor.cancel(run.id);
    if (!signalled) {
      // The process that owned this run is gone (it would have been marked
      // orphaned at boot). Close it here so it stops blocking new missions,
      // and emit the terminal event exactly as the executor does — the SSE
      // stream only ends when it sees one, and setRunStatus alone would leave
      // it hanging. finishRun appends the event before flipping the status,
      // which is what makes the stream's drain-then-close safe.
      const seq = await finishRun(db, run.id, {
        status: 'cancelled',
        errorType: 'orphaned',
        errorMessage: 'Cancelled while no executor was attached',
      });
      bus.publish(run.id, {
        seq,
        type: 'run.cancelled',
        payload: { status: 'cancelled', errorType: 'orphaned' },
      });
    }
    res.json({ ok: true, signalled });
  });

  /**
   * Retry a run: same prompt, same conversation, a fresh attempt.
   *
   * Failed and completed runs qualify — a finished task is worth re-running as
   * well as a broken one. Retrying an active one would violate the
   * one-at-a-time rule, and a cancelled one is re-sent by editing the prompt
   * instead. The new run goes through the normal acceptance path, so it costs
   * one daily run like any other mission.
   */
  router.post('/runs/:id/retry', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (run.status !== 'failed' && run.status !== 'completed') {
      res.status(400).json({
        error: 'not_failed',
        message: `Only a completed or failed run can be retried (this one is ${run.status})`,
      });
      return;
    }

    // A retry stays in the run's own branch: retrying from a branch view must
    // not file the new attempt under main.
    const branchRows = await db.query<{ branch_id: string }>(
      `SELECT branch_id FROM messages
        WHERE run_id = $1 AND role = 'user'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
      [run.id],
    );

    const result = await acceptRun(
      { db, executor, config, secrets },
      {
        prompt: run.prompt,
        kind: run.kind,
        conversationId: run.conversationId,
        branchId: branchRows[0]?.branch_id ?? null,
        // A retried deep-research run is the same mission, so it keeps the
        // same mode and budget rather than silently becoming a one-shot.
        deepResearch: run.deepResearch,
        researchBudgetMinutes: run.researchBudgetMinutes,
      },
    );
    sendAccepted(res, result, config, branchRows[0]?.branch_id ?? null);
  });

  /**
   * Resume a run: same run row, continued from the first unfinished step.
   *
   * Qualifies: a run 'paused' by its token budget, or 'failed' with
   * error_type 'interrupted' (the server restarted mid-mission). Anything
   * else is a retry, not a resume. A resume does not spend a new daily run —
   * the mission was already counted when it first started — but it still
   * obeys one-at-a-time.
   */
  router.post('/runs/:id/resume', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const resumable =
      run.status === 'paused' ||
      (run.status === 'failed' && run.errorType === 'interrupted');
    if (!resumable) {
      res.status(400).json({
        error: 'not_resumable',
        message: `Only a paused or interrupted run can be resumed (this one is ${run.status})`,
      });
      return;
    }
    // One at a time — but the run being resumed holds its own slot while
    // paused, so it does not count as "another mission".
    const active = await getActiveRun(db);
    if (active && active.id !== run.id) {
      res.status(409).json({
        error: 'in_progress',
        message: 'Another mission is already running — wait for it to finish, then resume.',
      });
      return;
    }

    const fromStep = await resumeFromStep(db, run.id);
    const steps = await getMissionSteps(db, run.id);
    await db.query(
      `UPDATE runs
          SET status = 'queued', resume_from_step = $2,
              error_type = NULL, error_message = NULL
        WHERE id = $1`,
      [run.id, fromStep],
    );
    const resumed = await getRun(db, run.id);
    if (!resumed) {
      res.status(500).json({ error: 'resume_failed' });
      return;
    }
    executor.start(resumed);
    console.log(`[run] ${run.id} resumed from step ${fromStep} (${steps.filter((s) => s.status === 'done').length} done)`);
    res.json({ run: resumed, fromStep });
  });

  /**
   * Approve a waiting plan: the mission starts executing from the approved
   * steps.
   *
   * Only an 'awaiting_plan' run qualifies. The transition is a single
   * conditional UPDATE, so a double-tap approves once — the second tap gets a
   * 400 instead of starting the mission twice. The run already holds the
   * single-active slot, so no budget is spent and no queue is jumped.
   */
  router.post('/runs/:id/approve', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const ok = await approveRunPlan(db, run.id);
    if (!ok) {
      res.status(400).json({
        error: 'not_awaiting_plan',
        message: `Only a run waiting for plan approval can be approved (this one is ${run.status})`,
      });
      return;
    }
    await emitEvent(db, run.id, 'run.plan_approved', {});
    const approved = await getRun(db, run.id);
    if (approved) executor.start(approved);
    res.json({ run: approved ?? run });
  });

  /**
   * Edit a waiting plan: replace the step labels, reindexed 1..N.
   *
   * The run stays in 'awaiting_plan' — editing is not approval; the operator
   * still taps Approve to start the mission. The updated plan is broadcast
   * as `run.plan_updated` so every open view re-renders the same checklist.
   */
  router.post('/runs/:id/plan', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { steps?: unknown };
    const labels = Array.isArray(body.steps)
      ? body.steps
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 20)
      : [];
    if (labels.length === 0) {
      res.status(400).json({
        error: 'plan_required',
        message: 'steps must be a non-empty array of step labels (max 20)',
      });
      return;
    }
    const steps = await updateRunPlan(db, run.id, labels);
    if (!steps) {
      res.status(400).json({
        error: 'not_awaiting_plan',
        message: `Only a run waiting for plan approval can be edited (this one is ${run.status})`,
      });
      return;
    }
    await emitEvent(db, run.id, 'run.plan_updated', { plan: steps });
    const updated = await getRun(db, run.id);
    res.json({ run: updated ?? run, plan: steps });
  });

  // ---- shareable replays ------------------------------------------------

  /**
   * Share a finished run: enable (or return) its public replay link.
   *
   * Idempotent — tapping Share twice returns the same URL instead of
   * rotating the token. Only a finished run qualifies; an in-flight mission
   * must never be shareable.
   */
  router.post('/runs/:id/share', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    if (!canShareRun(run)) {
      res.status(400).json({
        error: 'not_finished',
        message: `Only a finished run can be shared (this one is ${run.status})`,
      });
      return;
    }
    const token = run.shareToken ?? newShareToken();
    if (!run.shareToken) await setShareToken(db, run.id, token);
    res.json({ url: shareUrl(config, token), token });
  });

  /**
   * Revoke a run's replay link. The token is cleared, so the old URL 404s
   * immediately.
   */
  router.delete('/runs/:id/share', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    await setShareToken(db, run.id, null);
    res.json({ ok: true });
  });

  // ---- the live stream ----------------------------------------------------

  router.get('/runs/:id/stream', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }

    let from = resumeFrom(req);
    // finishRun compacts intermediate snapshots and renumbers `seq` from 1, so a
    // cursor taken before the finish can point past the end of the log — a
    // backgrounded phone reconnecting is the common case. Repairing it to 0
    // replays the whole run (always correct, just heavier) instead of replaying
    // nothing, which is what an empty timeline looks like to the operator.
    if (from > 0 && from > (await latestEventSeq(db, run.id))) from = 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform stops proxies re-chunking the body; X-Accel-Buffering
      // covers nginx-style buffering in front of the app on Render.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write(': stream open\n\n');
    res.flushHeaders();

    let closed = false;
    let live = false;
    let maxSeq = from;
    const buffered: StreamEvent[] = [];

    const heartbeat = setInterval(() => {
      if (closed) return;
      // A comment frame keeps intermediaries from treating the stream as idle.
      res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.write('event: end\ndata: {}\n\n');
      res.end();
    };

    const send = (event: StreamEvent): void => {
      if (closed) return;

      if (event.seq !== undefined) {
        if (event.seq <= maxSeq) return; // already replayed
        maxSeq = event.seq;
      } else if (res.writableLength > TRANSIENT_BACKPRESSURE_BYTES) {
        // The client is behind. Dropping decoration keeps memory bounded on a
        // 512 MB instance; the next snapshot repairs the display.
        return;
      }

      res.write(sseFrame(event));
      if (event.seq !== undefined && TERMINAL_EVENT_TYPES.has(event.type)) finish();
    };

    // 1. Subscribe before reading, so nothing can fall between the two.
    const unsubscribe = bus.subscribe(run.id, (event) => {
      if (live) send(event);
      else buffered.push(event);
    });

    res.on('close', cleanup);

    // 2. Replay the durable history.
    const history = await readEvents(db, run.id, from, MAX_REPLAY_EVENTS);
    for (const event of history) {
      send({ seq: event.seq, type: event.type, payload: event.payload });
    }

    // 3. Flush what the bus delivered during the replay, then go live. There is
    //    no await between these steps, so the bus cannot slip past both paths.
    for (const event of buffered) {
      if (event.seq === undefined) continue; // decoration: the snapshot covers it
      send(event);
    }
    buffered.length = 0;
    live = true;

    // 4. If the run is already over, say so rather than holding a dead stream
    //    open until the browser times it out.
    const current = await getRun(db, run.id);
    if (current && isTerminal(current.status)) finish();
  });

  // ---- budget & history ---------------------------------------------------

  router.get('/budget', async (_req: Request, res: Response) => {
    const snapshot = await budgetSnapshot(db, ['web', 'whatsapp', 'api'], config.dailyRunBudget);
    res.json({ buckets: snapshot, limit: config.dailyRunBudget });
  });

  router.get('/conversations', async (_req: Request, res: Response) => {
    res.json({ conversations: await listConversations(db) });
  });

  router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
    const branch = typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : null;
    res.json({ messages: await listMessages(db, req.params.id, 200, branch) });
  });

  router.get('/conversations/:id/branches', async (req: Request, res: Response) => {
    res.json({ branches: await listBranches(db, req.params.id) });
  });

  /**
   * Fork the conversation at a message (Manus-style branch-on-edit).
   *
   * The new branch starts after the message *before* the given one in its
   * visible chain, so the edited replacement — inserted next, by the run that
   * follows — takes the original's place in the new branch's view. The
   * original message stays in the parent branch, unedited.
   */
  router.post('/conversations/:id/branches', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { messageId?: unknown };
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    if (!messageId) {
      res.status(400).json({ error: 'message_required', message: 'messageId must be a non-empty string' });
      return;
    }
    try {
      const branch = await forkBranch(db, req.params.id, messageId);
      res.status(201).json({ branch });
    } catch (err) {
      res.status(404).json({ error: 'message_not_found', message: (err as Error).message });
    }
  });

  return router;
}
