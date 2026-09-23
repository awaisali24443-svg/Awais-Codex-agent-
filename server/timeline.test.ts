import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_STATUSES,
  statusForStep,
  nodeIconForStatus,
  hasExpandableDetail,
  formatStepTime,
} from '../web/timeline.js';

describe('step status derivation', () => {
  it('knows the four timeline statuses', () => {
    assert.deepEqual([...STEP_STATUSES].sort(), ['done', 'failed', 'running', 'skipped']);
  });

  it('derives done from the done flag', () => {
    assert.equal(statusForStep({ done: true }), 'done');
    assert.equal(statusForStep({ done: true, icon: 'warn' }), 'done');
  });

  it('derives failed from a warning icon', () => {
    assert.equal(statusForStep({ icon: 'warn' }), 'failed');
  });

  it('derives skipped from a dash icon', () => {
    assert.equal(statusForStep({ icon: 'dash' }), 'skipped');
  });

  it('defaults a fresh step to running', () => {
    assert.equal(statusForStep({}), 'running');
    assert.equal(statusForStep({ icon: 'terminal' }), 'running');
  });

  it('lets an explicit status win over every flag', () => {
    assert.equal(statusForStep({ done: true, icon: 'warn', status: 'failed' }), 'failed');
    assert.equal(statusForStep({ status: 'skipped' }), 'skipped');
  });

  it('ignores an unknown explicit status', () => {
    assert.equal(statusForStep({ status: 'zzz' }), 'running');
  });
});

describe('node glyphs', () => {
  it('maps each status to its node glyph', () => {
    assert.equal(nodeIconForStatus('running'), 'spinner');
    assert.equal(nodeIconForStatus('done'), 'check');
    assert.equal(nodeIconForStatus('skipped'), 'dash');
    assert.equal(nodeIconForStatus('failed'), 'cross');
  });

  it('falls back to the spinner for unknown statuses', () => {
    assert.equal(nodeIconForStatus('zzz'), 'spinner');
  });
});

describe('detail and time', () => {
  it('detects expandable details', () => {
    assert.equal(hasExpandableDetail('some args'), true);
    assert.equal(hasExpandableDetail(''), false);
    assert.equal(hasExpandableDetail(undefined), false);
  });

  it('formats a step time as HH:MM', () => {
    const t = formatStepTime(new Date(2026, 8, 23, 14, 5, 0).getTime());
    assert.match(t, /^\d{2}:\d{2}$/);
    assert.equal(t, '14:05');
  });

  it('defaults to now', () => {
    assert.match(formatStepTime(), /^\d{2}:\d{2}$/);
  });
});
