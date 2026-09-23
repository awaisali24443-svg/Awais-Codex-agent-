/**
 * Run repository.
 *
 * A run is one mission: a prompt, a lifecycle, and an append-only event log.
 * All the invariants live in the database (see migrations/001_init.sql):
 *
 *   - `runs_single_active_idx` makes "one mission at a time" impossible to
 *     violate, even if two requests arrive in the same millisecond
 *   - `run_events` is keyed (run_id, seq) so the log cannot have holes
 *   - events are appended with the sequence allocated inside the same
 *     transaction that holds the advisory lock, so no two writers can pick the
 *     same number
 *   - `finishRun` compacts intermediate `*.snapshot` events (they are
 *     cumulative, so only the first and last of each stream are kept)
 */
import crypto from 'crypto';

import { appendEvent, type Db } from './db.js';
import { CHAIN_VISIBLE, chainCte, ensureMainBranch } from './branches.js';
import { parseVerification, type VerificationCheck } from './mission_verify.js';

export type RunKind = 'chat' | 'whatsapp' | 'api';
export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting_plan' | 'completed' | 'failed' | 'cancelled';
export type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * One step of a run's plan, stored as `runs.plan_json`.
 *
 * The planning pass asks the engine for "Step k/N" lines (the same protocol
 * as live milestones); the operator approves or edits them before the
 * mission executes. `total` is the N the engine announced.
 */
export interface PlanStep {
  index: number;
  total: number;
  label: string;
}

export interface Run {
  id: string;
  conversationId: string | null;
  kind: RunKind;
  prompt: string;
  status: RunStatus;
  engine: string;
  /** Engine-side handles. The whole point of continuation: the agent keeps its
   *  sandbox and its memory of the mission across separate browser sessions. */
  interactionId: string | null;
  environmentId: string | null;
  /** Set when this mission continues the sandbox of an earlier one. */
  previousInteractionId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  /** Opt-in: send one WhatsApp "done" ping when a web-started run finishes. */
  notifyWhatsapp: boolean;
  /**
   * Deep-research mode: the executor chains engine passes on this same mission
   * until the wall-clock budget below is spent, then synthesises the report.
   * researchBudgetMinutes is null unless deepResearch is on.
   */
  deepResearch: boolean;
  researchBudgetMinutes: number | null;
  /** Optional per-mission token cap (chars/4 proxy while streaming). */
  tokenBudget: number | null;
  /** When resuming an interrupted mission, the first step not yet done. */
  resumeFromStep: number | null;
  /** The operator-visible plan, set by the planning pass; null until then. */
  plan: PlanStep[] | null;
  /**
   * Prove-it's-done results, set when a mission closes. Null when the
   * mission had nothing checkable and verification was skipped.
   */
  verification: VerificationCheck[] | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

/** Thrown when the one-active-run rule rejects a new mission. */
export class RunConflictError extends Error {
  constructor(readonly activeRunId: string | null) {
    super(
      activeRunId
        ? `Another mission is already running (${activeRunId}); one at a time protects the daily quota`
        : 'Another mission is already active',
    );
    this.name = 'RunConflictError';
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

interface RunRow {
  id: string;
  conversation_id: string | null;
  kind: RunKind;
  prompt: string;
  status: RunStatus;
  engine: string;
  interaction_id: string | null;
  environment_id: string | null;
  previous_interaction_id: string | null;
  error_type: string | null;
  error_message: string | null;
  notify_whatsapp: boolean | null;
  deep_research: boolean | null;
  research_budget_minutes: number | null;
  token_budget: number | null;
  resume_from_step: number | null;
  plan_json: unknown;
  verification_json: unknown;
  started_at: Date | string;
  finished_at: Date | string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Parse the stored plan defensively: a corrupt value is no plan, not a crash. */
function parsePlan(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      index: Number(s.index),
      total: Number(s.total),
      label: String(s.label ?? '').slice(0, 140),
    }))
    .filter((s) => Number.isFinite(s.index) && s.index >= 1 && s.label.length > 0)
    .sort((a, b) => a.index - b.index);
  return steps.length ? steps : null;
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    prompt: row.prompt,
    status: row.status,
    engine: row.engine,
    interactionId: row.interaction_id,
    environmentId: row.environment_id,
    previousInteractionId: row.previous_interaction_id,
    errorType: row.error_type,
    errorMessage: row.error_message,
    notifyWhatsapp: row.notify_whatsapp ?? false,
    deepResearch: row.deep_research ?? false,
    researchBudgetMinutes: row.research_budget_minutes ?? null,
    tokenBudget: row.token_budget ?? null,
    resumeFromStep: row.resume_from_step ?? null,
    plan: parsePlan(row.plan_json),
    verification: parseVerification(row.verification_json),
    startedAt: toIso(row.started_at) as string,
    finishedAt: toIso(row.finished_at),
  };
}

const RUN_COLUMNS = `id, conversation_id, kind, prompt, status, engine,
                     interaction_id, environment_id, previous_interaction_id,
                     error_type, error_message, notify_whatsapp,
                     deep_research, research_budget_minutes,
                     token_budget, resume_from_step, plan_json, verification_json,
                     started_at, finished_at`;

/** A unique violation on `runs_single_active_idx`, as opposed to the primary key. */
function isActiveConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== '23505') return false;
  if (e.constraint) return e.constraint === 'runs_single_active_idx';
  return /runs_single_active_idx/.test(e.message ?? '');
}

export async function getActiveRun(db: Db): Promise<Run | null> {
  const rows = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs
      WHERE status IN ('queued', 'running', 'paused', 'awaiting_plan')
      ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  const rows = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [id]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listRuns(db: Db, limit = 25): Promise<Run[]> {
  const rows = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(mapRun);
}

/**
 * Create a conversation for the run to belong to.
 *
 * Titles are derived from the prompt so the sidebar has something human to show
 * without waiting for the model to summarise anything.
 */
export async function createConversation(
  db: Db,
  prompt: string,
  source: RunKind = 'chat',
): Promise<string> {
  const id = newId('cnv');
  const title = prompt.trim().replace(/\s+/g, ' ').slice(0, 72) || 'New mission';
  await db.query(
    'INSERT INTO conversations (id, title, source) VALUES ($1, $2, $3)',
    [id, title, source === 'whatsapp' ? 'whatsapp' : source === 'api' ? 'api' : 'web'],
  );
  // Every conversation starts with one 'main' branch; messages land there
  // unless a fork says otherwise.
  await ensureMainBranch(db, id);
  return id;
}

export interface Continuation {
  interactionId: string;
  environmentId: string | null;
}

/**
 * Find the sandbox this mission should continue.
 *
 * A follow-up message in the same conversation should reach the same agent with
 * its workspace and its memory intact — otherwise every message starts a fresh
 * sandbox and the agent forgets the project it was mid-way through building.
 *
 * Only a *completed* run qualifies. Continuing from a failed or cancelled one
 * would attach the new mission to a half-finished step.
 */
export async function resolveContinuation(
  db: Db,
  conversationId: string,
): Promise<Continuation | null> {
  const rows = await db.query<{ interaction_id: string; environment_id: string | null }>(
    `SELECT interaction_id, environment_id
       FROM runs
      WHERE conversation_id = $1
        AND status = 'completed'
        AND interaction_id IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST, started_at DESC
      LIMIT 1`,
    [conversationId],
  );
  const row = rows[0];
  return row ? { interactionId: row.interaction_id, environmentId: row.environment_id } : null;
}

export interface CreateRunInput {
  prompt: string;
  kind?: RunKind;
  engine: string;
  conversationId?: string | null;
  /** The branch the run's messages belong to. Defaults to the main branch. */
  branchId?: string | null;
  /** Skip automatic continuation and start a fresh sandbox. */
  fresh?: boolean;
  /** Opt-in: one WhatsApp "done" ping when a web-started run finishes. */
  notifyWhatsapp?: boolean;
  /**
   * Deep-research mode: chain engine passes until the budget below is spent.
   * researchBudgetMinutes is whole minutes; null means the default applies.
   */
  deepResearch?: boolean;
  researchBudgetMinutes?: number | null;
  /** Optional per-mission token cap. The executor pauses the run when spent. */
  tokenBudget?: number | null;
}

/**
 * Insert a queued run and its opening user message.
 *
 * @throws RunConflictError when another mission is already in flight.
 */
export async function createRun(db: Db, input: CreateRunInput): Promise<Run> {
  const kind: RunKind = input.kind ?? 'chat';
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('createRun: prompt is empty');

  let conversationId = input.conversationId ?? null;
  if (!conversationId) {
    conversationId = await createConversation(db, prompt, kind);
  }

  // Branches are per-conversation. A missing branch id means "main"; a wrong
  // one is a client bug, failed loudly rather than filed silently elsewhere.
  let branchId = input.branchId ?? null;
  if (branchId) {
    const ok = await db.query<{ id: string }>(
      `SELECT id FROM branches WHERE id = $1 AND conversation_id = $2`,
      [branchId, conversationId],
    );
    if (!ok[0]) throw new Error('createRun: branch does not belong to this conversation');
  } else {
    branchId = await ensureMainBranch(db, conversationId);
  }

  const continuation = input.fresh ? null : await resolveContinuation(db, conversationId);

  const id = newId('run');
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO runs (id, conversation_id, kind, prompt, status, engine,
                           previous_interaction_id, environment_id, notify_whatsapp,
                           deep_research, research_budget_minutes, token_budget)
         VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          conversationId,
          kind,
          prompt,
          input.engine,
          continuation?.interactionId ?? null,
          continuation?.environmentId ?? null,
          input.notifyWhatsapp === true,
          input.deepResearch === true,
          input.deepResearch === true ? (input.researchBudgetMinutes ?? null) : null,
          input.tokenBudget ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO messages (id, conversation_id, run_id, branch_id, role, content)
         VALUES ($1, $2, $3, $4, 'user', $5)`,
        [newId('msg'), conversationId, id, branchId, prompt],
      );
    });
  } catch (err) {
    if (isActiveConflict(err)) {
      const active = await getActiveRun(db);
      throw new RunConflictError(active?.id ?? null);
    }
    throw err;
  }

  const run = await getRun(db, id);
  if (!run) throw new Error(`createRun: run ${id} vanished immediately after insert`);
  return run;
}

export async function setRunStatus(
  db: Db,
  id: string,
  status: RunStatus,
  patch: { errorType?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  const terminal = TERMINAL_STATUSES.includes(status);
  await db.query(
    `UPDATE runs
        SET status = $2,
            error_type = COALESCE($3, error_type),
            error_message = COALESCE($4, error_message),
            finished_at = CASE WHEN $5 THEN now() ELSE finished_at END
      WHERE id = $1`,
    [id, status, patch.errorType ?? null, patch.errorMessage ?? null, terminal],
  );
}

/** Persist the planning pass's step list on the run. */
export async function saveRunPlan(db: Db, runId: string, steps: PlanStep[]): Promise<void> {
  await db.query('UPDATE runs SET plan_json = $2 WHERE id = $1', [runId, JSON.stringify(steps)]);
}

/**
 * Approve a waiting plan: awaiting_plan → queued. Returns true when the
 * transition happened; false when the run was not waiting (already approved,
 * cancelled, or finished) so a double-tap cannot start it twice.
 */
export async function approveRunPlan(db: Db, runId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE runs SET status = 'queued' WHERE id = $1 AND status = 'awaiting_plan' RETURNING id`,
    [runId],
  );
  return rows.length > 0;
}

/**
 * Replace the waiting plan's step labels, reindexed 1..N. Returns the new
 * steps, or null when the run is not waiting for approval — editing is not
 * approval, and a plan that already started executing is no longer editable.
 */
export async function updateRunPlan(db: Db, runId: string, labels: string[]): Promise<PlanStep[] | null> {
  const steps: PlanStep[] = labels.map((label, i) => ({
    index: i + 1,
    total: labels.length,
    label,
  }));
  const rows = await db.query<{ plan_json: unknown }>(
    `UPDATE runs SET plan_json = $2 WHERE id = $1 AND status = 'awaiting_plan' RETURNING plan_json`,
    [runId, JSON.stringify(steps)],
  );
  return rows.length ? parsePlan(rows[0].plan_json) : null;
}

export async function readEvents(
  db: Db,
  runId: string,
  afterSeq = 0,
  limit = 1000,
): Promise<RunEvent[]> {
  const rows = await db.query<{ seq: number; type: string; payload: unknown; at: Date | string }>(
    `SELECT seq, type, payload, at FROM run_events
      WHERE run_id = $1 AND seq > $2
      ORDER BY seq ASC LIMIT $3`,
    [runId, afterSeq, Math.min(Math.max(limit, 1), 5000)],
  );
  return rows.map((row) => ({
    seq: Number(row.seq),
    // PGlite hands back parsed jsonb; pg hands back parsed jsonb too, but a
    // driver upgrade should not be able to turn a payload into "[object Object]".
    type: row.type,
    payload: (typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : row.payload ?? {}) as Record<string, unknown>,
    at: toIso(row.at) as string,
  }));
}

export async function latestEventSeq(db: Db, runId: string): Promise<number> {
  const rows = await db.query<{ seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM run_events WHERE run_id = $1',
    [runId],
  );
  return Number(rows[0]?.seq ?? 0);
}

/**
 * Append one durable event and hand back its sequence number.
 *
 * Durable events are what a reconnecting client replays, so they are written
 * inside a transaction: the advisory lock in `appendEvent` is transaction
 * scoped, which both serialises concurrent writers and stays compatible with
 * PgBouncer's transaction pooling.
 */
export async function emitEvent(
  db: Db,
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<number> {
  return db.transaction((tx) => appendEvent(tx, runId, type, payload));
}

export interface FinishRunInput {
  /** 'paused' is not terminal — the run keeps its slot and can be resumed. */
  status: TerminalStatus | 'paused';
  /** Full assistant output so far. Persisted as the message so nothing is lost. */
  text?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Engine handles, stored so the next follow-up can continue this sandbox. */
  interactionId?: string | null;
  environmentId?: string | null;
  /** Prove-it's-done results; stored on the run so the finish card can show them. */
  verification?: VerificationCheck[] | null;
}

/**
 * Close a run atomically: final event, status, message and usage in one
 * transaction.
 *
 * Ordering matters for the stream. The terminal event is appended *before* the
 * status changes, so any client that sees a terminal status can be certain the
 * complete event log is already visible. This is what lets the SSE handler end
 * a finished stream without racing the last event.
 */
export async function finishRun(db: Db, runId: string, input: FinishRunInput): Promise<number> {
  const seq = await db.transaction(async (tx) => {
    const allocated = await appendEvent(tx, runId, `run.${input.status}`, {
      status: input.status,
      errorType: input.errorType ?? null,
      errorMessage: input.errorMessage ?? null,
      verification: input.verification ?? null,
    });

    await tx.query(
      `UPDATE runs
          SET status = $2,
              error_type = $3,
              error_message = $4,
              tokens_in = $5,
              tokens_out = $6,
              interaction_id = COALESCE($7, interaction_id),
              environment_id = COALESCE($8, environment_id),
              verification_json = COALESCE($9, verification_json),
              finished_at = now()
        WHERE id = $1`,
      [
        runId,
        input.status,
        input.errorType ?? null,
        input.errorMessage ?? null,
        input.tokensIn ?? null,
        input.tokensOut ?? null,
        input.interactionId ?? null,
        input.environmentId ?? null,
        input.verification ? JSON.stringify(input.verification) : null,
      ],
    );

    const text = (input.text ?? '').trim();
    if (text) {
      // A cancelled or failed run still keeps whatever it produced. Throwing
      // away partial output would violate "nothing is lost to a dropped
      // connection".
      await tx.query(
        `INSERT INTO messages (id, conversation_id, run_id, branch_id, role, content)
         SELECT $1, r.conversation_id, r.id,
                (SELECT branch_id FROM messages
                  WHERE run_id = $3 AND role = 'user'
                  ORDER BY created_at ASC, id ASC LIMIT 1),
                'assistant', $2
           FROM runs r WHERE r.id = $3`,
        [newId('msg'), text, runId],
      );
    }

    // Compact intermediate snapshots. Each `*.snapshot` event carries the full
    // cumulative text, so a long run's event log grows with the square of its
    // output (a 6s task with a 20KB answer wrote 114KB of events). Snapshots
    // are cumulative — every one supersedes the ones before it — so dropping
    // the intermediates loses nothing: keep the first and last of each stream
    // (the last holds the complete answer) plus the terminal `run.*` event
    // above, which is not a snapshot and is never touched.
    await tx.query(
      `DELETE FROM run_events e
         USING (
           SELECT seq,
                  ROW_NUMBER() OVER (PARTITION BY type ORDER BY seq ASC) AS rn_asc,
                  ROW_NUMBER() OVER (PARTITION BY type ORDER BY seq DESC) AS rn_desc
             FROM run_events
            WHERE run_id = $1 AND type LIKE '%.snapshot'
         ) doomed
        WHERE e.run_id = $1
          AND e.seq = doomed.seq
          AND doomed.rn_asc > 1
          AND doomed.rn_desc > 1`,
      [runId],
    );

    // Close the gaps the deletion left: the event log is gap-free by
    // contract ("the event log must be gap-free or replay cannot be
    // trusted"). Renumber in two steps — negate first, then assign 1..N —
    // so no transient duplicate key can fire mid-statement. All inside this
    // transaction, so no client ever sees the intermediate state.
    await tx.query(`UPDATE run_events SET seq = -seq WHERE run_id = $1 AND seq > 0`, [runId]);
    await tx.query(
      `WITH ordered AS (
         SELECT seq AS old_seq, ROW_NUMBER() OVER (ORDER BY seq DESC) AS new_seq
           FROM run_events WHERE run_id = $1
       )
       UPDATE run_events e SET seq = ordered.new_seq
         FROM ordered WHERE e.run_id = $1 AND e.seq = ordered.old_seq`,
      [runId],
    );

    return allocated;
  });

  return seq;
}

export async function listConversations(db: Db, limit = 50): Promise<
  Array<{ id: string; title: string; source: string; updatedAt: string; runCount: number }>
> {
  const rows = await db.query<{
    id: string;
    title: string;
    source: string;
    updated_at: Date | string;
    run_count: string;
  }>(
    `SELECT c.id, c.title, c.source, c.updated_at,
            (SELECT count(*) FROM runs r WHERE r.conversation_id = c.id)::text AS run_count
       FROM conversations c
      -- Last activity, not creation time: a conversation bubbles to the top
      -- whenever a new run lands in it. Conversations with no runs yet fall
      -- back to their creation time.
      ORDER BY COALESCE(
               (SELECT max(r.started_at) FROM runs r WHERE r.conversation_id = c.id),
               c.created_at
             ) DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source,
    updatedAt: toIso(r.updated_at) as string,
    runCount: Number(r.run_count),
  }));
}

export async function listMessages(
  db: Db,
  conversationId: string,
  limit = 200,
  branchId?: string | null,
): Promise<Array<{ id: string; role: string; content: string; runId: string | null; runStatus: string | null; runErrorType: string | null; createdAt: string }>> {
  const capped = Math.min(Math.max(limit, 1), 500);
  // A branch view is computed, never copied: the branch's own messages plus
  // each ancestor's messages up to its fork point, in conversation order.
  const branchFilter = branchId
    ? `WITH RECURSIVE ${chainCte('$3')}
       SELECT m.id, m.role, m.content, m.run_id, r.status AS run_status, r.error_type AS run_error_type, m.created_at
         FROM messages m
         JOIN chain c ON m.branch_id = c.id
         LEFT JOIN runs r ON r.id = m.run_id
        WHERE m.conversation_id = $1
          AND ${CHAIN_VISIBLE}
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $2`
    : `SELECT m.id, m.role, m.content, m.run_id, r.status AS run_status, r.error_type AS run_error_type, m.created_at
         FROM messages m LEFT JOIN runs r ON r.id = m.run_id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $2`;
  const rows = await db.query<{
    id: string;
    role: string;
    content: string;
    run_id: string | null;
    run_status: string | null;
    run_error_type: string | null;
    created_at: Date | string;
  }>(branchFilter, branchId ? [conversationId, capped, branchId] : [conversationId, capped]);
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    runStatus: r.run_status,
    runErrorType: r.run_error_type,
    createdAt: toIso(r.created_at) as string,
  }));
}

/**
 * Recent-turn context for the engine.
 *
 * Every run's prompt is only the newest message, so a follow-up like "make it
 * shorter" arrives with no idea what "it" was. This builds a compact transcript
 * of the conversation's recent turns (wire-only, like the memory block — the
 * stored prompt is never rewritten) so the agent knows what the conversation
 * is about. The current run's own opening message is excluded because it is
 * already the prompt.
 *
 * Bounded on purpose: at most HISTORY_TURNS messages, each truncated, so a
 * long conversation cannot blow up the token cost of every new run.
 */
export const HISTORY_TURNS = 12;
const HISTORY_CHARS_PER_TURN = 600;

export async function buildHistoryBlock(
  db: Db,
  conversationId: string | null,
  excludeRunId: string,
): Promise<string> {
  if (!conversationId) return '';
  const rows = await db.query<{ role: string; content: string }>(
    `SELECT role, content FROM messages
      WHERE conversation_id = $1 AND run_id <> $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [conversationId, excludeRunId, HISTORY_TURNS],
  );
  if (rows.length === 0) return '';
  const lines = rows.reverse().map((r) => {
    const who = r.role === 'assistant' ? 'assistant' : 'user';
    const text = r.content.length > HISTORY_CHARS_PER_TURN
      ? r.content.slice(0, HISTORY_CHARS_PER_TURN) + '…'
      : r.content;
    return `${who}: ${text}`;
  });
  return `[conversation — recent turns, oldest first]\n${lines.join('\n')}`;
}
