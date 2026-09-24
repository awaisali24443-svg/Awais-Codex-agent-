/**
 * The decision protocol.
 *
 * The engine streams tool calls with their arguments, which says *what* was
 * done and never *why*. Everything else on the trace is narration
 * ("Step 2/3: reading the pricing page") or reasoning, so the choice behind a
 * step is the one thing the model never voices unless it is asked — and it is
 * the thing an operator watching a long task most wants to know.
 *
 * So complex tasks carry one line of extra wire contract: before each tool
 * call, say why. Those lines are lifted out of the prose and become `decision`
 * events on the trace. The *prose* is filtered, not the record — the same rule
 * as the planning protocol, and for the same reason: a decision line repeated
 * in the answer is the agent talking to itself in public.
 *
 * Only `WHY:`. Not "reason:", not "because:" — a loose pattern would eat
 * sentences out of real answers, and this only ever runs on tasks where we
 * asked for the line in the first place.
 */
import { looksComplex } from './planning.js';

const CONTRACT = `[Decision contract — the operator watches your progress live.
Immediately before each tool call, output one line on its own, in exactly this form:
WHY: <one short sentence saying why this step, in your own words>
It is shown to the operator as a decision and removed from your answer. Do not explain this rule.]
`;

/** The prompt with the decision contract prepended, on the wire only. */
export function withDecisions(prompt: string): string {
  return wantsDecisions(prompt) ? CONTRACT + prompt : prompt;
}

/**
 * Whether this task is asked for decision lines: the same gate as the planning
 * protocol, so the two contracts always travel together and a quick question
 * pays for neither.
 */
export function wantsDecisions(prompt: string): boolean {
  return looksComplex(prompt);
}

/**
 * The `WHY:` line, with the markdown emphasis a model likes to add around a
 * label tolerated: `**WHY:**`, `### WHY:`, `> WHY:`.
 */
const DECISION_LINE = /^[\s>*#-]*why[\s>*#]*:[\s>*#]*(\S.*)$/i;

/** The decision inside a line, or null if the line is ordinary prose. */
export function decisionInLine(line: string): string | null {
  const match = DECISION_LINE.exec(String(line ?? ''));
  if (!match) return null;
  return match[1].replace(/[*_`]+$/, '').trim() || null;
}

/**
 * True while a partial line could still turn into a decision.
 *
 * The stream arrives in fragments — "WH", then "Y: searching first" — so the
 * tail of the buffer cannot be released as prose until it is known not to be
 * the start of a decision line. Everything else streams straight through, which
 * is what keeps the panel live.
 */
function couldStartDecision(partial: string): boolean {
  const probe = partial.replace(/^[\s>*#-]+/, '').toLowerCase();
  const target = 'why:';
  if (probe.length >= target.length) return probe.startsWith(target);
  return target.startsWith(probe);
}

/**
 * A line held longer than this is prose, not a decision. Without it, a model
 * that never emits a newline would hold the tail of every answer back.
 */
const MAX_HELD = 400;

export interface DecisionScan {
  /** The part of the chunk that is prose, to append to the answer. */
  text: string;
  /** The decisions found, in order, without their `WHY:` prefix. */
  decisions: string[];
}

/**
 * Splits a stream of answer fragments into prose and decisions.
 *
 * Stateful across chunks on purpose: a decision line can be split anywhere,
 * including between the `W` and the `H`.
 */
export class DecisionScanner {
  private buffer = '';

  push(chunk: string): DecisionScan {
    this.buffer += chunk;
    const decisions: string[] = [];
    let text = '';

    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const decision = decisionInLine(line);
      if (decision) decisions.push(decision);
      else text += `${line}\n`;
    }

    // The tail is released as prose unless it could still become a decision,
    // and never held past MAX_HELD.
    if (this.buffer && (!couldStartDecision(this.buffer) || this.buffer.length > MAX_HELD)) {
      text += this.buffer;
      this.buffer = '';
    }

    return { text, decisions };
  }

  /** Whatever is left when the stream ends. */
  finish(): DecisionScan {
    const rest = this.buffer;
    this.buffer = '';
    const decision = decisionInLine(rest);
    if (decision) return { text: '', decisions: [decision] };
    return { text: rest, decisions: [] };
  }
}

/**
 * The same rule applied to a complete text, for the engine's authoritative
 * answer — which arrives as one string and is what actually gets stored and
 * shown. Idempotent, so it is safe at every reconciliation point.
 *
 * The engine's copy is not the stream: it concatenates what it wrote, so a
 * reason the model forgot to put on its own line arrives glued to the end of
 * the previous sentence ("Reading it through. WHY: the prices change weekly").
 * The scanner never saw it that way — it saw the line — so the *known*
 * decisions are passed in and removed by exact text, wherever they sit.
 *
 * That is deliberately not a pattern hunt for `why:`. A reason the model really
 * gave is literal text we hold; anything else that looks like one is prose, and
 * prose is never cut on a guess.
 */
export function stripDecisions(text: string, known: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const kept = text.split('\n').filter((line) => decisionInLine(line) === null);
  let out = kept.join('\n');
  for (const decision of known) {
    const needle = decision.trim();
    if (!needle) continue;
    out = out.replace(new RegExp(`\\s*WHY\\s*:\\s*${escapeRegExp(needle)}`, 'gi'), '');
  }
  // Collapse the blank runs the removed lines leave behind.
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

/** A literal, for building a pattern out of text the model wrote. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
