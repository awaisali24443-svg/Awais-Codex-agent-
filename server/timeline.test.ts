import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_STATUSES,
  statusForStep,
  nodeIconForStatus,
  hasExpandableDetail,
  formatStepTime,
  isMilestoneLine,
  stripMilestones,
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

describe('plan-protocol lines are kept out of the answer', () => {
  it('recognises a step announcement', () => {
    assert.equal(isMilestoneLine('Step 1/1: Greet the operator and request the mission instructions.'), true);
    assert.equal(isMilestoneLine('Step 12/14 done: shipped'), true);
    assert.equal(isMilestoneLine('  Step 3/3 - rebuilt the page'), true);
  });

  it('leaves ordinary prose alone', () => {
    assert.equal(isMilestoneLine('Stepping through the code now'), false);
    assert.equal(isMilestoneLine('The first step is to install it'), false);
    assert.equal(isMilestoneLine('Step 1 of 3 steps is done: here is the summary.'), false);
    assert.equal(isMilestoneLine(''), false);
  });

  it('drops the announcements and keeps the reply', () => {
    // The exact shape from the phone: the agent narrated its plan, then greeted
    // the operator — and the greeting was buried under its own table of contents.
    const answer = [
      'Step 1/1: Greet the operator and request the mission instructions.',
      'Step 1/1 done: Greeted the operator and requested mission details.',
      '',
      'Hello! I am ready to help. Please provide the details or instructions for your mission so we can get started.',
    ].join('\n');
    assert.equal(
      stripMilestones(answer),
      'Hello! I am ready to help. Please provide the details or instructions for your mission so we can get started.',
    );
  });

  it('drops an echoed protocol block', () => {
    const echoed = [
      '[Planning protocol — work in visible steps.',
      'Step k/N done: <one-line outcome>]',
      '',
      'Here is the answer you asked for.',
    ].join('\n');
    assert.equal(stripMilestones(echoed), 'Here is the answer you asked for.');
  });

  it('is a no-op on an answer that never had a plan', () => {
    const prose = 'Two things to fix:\n\n1. the first\n2. the second';
    assert.equal(stripMilestones(prose), prose);
  });

  it('tolerates empty and non-string input', () => {
    assert.equal(stripMilestones(''), '');
    assert.equal(stripMilestones(undefined), '');
    assert.equal(stripMilestones(null), '');
  });
});
