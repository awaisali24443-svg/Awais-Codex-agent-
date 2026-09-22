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
import { budgetSnapshot } from '../budget.js';
import { listArtifacts } from '../artifacts.js';
import { BUCKET_FOR_KIND, acceptRun, type AcceptResult } from '../accept.js';
import {
  TERMINAL_STATUSES,
  getActiveRun,
  getRun,
  listConversations,
  listMessages,
  listRuns,
  readEvents,
  setRunStatus,
  type RunKind,
  type RunStatus,
} from '../runs.js';

export interface RunRouteDeps {
  db: Db;
  bus: EventBus;
  executor: RunExecutor;
  config: AppConfig;
}

const MAX_PROMPT_CHARS = 8_000;
/** Replies are truncated on the wire, never in the log. ~4 MB is ample. */
const MAX_REPLAY_EVENTS = 5_000;
/** Above this many unflushed bytes a client is too slow to receive decoration. */
const TRANSIENT_BACKPRESSURE_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;

const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);

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
function sendAccepted(res: Response, result: AcceptResult, config: AppConfig): void {
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
    budget: { bucket: result.bucket, remaining: result.remaining, limit: config.dailyRunBudget },
  });
}

export function createRunRoutes(deps: RunRouteDeps): Router {
  const { db, bus, executor, config } = deps;
  const router = Router();

  // ---- create a run -------------------------------------------------------

  router.post('/runs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      prompt?: unknown;
      kind?: unknown;
      conversationId?: unknown;
      notifyWhatsapp?: unknown;
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

    // Same rules as the phone: one task at a time, one budget, one code path.
    const result = await acceptRun(
      { db, executor, config },
      {
        prompt,
        kind,
        conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
        // Opt-in WhatsApp "done" ping for this run. Strictly boolean: anything
        // else is not an opt-in.
        notifyWhatsapp: body.notifyWhatsapp === true,
      },
    );

    sendAccepted(res, result, config);
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
      // orphaned at boot). Close it here so it stops blocking new missions.
      await setRunStatus(db, run.id, 'cancelled', {
        errorType: 'orphaned',
        errorMessage: 'Cancelled while no executor was attached',
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

    const result = await acceptRun(
      { db, executor, config },
      {
        prompt: run.prompt,
        kind: run.kind,
        conversationId: run.conversationId,
      },
    );
    sendAccepted(res, result, config);
  });

  // ---- the live stream ----------------------------------------------------

  router.get('/runs/:id/stream', async (req: Request, res: Response) => {
    const run = await getRun(db, req.params.id);
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }

    const from = resumeFrom(req);

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
    res.json({ messages: await listMessages(db, req.params.id) });
  });

  return router;
}
