/**
 * Shareable mission replays.
 *
 * A finished run can be shared as a public read-only page — the operator taps
 * "Share replay", gets an unguessable link, and can revoke it. The token IS
 * the auth, so the page is served with no session.
 *
 * SECURITY: the public page renders ONLY the mission timeline (prompt, plan,
 * steps, verification, final answer). It never includes engine handles
 * (interactionId/environmentId), tokens, secrets, or anything from another
 * run. ShareData is built from an explicit allowlist, not the Run object —
 * adding a sensitive field to Run can never leak it into a replay.
 */
import { randomBytes } from 'node:crypto';

import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { getMissionSteps } from './mission_steps.js';
import { TERMINAL_STATUSES, type Run } from './runs.js';

/** 192 bits of entropy, URL-safe. Brute-forcing is not a threat model. */
export function newShareToken(): string {
  return randomBytes(24).toString('base64url');
}

export function shareUrl(config: AppConfig, token: string): string {
  const base = (config.appUrl || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  return `${base}/share/${token}`;
}

/**
 * Public download link for a mission artifact. Same unguessable-token scheme
 * as replays: anyone with the link downloads the file, nobody can guess one.
 * Texted to the phone, WhatsApp auto-links it, so a build output reaches the
 * phone without the web UI.
 */
export function artifactShareUrl(config: AppConfig, token: string): string {
  const base = (config.appUrl || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  return `${base}/a/${token}`;
}

/** Only a finished mission may be shared — never an in-flight one. */
export function canShareRun(run: Run): boolean {
  return (
    run.status === 'paused' ||
    (TERMINAL_STATUSES as readonly string[]).includes(run.status)
  );
}

export interface SharePlanStep {
  index: number;
  total: number;
  label: string;
}

export interface ShareMissionStep {
  seq: number;
  total: number;
  label: string;
  status: string;
  resultSummary: string | null;
}

export interface ShareCheck {
  name: string;
  passed: boolean;
  evidence: string;
}

/** Explicit allowlist: nothing sensitive can reach the public page. */
export interface ShareData {
  prompt: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  plan: SharePlanStep[];
  steps: ShareMissionStep[];
  verification: ShareCheck[];
  /** Truncated on purpose: a replay is a summary, not a dump. */
  answer: string;
}

const MAX_ANSWER_CHARS = 30_000;

export async function buildShareData(db: Db, run: Run): Promise<ShareData> {
  const [steps, answers] = await Promise.all([
    getMissionSteps(db, run.id),
    db.query<{ content: string }>(
      `SELECT content FROM messages
        WHERE run_id = $1 AND role = 'assistant'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [run.id],
    ),
  ]);
  const raw = answers[0]?.content ?? '';
  const answer =
    raw.length > MAX_ANSWER_CHARS ? `${raw.slice(0, MAX_ANSWER_CHARS)}… (truncated)` : raw;
  return {
    prompt: run.prompt,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    plan: (run.plan ?? []).map((s) => ({ index: s.index, total: s.total, label: s.label })),
    steps: steps.map((s) => ({
      seq: s.seq,
      total: s.total,
      label: s.label,
      status: s.status,
      resultSummary: s.resultSummary,
    })),
    verification: (run.verification ?? []).map((c) => ({
      name: c.name,
      passed: c.passed,
      evidence: c.evidence,
    })),
    answer,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STEP_ICON: Record<string, string> = {
  done: '✓',
  doing: '▶',
  pending: '○',
  failed: '✗',
  skipped: '–',
};

/**
 * Server-rendered, dependency-free replay page. Every interpolated value is
 * escaped; there is no client JS, so there is nothing for a hostile viewer
 * to execute against.
 */
export function renderSharePage(data: ShareData): string {
  const steps = data.steps
    .map(
      (s) =>
        `<li><span class="st st-${escapeHtml(s.status)}">${STEP_ICON[s.status] ?? '?'}</span> ` +
        `<b>Step ${s.seq}/${s.total}</b> — ${escapeHtml(s.label)}` +
        (s.resultSummary ? `<br><span class="sum">${escapeHtml(s.resultSummary)}</span>` : '') +
        `</li>`,
    )
    .join('\n');
  const plan = data.plan
    .map((s) => `<li>${escapeHtml(String(s.index))}. ${escapeHtml(s.label)}</li>`)
    .join('\n');
  const checks = data.verification
    .map(
      (c) =>
        `<li><span class="st st-${c.passed ? 'done' : 'failed'}">${c.passed ? '✓' : '✗'}</span> ` +
        `<b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.evidence)}</li>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WAIS — task replay — ${escapeHtml(data.prompt.slice(0, 60))}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#1a1a1a;line-height:1.5}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;background:#e8f0e8;font-size:13px;margin-bottom:12px}
h1{font-size:20px;margin:0 0 4px}.meta{color:#666;font-size:13px;margin-bottom:20px}
h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #eee;padding-bottom:4px}
ul{list-style:none;padding:0}li{margin:6px 0}.st-done{color:#1a7f37}.st-failed{color:#c00}.st-doing{color:#8250df}.st-pending{color:#999}.st-skipped{color:#999}
.sum{color:#555;font-size:13px}.answer{white-space:pre-wrap;background:#f8f8f8;border-radius:8px;padding:12px;font-size:14px}
.empty{color:#999;font-size:13px}
</style>
</head>
<body>
<span class="badge">${escapeHtml(data.status)}</span>
<h1>Task replay</h1>
<div class="meta">WAIS · Started ${escapeHtml(data.startedAt)}${data.finishedAt ? ` · finished ${escapeHtml(data.finishedAt)}` : ''}</div>
<h2>Task</h2>
<p>${escapeHtml(data.prompt)}</p>
<h2>Plan</h2>
${plan ? `<ul>${plan}</ul>` : '<p class="empty">No plan recorded.</p>'}
<h2>Steps</h2>
${steps ? `<ul>${steps}</ul>` : '<p class="empty">No steps recorded.</p>'}
<h2>Verification</h2>
${checks ? `<ul>${checks}</ul>` : '<p class="empty">Nothing checkable — closed as a plain answer.</p>'}
<h2>Final answer</h2>
${data.answer ? `<div class="answer">${escapeHtml(data.answer)}</div>` : '<p class="empty">No answer recorded.</p>'}
<p class="empty" style="margin-top:32px">Created by Awais Ali</p>
</body>
</html>`;
}
