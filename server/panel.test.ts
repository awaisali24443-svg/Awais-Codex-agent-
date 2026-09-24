import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_DOCK_MIN_WIDTH,
  PANEL_SECTIONS,
  visibleSections,
  defaultSection,
  createPanelState,
  openPanelState,
  closePanelState,
  panelPlacement,
  selectPanelSection,
} from '../web/panel.js';

describe('visibleSections', () => {
  it('shows nothing for an empty run', () => {
    assert.deepEqual(visibleSections({}), []);
    assert.deepEqual(visibleSections(), []);
    assert.deepEqual(visibleSections({ artifacts: [], plan: [], verification: [] }), []);
  });

  it('shows Files when the run produced artifacts', () => {
    const visible = visibleSections({ artifacts: [{ id: 'a', name: 'out.txt', previewable: false }] });
    assert.deepEqual(visible, ['files']);
  });

  it('shows Preview only when an artifact is previewable', () => {
    const withPreview = visibleSections({
      artifacts: [{ id: 'a', name: 'site.html', previewable: true }],
    });
    assert.deepEqual(withPreview, ['files', 'preview']);

    const withoutPreview = visibleSections({
      artifacts: [{ id: 'a', name: 'out.txt', previewable: false }],
    });
    assert.deepEqual(withoutPreview, ['files']);
  });

  it('shows Plan and Proof from the run record', () => {
    const visible = visibleSections({
      plan: [{ index: 1, total: 2, label: 'Do it' }],
      verification: [{ name: 'answer', passed: true, evidence: 'ok' }],
    });
    assert.deepEqual(visible, ['plan', 'proof']);
  });

  it('keeps tab order files, preview, plan, proof', () => {
    const visible = visibleSections({
      verification: [{ name: 'answer', passed: true, evidence: 'ok' }],
      artifacts: [{ id: 'a', name: 'site.html', previewable: true }],
      plan: [{ index: 1, total: 1, label: 'Do it' }],
    });
    assert.deepEqual(visible, ['files', 'preview', 'plan', 'proof']);
  });

  it('ignores non-array inputs', () => {
    assert.deepEqual(visibleSections({ artifacts: 'nope', plan: null, verification: 42 }), []);
  });
});

describe('defaultSection', () => {
  it('picks the first visible section', () => {
    assert.equal(defaultSection(['plan', 'proof']), 'plan');
  });

  it('is null when nothing is visible', () => {
    assert.equal(defaultSection([]), null);
    assert.equal(defaultSection(), null);
  });
});

describe('panel state', () => {
  it('starts closed with no run', () => {
    assert.deepEqual(createPanelState(), { open: false, runId: null, section: null });
  });

  it('opens for a run and closes again', () => {
    const opened = openPanelState(createPanelState(), 'run-1');
    assert.equal(opened.open, true);
    assert.equal(opened.runId, 'run-1');
    const closed = closePanelState(opened);
    assert.equal(closed.open, false);
    // Closing keeps the run, so reopening the same panel is instant.
    assert.equal(closed.runId, 'run-1');
  });

  it('switching runs replaces the run id', () => {
    const opened = openPanelState(openPanelState(createPanelState(), 'run-1'), 'run-2');
    assert.equal(opened.runId, 'run-2');
  });

  it('selects only known sections', () => {
    const opened = openPanelState(createPanelState(), 'run-1');
    const selected = selectPanelSection(opened, 'proof');
    assert.equal(selected.section, 'proof');
    // An unknown id leaves the state untouched — a stale tab click cannot
    // land the panel on a section that does not exist.
    assert.equal(selectPanelSection(selected, 'nope'), selected);
    assert.deepEqual(selectPanelSection(opened, 'nope'), opened);
  });

  it('every section id in PANEL_SECTIONS is selectable', () => {
    const opened = openPanelState(createPanelState(), 'run-1');
    for (const { id } of PANEL_SECTIONS) {
      assert.equal(selectPanelSection(opened, id).section, id);
    }
  });
});

describe('where the panel goes', () => {
  it('a wide window gets a column, a narrow one gets a drawer', () => {
    assert.equal(panelPlacement(1440), 'docked');
    assert.equal(panelPlacement(PANEL_DOCK_MIN_WIDTH), 'docked', 'the threshold itself counts as room');
    assert.equal(panelPlacement(PANEL_DOCK_MIN_WIDTH - 1), 'overlay');
    assert.equal(panelPlacement(390), 'overlay', 'a phone has no room for two columns');
  });

  it('a nonsense width is treated as no room rather than a reason to break', () => {
    // @ts-expect-error the width is a number at the call site; a missing one must not throw at runtime
    assert.equal(panelPlacement(undefined), 'overlay');
    assert.equal(panelPlacement(Number.NaN), 'overlay');
  });
});
