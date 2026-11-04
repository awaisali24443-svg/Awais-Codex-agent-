/**
 * Run-closure verification (ECC pilot Phase 3a, from ECC's verification-loop).
 *
 * `mission_verify.ts` checks WHAT a mission produced. This module checks the
 * closure itself — the facts that must hold in the durable record at the
 * moment a run is called finished:
 *
 *   1. `terminal_status` — the run's status is terminal, not still active.
 *   2. `terminal_event` — the matching `run.<status>` event is in the log.
 *      The SSE stream's drain-then-close contract ("status is terminal
 *      implies the whole log is readable") is only true if this holds.
 *   3. `sources_recorded` — when the final text cited URLs, a
 *      `sources.checked` event was recorded (the executor runs the source
 *      check before closing; this proves it landed).
 *   4. `no_orphan` — the run no longer holds the single-active slot. A
 *      closed run that still reads as active wedges every future mission.
 *
 * Deterministic only — database reads, never an engine call. Existence of
 * events is checked with targeted queries, never a full-log scan: a long
 * mission's log can hold more events than any sane scan window, and the
 * events this module looks for are the LAST ones written.
 *
 * Fallible by design: a database error throws, and the executor (the only
 * caller) wraps the call and degrades it to a log line — a verifier must
 * not be able to take a finished mission down with it. The verdict is
 * stored evidence (a durable event in the run's log, readable on refresh);
 * the live SSE stream closes on the terminal event itself, by design.
 */
import type { Db } from './db.js';
import { getActiveRun, getRun, TERMINAL_STATUSES } from './runs.js';
import type { VerificationCheck } from './mission_verify.js';

/** Targeted existence check for one event type in a run's log. */
async function eventExists(db: Db, runId: string, type: string): Promise<boolean> {
  const rows = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM run_events WHERE run_id = $1 AND type = $2`,
    [runId, type],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function verifyRunClosure(
  db: Db,
  runId: string,
  opts: { hadUrls: boolean },
): Promise<VerificationCheck[]> {
  const run = await getRun(db, runId);
  if (!run) {
    return [
      {
        name: 'terminal_status',
        passed: false,
        evidence: `run ${runId} no longer exists`,
      },
    ];
  }

  const checks: VerificationCheck[] = [];

  const isTerminal = TERMINAL_STATUSES.includes(run.status);
  checks.push({
    name: 'terminal_status',
    passed: isTerminal,
    evidence: isTerminal ? `run closed as ${run.status}` : `run is still ${run.status}`,
  });

  const terminalType = `run.${run.status}`;
  const hasTerminalEvent = isTerminal && (await eventExists(db, runId, terminalType));
  checks.push({
    name: 'terminal_event',
    passed: hasTerminalEvent,
    evidence: hasTerminalEvent
      ? `${terminalType} is recorded in the event log`
      : `no ${terminalType} event in the log — a reconnecting stream cannot prove this run ended`,
  });

  if (opts.hadUrls) {
    const hasSources = await eventExists(db, runId, 'sources.checked');
    checks.push({
      name: 'sources_recorded',
      passed: hasSources,
      evidence: hasSources
        ? 'sources.checked recorded for the cited answer'
        : 'the final text cited URLs but no sources.checked event was recorded',
    });
  }

  const active = await getActiveRun(db);
  const stillActive = active?.id === runId;
  checks.push({
    name: 'no_orphan',
    passed: !stillActive,
    evidence: stillActive
      ? 'the closed run still holds the single-active slot'
      : 'the run no longer holds the single-active slot',
  });

  return checks;
}
