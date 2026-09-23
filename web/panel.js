/* ==========================================================================
   Outputs panel helpers — pure functions only, no DOM, no browser APIs.

   The rule: everything in here must be unit-testable under tsx with zero
   browser globals. The browser-specific wiring (fetching the run, building
   the tabs, the slide-over itself) lives in app.js and calls into these.
   ========================================================================== */

/** The panel's sections, in tab order. */
export const PANEL_SECTIONS = [
  { id: 'files', label: 'Files' },
  { id: 'preview', label: 'Preview' },
  { id: 'plan', label: 'Plan' },
  { id: 'proof', label: 'Proof' },
];

const SECTION_IDS = new Set(PANEL_SECTIONS.map((s) => s.id));

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Which sections have content for a run, in tab order. A section is shown
 * only when the run actually has that content — a run with no files gets no
 * Files tab, and so on.
 * @param {{ artifacts?: any, plan?: any, verification?: any }} [input]
 */
export function visibleSections({ artifacts, plan, verification } = {}) {
  const files = asArray(artifacts);
  const visible = [];
  if (files.length > 0) visible.push('files');
  if (files.some((a) => a && a.previewable)) visible.push('preview');
  if (asArray(plan).length > 0) visible.push('plan');
  if (asArray(verification).length > 0) visible.push('proof');
  return visible;
}

/** The section selected when the panel opens: the first one with content. */
export function defaultSection(visible) {
  const list = asArray(visible);
  return list.length > 0 ? list[0] : null;
}

/** Fresh panel state: closed, no run, no section. */
export function createPanelState() {
  return { open: false, runId: null, section: null };
}

/** Open the panel for a run. The section is chosen once content loads. */
export function openPanelState(state, runId) {
  return { ...(state || {}), open: true, runId: runId ?? null, section: null };
}

/** Close the panel. The run and section stay, so reopening is instant. */
export function closePanelState(state) {
  return { ...(state || {}), open: false };
}

/** Pick a section tab. Unknown ids are ignored — the state is unchanged. */
export function selectPanelSection(state, sectionId) {
  if (!SECTION_IDS.has(sectionId)) return state;
  return { ...(state || {}), section: sectionId };
}
