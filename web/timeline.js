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
