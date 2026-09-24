/* Mission-step timeline helpers: pure functions mapping step data to the
   Manus-style timeline rendering. DOM wiring stays in web/app.js; everything
   here is testable without a browser. */

/**
 * `note` is the one status that claims nothing: an engine's own line about what
 * it is doing has no outcome to report, and rendering it as `done` (which is
 * what the client did) put a green check next to "Still thinking — retrying the
 * request." A retry is not an accomplishment.
 */
export const STEP_STATUSES = ['running', 'done', 'skipped', 'failed', 'note'];

/**
 * Derive a timeline status from the options a step was drawn with. An
 * explicit status always wins; otherwise `done` means done, a warning icon
 * means failed, and a fresh step is still running.
 * @param {{ done?: boolean, icon?: string, status?: string | null }} opts
 */
export function statusForStep({ done = false, icon = '', status = null } = {}) {
  if (status && STEP_STATUSES.includes(status)) return status;
  if (done) return 'done';
  if (icon === 'warn') return 'failed';
  if (icon === 'dash') return 'skipped';
  return 'running';
}

/**
 * The node glyph for a status: a spinner while running, a check when done,
 * a dash when skipped, a cross when failed. Names match the ICONS table in
 * web/app.js ('spinner' is drawn with CSS, not an icon).
 * @param {string} status
 */
export function nodeIconForStatus(status) {
  switch (status) {
    case 'done': return 'check';
    case 'skipped': return 'dash';
    case 'failed': return 'cross';
    case 'note': return 'info';
    default: return 'spinner';
  }
}

/** True when the step may carry a detail line the operator can expand. */
export function hasExpandableDetail(detail) {
  return typeof detail === 'string' && detail.length > 0;
}

/**
 * Short local timestamp for a step node, e.g. "14:32". Defaults to now —
 * steps are timestamped when drawn, both live and on replay.
 * @param {number} [ts]
 */
export function formatStepTime(ts = Date.now()) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The planning protocol, as it appears in the agent's own text.
 *
 * `withPlanning()` asks the agent to announce "Step 1/N: ..." and
 * "Step k/N done: ..." lines, and the executor turns each one into a
 * `plan.milestone` event — the checklist the operator watches. The agent also
 * leaves those same lines in the prose it writes, and an answer drawn straight
 * from that text therefore opens with its own table of contents: raw protocol
 * lines above the actual reply.
 *
 * So the prose is filtered, not the record: the milestones are already on
 * screen in the timeline, and repeating them in the answer is noise. Only
 * lines that match the protocol exactly are dropped — a sentence that merely
 * begins with the word "step" survives.
 */
const MILESTONE_LINE = /^\s*step\s+\d+\s*\/\s*\d+\s*(?:done\s*)?[:.\u2014-]?\s*.*$/i;

/** True when a line is a planning-protocol announcement, not prose. */
export function isMilestoneLine(line) {
  return MILESTONE_LINE.test(String(line ?? ''));
}

/**
 * The agent's answer with its planning protocol lines removed.
 *
 * Also drops an echoed copy of the protocol block itself ("[Planning protocol —
 * ...]"), which a chatty model occasionally repeats back before answering.
 */
export function stripMilestones(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const kept = [];
  let inProtocolEcho = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[Planning protocol/i.test(line)) {
      inProtocolEcho = true;
      continue;
    }
    if (inProtocolEcho) {
      // The block runs to the blank line that follows it; its own lines are
      // skipped whole, including the "Step k/N done: ..." template inside.
      if (line.trim() === '') {
        inProtocolEcho = false;
        continue;
      }
      if (/^\s*(\[|step\s+(?:\d+|k)\b)/i.test(line)) continue;
      inProtocolEcho = false;
    }
    if (isMilestoneLine(line)) continue;
    kept.push(line);
  }
  // Collapse the blank runs the removed lines leave behind.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------- the trace ---
   What the model is thinking, as rows rather than as one growing paragraph.

   The panel used to append every fragment to a single text node, so three
   minutes of thinking was one wall of prose that the eye could not follow and
   the scroll could not keep. The stream arrives in fragments, so the rows are
   cut from a growing tail: a newline ends a row, and a row that runs long is
   broken at a sentence — never mid-word unless there is no sentence to break
   at. Nothing is ever dropped: every character ends up in a row or stays in
   the tail.
   */

/** The two kinds of row the trace stream produces. */
export const TRACE_KINDS = ['thought', 'decision'];

/**
 * Cut every complete row out of a growing tail.
 *
 * @param {string} tail  everything received so far that is not yet a row
 * @param {{ max?: number, sentence?: number }} [opts]
 * @returns {{ rows: string[], tail: string }}
 */
export function takeTraceRows(tail, { max = 220, sentence = 90 } = {}) {
  const rows = [];
  let rest = String(tail ?? '');
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline !== -1) {
      const row = rest.slice(0, newline).trim();
      rest = rest.slice(newline + 1);
      if (row) rows.push(row);
      continue;
    }
    if (rest.length > max) {
      const cut = sentenceBreak(rest, sentence, max);
      const row = rest.slice(0, cut).trim();
      if (row) rows.push(row);
      rest = rest.slice(cut);
      continue;
    }
    break;
  }
  return { rows, tail: rest };
}

/**
 * Where a long line breaks: at the last sentence end between `min` and a little
 * past `max`, or at `max` itself when the text has no sentence in it (a URL, a
 * wall of words, a language that does not use spaces).
 */
function sentenceBreak(text, min, max) {
  const limit = Math.min(text.length, Math.round(max * 1.3));
  for (let i = limit - 1; i >= min; i--) {
    const ch = text[i];
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '\u2026') && /\s/.test(text[i + 1] ?? '')) {
      return i + 1;
    }
  }
  return Math.min(max, text.length);
}

/**
 * What the panel head calls the thing it is showing.
 *
 * `reasoning` is the model's own thinking, when the backend exposes it;
 * everything else is the agent narrating what it is doing. Calling the second
 * one "Reasoning" would be a nicer lie than the truth, and the operator would
 * have no way to tell the difference.
 */
export function thinkingLabel(kind) {
  return kind === 'reasoning' ? 'Reasoning' : "What it's doing";
}

/**
 * How long after the task started a row happened, e.g. "+12s", "+2m04s".
 * On a trace that is read top to bottom, "before/after" is the useful fact —
 * the wall clock is already on every step node.
 * @param {number} ms
 */
export function formatElapsedShort(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `+${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `+${minutes}m${seconds}s`;
}

/**
 * The frame queue behind the Raw switch, bounded.
 *
 * A long run emits thousands of events and a phone has one screen. The queue
 * keeps the newest frames and counts what it threw away, so the panel can say
 * "showing the last 300 of 1,842" rather than either melting or lying.
 */
export function pushFrame(queue, frame, cap = 300) {
  const next = [...queue, frame];
  const overflow = Math.max(0, next.length - cap);
  return { frames: next.slice(overflow), overflow };
}

/**
 * Silence, in words: "45s" from the engine's own heartbeat line.
 *
 * The heartbeat is the only signal during a long think, and it carries the one
 * number that says whether the wait is normal — how long the model has been
 * quiet.
 * @param {string} message
 */
export function quietSeconds(message) {
  const match = /(\d+)s\s+in\b/.exec(String(message ?? ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * A span of time as the operator would say it: "12s", "2m 04s", "1h 07m".
 * Seconds are only spelled out under a minute; past that they are noise.
 * @param {number} seconds
 */
export function elapsedWords(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * The line above an empty panel: what the task is doing, for how long, and
 * whether the model has gone quiet.
 *
 * Before this the panel said one sentence and never changed, so a task that was
 * thinking normally and a task that was stuck read exactly the same. Three
 * facts, one line, and it is the *absence* of the last one that says the model
 * is talking.
 *
 * @param {{ phase?: string | null, seconds?: number, quiet?: number | null }} state
 */
export function waitLine({ phase = null, seconds = 0, quiet = null } = {}) {
  const parts = [phase || 'Working', elapsedWords(seconds)];
  if (typeof quiet === 'number') parts.push(`the model has been quiet for ${elapsedWords(quiet)}`);
  else parts.push('nothing has come back from the model yet');
  return parts.join(' · ');
}
