/**
 * Planning support for complex missions.
 *
 * The engine is a managed agent: it does its own reasoning, and this server
 * cannot see a plan unless the agent says it out loud. So planning support is
 * a small contract on the wire plus a parser on the way back:
 *
 *   OUT  `withPlanning(prompt)` — when the mission looks complex, prepend a
 *        protocol asking the agent to announce its plan as numbered progress
 *        lines ("Step 1/N: ...") and each completion ("Step k/N done: ...").
 *        The operator's stored prompt is never rewritten; only the text sent
 *        to the model carries the contract.
 *
 *   IN   `parseMilestone(message)` — the executor runs every `log` line
 *        through this. A line matching the protocol becomes a durable
 *        `plan.milestone` event, which the PWA renders as a checklist. If the
 *        agent ignores the protocol, nothing breaks: no milestones, no plan,
 *        the mission is exactly as it was.
 *
 * The complexity heuristic is deliberately conservative. A short question must
 * never pay the token cost of a planning preamble or have its answer shaped
 * by instructions it did not need.
 */

export interface Milestone {
  index: number;
  total: number;
  label: string;
  done: boolean;
}

/** A mission is "complex" when it is long, multi-part, or asks to build. */
export function looksComplex(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (text.length >= 600) return true;

  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length >= 4) return true;

  const items = text.match(/^\s*(?:\d{1,2}[.)]|[-*•])\s+\S/gm);
  if (items && items.length >= 2) return true;

  if (
    text.length >= 200 &&
    /\b(build|create|develop|implement|design|research|compare|analyse|analyze|migrate|refactor|deploy|step[- ]by[- ]step|first[,.]?\s+then)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

const CONTRACT = `[Planning protocol — this mission is complex, so work in visible steps.
First, write your plan as numbered progress lines, one step per line, in the exact form:
Step 1/N: <what this step does>
Step 2/N: <what this step does>
Then, as you finish each step, announce it on its own line in the exact form:
Step k/N done: <one-line outcome>
Keep each line short — the operator follows your progress live on a phone.]

`;

/** Prepend the planning contract on the wire only, when the mission is complex. */
export function withPlanning(prompt: string): string {
  return looksComplex(prompt) ? CONTRACT + prompt : prompt;
}

/**
 * Wire-only LinkedIn publishing convention, added only when the operator's
 * own message is about LinkedIn. The agent is remote — it cannot call our
 * server — so "publish this" ends as a fenced draft the server files as
 * pending, and the operator taps Publish. Never claims it posted: publishing
 * always needs the operator's tap.
 */
const LINKEDIN_RE = /linked\s?in/i;
const LINKEDIN_CONTRACT = `[If the operator wants this published on LinkedIn: write the post as plain
text — no markdown, no asterisks — then put the exact final text in a fenced
block at the very end of your answer:
\`\`\`linkedin-post
<the post text>
\`\`\`
That block becomes a one-tap Publish draft. Never say you published it —
publishing needs the operator's tap.]

`;

export function withLinkedIn(prompt: string): string {
  return LINKEDIN_RE.test(prompt) ? LINKEDIN_CONTRACT + prompt : prompt;
}

const MILESTONE_RE = /^step\s+(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})\s*(done)?\s*[:\-–—]?\s*(.*)$/i;

/**
 * Parse one progress line into a milestone, or null when the line is not one.
 *
 * Anchored at the line start and bounded (no step 99/100 nonsense), so a
 * sentence that merely mentions "step 2 of the process" does not become a
 * checklist item.
 */
export function parseMilestone(message: string): Milestone | null {
  const match = MILESTONE_RE.exec(message.trim());
  if (!match) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total || total > 20) return null;
  return {
    index,
    total,
    label: match[4].trim().slice(0, 140),
    done: match[3] !== undefined,
  };
}
