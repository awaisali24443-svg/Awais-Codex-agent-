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
    .map((s) => `<li><span class="label">${escapeHtml(String(s.index))}. ${escapeHtml(s.label)}</span></li>`)
    .join('\n');
  const checks = data.verification
    .map(
      (c) =>
        `<li><span class="st st-${c.passed ? 'done' : 'failed'}">${c.passed ? '✓' : '✗'}</span> ` +
        `<span class="label"><b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.evidence)}</span></li>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WAIS — task replay — ${escapeHtml(data.prompt.slice(0, 60))}</title>
<style>
/* The replay wears the app's own clothes: the same warm paper, the same warm
   terracotta accent, the same card language. No web fonts, no icon CDN — a
   shared link is often opened on a metered phone by someone who is not the
   operator, so the page has to be instant and complete on its own. */
:root{--paper:#f5f3ef;--surface:#fff;--surface-2:#eceae4;--ink:#1b1a18;--ink-soft:#45423c;--muted:#8b857a;--line:#e4e0d7;--line-soft:#efebe3;--accent:#c2613e;--ok:#2e7d52;--danger:#b3261e}
@media (prefers-color-scheme: dark){:root{--paper:#201e1b;--surface:#2b2925;--surface-2:#38352f;--ink:#ede9df;--ink-soft:#cfc8b9;--muted:#a29b8c;--line:#45413a;--line-soft:#35322c;--accent:#d97757;--ok:#6fbf8f;--danger:#e0786e}}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--paper);color:var(--ink);line-height:1.6;margin:0;padding:28px 18px calc(40px + env(safe-area-inset-bottom))}
main{max-width:680px;margin:0 auto}
.mark{width:34px;height:34px;border-radius:10px;vertical-align:-9px;margin-right:9px}
.brand{display:flex;align-items:center;gap:2px;font-size:19px;font-weight:600;letter-spacing:.01em;margin-bottom:26px}
.badge{display:inline-block;padding:3px 11px;border-radius:999px;background:var(--surface-2);color:var(--ink-soft);font-size:12.5px;letter-spacing:.03em;text-transform:uppercase}
h1{font-size:26px;line-height:1.25;margin:14px 0 6px;font-weight:600;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:13px;margin-bottom:26px}
h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:500;margin:26px 0 10px}
.card{border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}
ul{list-style:none;padding:0;margin:0}
li{display:flex;gap:10px;align-items:baseline;padding:10px 14px;border-top:1px solid var(--line-soft);font-size:14px}
li:first-child{border-top:none}
.st{flex:none;width:16px;text-align:center}.st-done{color:var(--ok)}.st-failed{color:var(--danger)}.st-doing{color:var(--accent)}.st-pending{color:var(--muted)}.st-skipped{color:var(--muted)}
.label{flex:1;min-width:0}.sum{color:var(--muted);font-size:12.5px}
.answer{white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;font-size:15px}
.empty{color:var(--muted);font-size:13px}
.task{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:13px 15px;font-size:15px}
footer{color:var(--muted);font-size:12.5px;margin-top:34px}
</style>
</head>
<body>
<main>
<div class="brand">
  <svg class="mark" viewBox="0 0 100 100" aria-hidden="true">
    <rect width="100" height="100" rx="26" fill="#1c1a2c"/>
    <path d="M22.5 43 35.5 74.5 50 52.5 64.5 74.5 77.5 43" fill="none" stroke="#f6f2ea"
          stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  WAIS
</div>
<span class="badge">${escapeHtml(data.status)}</span>
<h1>Task replay</h1>
<div class="meta">Started ${escapeHtml(data.startedAt)}${data.finishedAt ? ` · finished ${escapeHtml(data.finishedAt)}` : ''}</div>
<h2>What was asked</h2>
<div class="task">${escapeHtml(data.prompt)}</div>
${plan ? `<h2>Plan</h2><div class="card"><ul>${plan}</ul></div>` : ''}
${steps ? `<h2>What it did</h2><div class="card"><ul>${steps}</ul></div>` : ''}
${checks ? `<h2>Checks</h2><div class="card"><ul>${checks}</ul></div>` : ''}
<h2>The answer</h2>
${data.answer ? `<div class="answer">${escapeHtml(data.answer)}</div>` : '<p class="empty">No answer recorded.</p>'}
<footer>Created by Awais Ali</footer>
</main>
</body>
</html>`;
}
