/**
 * Approve-by-WhatsApp: plan previews and LinkedIn drafts, decided from the phone.
 *
 * The contract:
 *
 *   OUT  When a run enters `awaiting_plan` (accept.ts) or a LinkedIn draft is
 *        filed as pending (executor.ts), the owner gets one WhatsApp message:
 *        the plan steps or the draft text, plus "Reply YES to approve, NO to
 *        reject, or CHANGE: <your edits>".
 *
 *   IN   A reply from the owner while an approval is open is intercepted in
 *        the poller *before* it can become a new mission: "yes" approves,
 *        "no" rejects, anything else is fed back as requested changes. With
 *        no open approval the message flows to the relay untouched.
 *
 * The anti-spam rules, all in this file:
 *
 *   - Silent without a token. No `whatsapp_token` means no ask, no error.
 *   - One ask per pending item. The row is claimed in `wa_approvals` *before*
 *     sending; a restart, a redeploy, or a slow send can never nag twice.
 *   - No nagging. An unanswered ask just waits — the item stays actionable
 *     in the web app, and feedback never re-sends the ask.
 *   - Never throws. An ask failure must not touch the run or the draft.
 *   - Never a run. Approval handling approves, rejects, or records feedback
 *     on the existing item; it never starts a mission.
 *
 * Security: only the owner can approve — the learned creator id
 * (`whatsapp_to` override or the `user:<id>` learned from inbound traffic).
 * Anyone else's "yes" is ignored and routed normally.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import type { EventBus } from '../events.js';
import type { SecretsStore } from '../settings.js';
import {
  approveRunPlan,
  emitEvent,
  finishRun,
  getRun,
  saveRunPlan,
  type PlanStep,
  type Run,
} from '../runs.js';
import { directionById, directionPayload, parseDirectionReply } from '../design/directions.js';
import { looksLikeUiMission } from '../design.js';
import { saveRunDirection } from '../runs.js';
import { markDraftFailed, publishLinkedInDraft } from '../linkedin.js';
import { WhatsAppClient, type InboundMessage } from './api.js';
import { WhatsAppSender } from './sender.js';
import { resolveRecipient } from './doneping.js';
import { loadCreatorId, markProcessed } from './store.js';

export type ApprovalKind = 'plan' | 'linkedin_draft';
export type ApprovalVerdict = 'approve' | 'reject' | 'changes';
export type ApprovalResolution = 'approved' | 'rejected' | 'stale';

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  refId: string;
  askedAt: string;
  feedback: string | null;
}

/** The executor surface the verdict handler needs — the poller passes its own. */
export interface ApprovalExecutor {
  start(run: Run): void;
  cancel(runId: string): boolean;
}

export interface AskDeps {
  db: Db;
  /** The secrets store; `whatsapp_token` and `whatsapp_to` are read. */
  secrets: Pick<SecretsStore, 'get'>;
  /** Test seam: replaces the HTTP layer. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface HandleDeps {
  db: Db;
  bus: EventBus;
  executor: ApprovalExecutor;
  masterKey: string;
  secrets?: Pick<SecretsStore, 'get'>;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

function newApprovalId(): string {
  return `wap_${randomBytes(9).toString('base64url')}`;
}

function titleOf(prompt: string, max = 80): string {
  const oneLine = prompt.trim().replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine || 'Untitled task';
}

/**
 * Claim the open ask for an item, or false when one already exists. The claim
 * happens before sending: a crash between send and insert would otherwise
 * double-ask, and a failed send must not turn into a retry loop.
 */
async function claimApproval(db: Db, kind: ApprovalKind, refId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO wa_approvals (id, kind, ref_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [newApprovalId(), kind, refId],
  );
  return rows.length > 0;
}

/** The owner's newest unresolved ask, if any. */
export async function findPendingApproval(db: Db): Promise<PendingApproval | null> {
  const rows = await db.query<{
    id: string;
    kind: string;
    ref_id: string;
    asked_at: Date | string;
    feedback: string | null;
  }>(
    `SELECT id, kind, ref_id, asked_at, feedback
       FROM wa_approvals
      WHERE resolved_at IS NULL
      ORDER BY asked_at DESC
      LIMIT 1`,
    [],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as ApprovalKind,
    refId: row.ref_id,
    askedAt: row.asked_at instanceof Date ? row.asked_at.toISOString() : String(row.asked_at),
    feedback: row.feedback,
  };
}

export async function resolveApproval(
  db: Db,
  id: string,
  resolution: ApprovalResolution,
): Promise<void> {
  await db.query(
    `UPDATE wa_approvals
        SET resolved_at = now(), resolution = $2
      WHERE id = $1 AND resolved_at IS NULL`,
    [id, resolution],
  );
}

async function noteApprovalFeedback(db: Db, id: string, note: string): Promise<void> {
  const trimmed = note.slice(0, 500);
  if (!trimmed) return;
  await db.query(
    `UPDATE wa_approvals
        SET feedback = CASE
              WHEN feedback IS NULL OR feedback = '' THEN $2
              ELSE LEFT(feedback || E'\\n---\\n' || $2, 2000)
            END
      WHERE id = $1 AND resolved_at IS NULL`,
    [id, trimmed],
  );
}

/**
 * Who may approve. The `whatsapp_to` override wins when it is a real
 * `user:<id>`; otherwise the id learned from inbound traffic. Anyone else's
 * "yes" is not an approval.
 */
export async function resolveApprovalOwner(
  db: Db,
  secrets?: Pick<SecretsStore, 'get'>,
): Promise<string | null> {
  const override = secrets?.get('whatsapp_to')?.trim() ?? '';
  if (override.startsWith('user:')) return override;
  return loadCreatorId(db).catch(() => null);
}

// ---------------------------------------------------------------------------
// reply parsing: "yes" approves, "no" rejects, everything else is feedback
// ---------------------------------------------------------------------------

const APPROVE_RE = /^(yes|yeah|yep|yup|ok|okay|approve|approved|sure|go|do it|👍)(\s*[.!…]*)?$/i;
const REJECT_RE = /^(no|nope|nah|reject|rejected|cancel|stop|don't|do not|👎)(\s*[.!…]*)?$/i;
const CHANGE_PREFIX_RE = /^(change|changes|edit|edits)\s*:\s*/i;

export function parseApprovalReply(text: string): ApprovalVerdict {
  const clean = text.trim();
  if (APPROVE_RE.test(clean)) return 'approve';
  if (REJECT_RE.test(clean)) return 'reject';
  return 'changes';
}

/** "CHANGE: make it shorter" → "make it shorter". Plain feedback passes through. */
export function stripChangePrefix(text: string): string {
  return text.trim().replace(CHANGE_PREFIX_RE, '').trim();
}

// ---------------------------------------------------------------------------
// outbound: one ask per pending item, direct send, never throws
// ---------------------------------------------------------------------------

/** Proactive send to the owner — the same recipient the done ping uses. */
async function directSend(deps: AskDeps, text: string): Promise<boolean> {
  const token = deps.secrets.get('whatsapp_token');
  if (!token) return false;
  const log = deps.log ?? ((message: string) => console.log(message));
  const to = await resolveRecipient(
    { db: deps.db, secrets: deps.secrets },
    (message, level) =>
      level === 'error'
        ? console.error(`[approvals] ${message}`)
        : console.log(`[approvals] ${message}`),
  ).catch(() => null);
  if (!to) return false;
  try {
    const client = new WhatsAppClient({
      token,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
    });
    const sender = new WhatsAppSender(client, (message, level) =>
      level === 'error'
        ? console.error(`[approvals] ${message}`)
        : console.log(`[approvals] ${message}`),
    );
    const ok = await sender.send(text, { to });
    if (!ok) log(`[approvals] send failed: ${sender.error ?? 'unknown'}`, 'warn');
    return ok;
  } catch (err) {
    log(`[approvals] send failed: ${(err as Error).message}`, 'warn');
    return false;
  }
}

/**
 * Ask the owner to approve a waiting plan. Call once, when the run enters
 * `awaiting_plan`; the claim makes a second call a no-op. Resolves true only
 * when the platform accepted the message. Never throws.
 */
export async function maybeAskPlanApproval(
  deps: AskDeps,
  run: Run,
  steps: PlanStep[],
): Promise<boolean> {
  try {
    if (!deps.secrets.get('whatsapp_token')) return false;
    if (!(await claimApproval(deps.db, 'plan', run.id))) return false;

    const shown = steps.slice(0, 12);
    const lines = shown.map((s, i) => `${i + 1}. ${s.label.slice(0, 120)}`);
    if (steps.length > shown.length) lines.push(`…and ${steps.length - shown.length} more`);
    // A build is the one plan whose look is still open at this moment, and the
    // owner reading this on a phone cannot open the app to choose it. So the
    // ask carries the direction: the proposal, its alternates, and a one-tap
    // way to keep the proposal without choosing anything.
    const direction = looksLikeUiMission(run.prompt) ? directionPayload(run.prompt) : null;
    const directionLines = direction
      ? [
          '',
          `🎨 Direction: ${direction.name} — ${direction.blurb}`,
          ...direction.chips.map((chip, i) => `${i + 1}. ${chip.name} — ${chip.blurb}`),
        ]
      : [];
    const replyLine = direction
      ? 'Reply YES to approve, NO to reject, CHANGE: <edits>, or 1/2/3 for another direction — or CHOOSE to keep this one.'
      : 'Reply YES to approve, NO to reject, or CHANGE: <your edits>';
    const message = [
      `📋 Plan ready — "${titleOf(run.prompt)}"`,
      '',
      ...lines,
      ...directionLines,
      '',
      replyLine,
    ].join('\n');
    return await directSend(deps, message);
  } catch (err) {
    (deps.log ?? console.log)(`[approvals] plan ask failed: ${(err as Error).message}`, 'warn');
    return false;
  }
}

/**
 * Ask the owner to review a LinkedIn draft. Same one-ask contract as plans.
 * Never throws.
 */
export async function maybeAskDraftApproval(
  deps: AskDeps,
  draftId: string,
  draftText: string,
): Promise<boolean> {
  try {
    if (!deps.secrets.get('whatsapp_token')) return false;
    if (!(await claimApproval(deps.db, 'linkedin_draft', draftId))) return false;

    const message = [
      '📝 LinkedIn draft ready:',
      '',
      draftText.slice(0, 1500),
      '',
      'Reply YES to publish, NO to discard, or CHANGE: <your edits>',
    ].join('\n');
    return await directSend(deps, message);
  } catch (err) {
    (deps.log ?? console.log)(`[approvals] draft ask failed: ${(err as Error).message}`, 'warn');
    return false;
  }
}

// ---------------------------------------------------------------------------
// inbound: match a reply to the open ask and apply the verdict
// ---------------------------------------------------------------------------

/** Fold the owner's change note into the waiting plan as a visible step. */
async function appendPlanFeedback(db: Db, run: Run, note: string): Promise<void> {
  const current = run.plan ?? [];
  const label = `Operator change: ${note.slice(0, 200)}`;
  // A replayed message must not stack the same note twice.
  if (current.length > 0 && current[current.length - 1].label === label) return;
  const labels = [...current.map((s) => s.label), label];
  const steps: PlanStep[] = labels.map((l, i) => ({
    index: i + 1,
    total: labels.length,
    label: l,
  }));
  await saveRunPlan(db, run.id, steps);
  await emitEvent(db, run.id, 'run.plan_updated', { plan: steps, via: 'whatsapp' });
}

async function applyPlanVerdict(
  deps: HandleDeps,
  approval: PendingApproval,
  run: Run,
  verdict: ApprovalVerdict,
  text: string,
): Promise<string> {
  if (run.status !== 'awaiting_plan') {
    // Approved in the web app, cancelled, or finished while the ask was out.
    await resolveApproval(deps.db, approval.id, 'stale');
    return 'That plan is not waiting anymore — nothing to decide.';
  }

  if (verdict === 'approve') {
    const ok = await approveRunPlan(deps.db, run.id);
    if (!ok) {
      await resolveApproval(deps.db, approval.id, 'stale');
      return 'That plan was already handled — nothing to approve.';
    }
    await resolveApproval(deps.db, approval.id, 'approved');
    await emitEvent(deps.db, run.id, 'run.plan_approved', { via: 'whatsapp' });
    const approved = await getRun(deps.db, run.id);
    if (approved) deps.executor.start(approved);
    return '✅ Plan approved — the task is running now.';
  }

  if (verdict === 'reject') {
    await resolveApproval(deps.db, approval.id, 'rejected');
    // Mirror the web cancel path: an awaiting_plan run has no executor entry,
    // so close it here and publish the terminal event the stream waits for.
    const signalled = deps.executor.cancel(run.id);
    if (!signalled) {
      const seq = await finishRun(deps.db, run.id, {
        status: 'cancelled',
        errorType: 'operator_rejected',
        errorMessage: 'Plan rejected on WhatsApp',
      });
      deps.bus.publish(run.id, {
        seq,
        type: 'run.cancelled',
        payload: { status: 'cancelled', errorType: 'operator_rejected' },
      });
    }
    return '🛑 Plan rejected — the task will not run.';
  }

  const note = stripChangePrefix(text);
  await appendPlanFeedback(deps.db, run, note);
  await noteApprovalFeedback(deps.db, approval.id, note);
  // Stays open: he can iterate on the plan, then approve.
  return '📝 Noted — added your change to the plan. Reply YES to approve, NO to reject, or send more changes.';
}

async function applyDraftVerdict(
  deps: HandleDeps,
  approval: PendingApproval,
  verdict: ApprovalVerdict,
  text: string,
): Promise<string> {
  const rows = await deps.db.query<{ id: string; status: string }>(
    `SELECT id, status FROM linkedin_drafts WHERE id = $1`,
    [approval.refId],
  );
  const draft = rows[0];
  if (!draft || draft.status !== 'pending') {
    await resolveApproval(deps.db, approval.id, 'stale');
    return 'That draft is not pending anymore — nothing to decide.';
  }

  if (verdict === 'approve') {
    const result = await publishLinkedInDraft(deps.db, deps.masterKey, draft.id);
    if (result.status === 'published') {
      await resolveApproval(deps.db, approval.id, 'approved');
      return '✅ Published on LinkedIn.';
    }
    if (result.status === 'already' || result.status === 'not_found') {
      await resolveApproval(deps.db, approval.id, 'stale');
      return 'That draft is not pending anymore — nothing to publish.';
    }
    // not_connected / token_expired / failed: the draft stays pending, so he
    // can publish from the web app once the connection is fixed.
    return `⚠️ Could not publish: ${result.message} The draft is still pending — fix it in Settings or tap Publish in the web app.`;
  }

  if (verdict === 'reject') {
    await markDraftFailed(deps.db, draft.id, 'Discarded by the operator on WhatsApp');
    await resolveApproval(deps.db, approval.id, 'rejected');
    return '🗑️ Draft discarded — it will not be published.';
  }

  const note = stripChangePrefix(text);
  await noteApprovalFeedback(deps.db, approval.id, note);
  // Stays open: he can send more feedback, then approve or discard.
  return '📝 Feedback noted — the draft is still pending. Reply YES to publish it as-is, NO to discard, or edit it in the web app.';
}

/**
 * Maybe consume an inbound message as an approval reply.
 *
 * Returns `{ handled: true, reply }` when the message was the owner's answer
 * to an open ask — the poller must send the reply and go no further. Returns
 * `{ handled: false }` when there is no open ask, the sender is not the
 * owner, or anything unexpected happened before a verdict was read: the
 * message flows to the relay untouched.
 *
 * Once a verdict is read, the message is consumed as an approval reply no
 * matter what — approval handling never creates a run, even on error.
 */
export async function maybeHandleApprovalReply(
  deps: HandleDeps,
  message: InboundMessage,
): Promise<{ handled: boolean; reply: string }> {
  const notHandled = { handled: false, reply: '' };
  const log = deps.log ?? ((m: string) => console.log(m));

  let approval: PendingApproval | null;
  try {
    approval = await findPendingApproval(deps.db);
  } catch (err) {
    log(`[approvals] lookup failed: ${(err as Error).message}`, 'warn');
    return notHandled;
  }
  if (!approval) return notHandled;

  const owner = await resolveApprovalOwner(deps.db, deps.secrets).catch(() => null);
  if (!owner || message.from !== owner) return notHandled;

  const text = (message.text ?? '').trim();
  // The direction reply is read before the verdict, and that order is the whole
  // point: `parseApprovalReply` maps anything that is not yes/no to 'changes',
  // so a bare "2" would otherwise be appended to the plan as "Operator change:
  // 2" and the direction would never be chosen.
  if (approval.kind === 'plan') {
    const run = await getRun(deps.db, approval.refId);
    if (run && run.status === 'awaiting_plan' && looksLikeUiMission(run.prompt)) {
      const payload = directionPayload(run.prompt);
      const picked = parseDirectionReply(text, payload.chips, payload.id);
      if (picked) {
        const id = 'auto' in picked ? payload.id : picked.id;
        const direction = directionById(id);
        if (direction) {
          const saved = await saveRunDirection(deps.db, run.id, direction.id);
          await emitEvent(deps.db, run.id, 'design.direction', {
            ...directionPayload(run.prompt, direction.id),
            chosenBy: 'auto' in picked ? 'auto' : 'operator',
          });
          await markProcessed(deps.db, message.id, null).catch(() => undefined);
          return {
            handled: true,
            reply: saved
              ? `🎨 Direction: ${direction.name} — ${direction.blurb}\nReply YES to approve and I will build it that way.`
              : 'That task is not waiting for me anymore — nothing to change.',
          };
        }
      }
    }
  }
  const verdict = parseApprovalReply(text);
  const label = approval.kind === 'plan' ? 'plan' : 'draft';

  let reply: string;
  try {
    if (approval.kind === 'plan') {
      const run = await getRun(deps.db, approval.refId);
      if (!run) {
        await resolveApproval(deps.db, approval.id, 'stale');
        reply = 'That plan is gone — nothing to decide.';
      } else {
        reply = await applyPlanVerdict(deps, approval, run, verdict, text);
      }
    } else {
      reply = await applyDraftVerdict(deps, approval, verdict, text);
    }
  } catch (err) {
    // Consumed anyway: the ask stays open and he can retry or use the web app.
    log(`[approvals] verdict failed: ${(err as Error).message}`, 'error');
    reply =
      `⚠️ I could not apply that — ${(err as Error).message} ` +
      `The ${label} is still waiting; try again or use the web app.`;
  }

  // The verdict is applied (or recorded as failed); the message is done. A
  // replay must not re-apply it — approve/reject are guarded anyway, and the
  // plan-feedback path dedupes on the last step's label.
  await markProcessed(deps.db, message.id, null).catch(() => undefined);
  return { handled: true, reply };
}
