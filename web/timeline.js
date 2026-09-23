/* Mission-step timeline helpers: pure functions mapping step data to the
   Manus-style timeline rendering. DOM wiring stays in web/app.js; everything
   here is testable without a browser. */

export const STEP_STATUSES = ['running', 'done', 'skipped', 'failed'];

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
