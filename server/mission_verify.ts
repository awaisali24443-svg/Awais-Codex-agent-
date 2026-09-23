/**
 * Prove-it's-done: a verifier step that runs before a mission is marked done.
 *
 * The agent says it finished; this module re-checks the claim against the
 * durable record instead of taking its word for it. Every check is
 * deterministic — database rows and the final text, never another engine
 * call — so verification costs nothing extra and can never blow the token
 * budget.
 *
 * What is checked, for missions that have anything checkable (a plan with
 * steps, or announced output files):
 *   1. `answer` — the mission produced a non-empty answer.
 *   2. `steps` — every announced step reached `done` (or `skipped`).
 *   3. `artifacts` — every announced file is recorded, and any file already
 *      materialized onto this disk is still there and non-empty.
 *
 * A simple chat answer with no steps and no artifacts has nothing to check:
 * verification is skipped (empty check list), and the run closes exactly as
 * before. A run with failed checks is failed with error_type
 * 'verification_failed' — never silently marked done.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Db } from './db.js';
import { artifactsRoot, listArtifacts } from './artifacts.js';
import { getMissionSteps } from './mission_steps.js';

export interface VerificationCheck {
  /** Short machine name: 'answer' | 'steps' | 'artifacts'. */
  name: string;
  passed: boolean;
  /** One line of evidence a human can act on. */
  evidence: string;
}

/** Parse the stored checks defensively: a corrupt value is no checks, not a crash. */
export function parseVerification(value: unknown): VerificationCheck[] | null {
  if (!Array.isArray(value)) return null;
  const checks = value
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      name: String(c.name ?? '').slice(0, 40),
      passed: c.passed === true,
      evidence: String(c.evidence ?? '').slice(0, 300),
    }))
    .filter((c) => c.name.length > 0);
  return checks.length ? checks : null;
}

/**
 * Run the deterministic checks for a finished mission.
 *
 * Returns an empty list when there is nothing checkable (no steps, no
 * artifacts) — the caller treats that as "skipped", not failure. Never
 * throws: a verifier that crashes must not take the mission down with it;
 * the executor degrades a throw to "skipped" and logs it.
 */
export async function verifyMission(
  db: Db,
  runId: string,
  finalText: string,
): Promise<VerificationCheck[]> {
  const [artifacts, steps] = await Promise.all([
    listArtifacts(db, runId),
    getMissionSteps(db, runId),
  ]);

  if (artifacts.length === 0 && steps.length === 0) return [];

  const checks: VerificationCheck[] = [];

  const chars = finalText.trim().length;
  checks.push({
    name: 'answer',
    passed: chars > 0,
    evidence:
      chars > 0 ? `answer produced (${chars} chars)` : 'the agent finished with no answer',
  });

  if (steps.length > 0) {
    const unfinished = steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
    checks.push({
      name: 'steps',
      passed: unfinished.length === 0,
      evidence:
        unfinished.length === 0
          ? `${steps.length}/${steps.length} steps done`
          : `${unfinished.length} of ${steps.length} step(s) not finished: ${unfinished
              .map((s) => `step ${s.seq} (${s.status})`)
              .join(', ')}`,
    });
  }

  if (artifacts.length > 0) {
    // Only what is already on this disk can be proven without a sandbox
    // download (materialization pulls the whole environment archive — far too
    // expensive for a pre-close check). An announced-but-not-yet-materialized
    // file is recorded as announced; its bytes are verified when downloaded.
    const missing: string[] = [];
    for (const artifact of artifacts) {
      if (!artifact.storageKey) continue;
      try {
        if (fs.statSync(path.join(artifactsRoot(), artifact.storageKey)).size === 0) {
          missing.push(artifact.name);
        }
      } catch {
        missing.push(artifact.name);
      }
    }
    checks.push({
      name: 'artifacts',
      passed: missing.length === 0,
      evidence:
        missing.length === 0
          ? `${artifacts.length} file(s) announced: ${artifacts.map((a) => a.name).join(', ')}`
          : `missing on disk: ${missing.join(', ')}`,
    });
  }

  return checks;
}

/**
 * True when verification ran and every check passed. An empty list means
 * "skipped — nothing checkable", which is neither a pass nor a failure; the
 * caller decides what skipped means.
 */
export function verificationPassed(checks: VerificationCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed);
}
