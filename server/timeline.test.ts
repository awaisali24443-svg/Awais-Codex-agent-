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
  takeTraceRows,
  thinkingLabel,
  formatElapsedShort,
  pushFrame,
} from '../web/timeline.js';

describe('a warning is not an accomplishment', () => {
  it('a note claims nothing, and is not a tick', () => {
    // The engine says "Still thinking — retrying the request." and the client
    // rendered it as a completed step: a green check next to a retry, in the
    // screenshot that started this. A note carries no outcome.
    assert.equal(statusForStep({ status: 'note' }), 'note');
    assert.equal(nodeIconForStatus('note'), 'info');
    assert.equal(nodeIconForStatus('done'), 'check');
    // And a warn line no longer becomes `done` by accident of ordering.
    assert.notEqual(statusForStep({ icon: 'warn', status: 'note' }), 'done');
    assert.equal(statusForStep({ icon: 'warn' }), 'failed', 'a plain warning still reads as a problem');
  });
});

describe('step status derivation', () => {
  it('knows the five timeline statuses', () => {
    // `note` joined the list when a retry warning was being drawn as a green
    // tick: an engine's line about what it is doing has no outcome to report.
    assert.deepEqual([...STEP_STATUSES].sort(), ['done', 'failed', 'note', 'running', 'skipped']);
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

describe('the trace is rows, not one paragraph', () => {
  it('every character survives being cut into rows, in order', () => {
    // The invariant that matters: a fragment split anywhere must not lose or
    // reorder a single character on the way to the screen.
    const text = [
      'Reading the brief now. ',
      'It names three prices, so the pricing page is the place to start. ',
      'Nothing about the guide yet, so I will come back to that. ',
      'The render check can wait until the page exists — it is the last thing ',
      'the brief asks for, and doing it early would only mean doing it twice. ',
      'So: read, build, then check.',
    ].join('');
    let tail = '';
    const rows = [];
    for (let i = 0; i < text.length; i += 7) {
      tail += text.slice(i, i + 7);
      const out = takeTraceRows(tail);
      rows.push(...out.rows);
      tail = out.tail;
    }
    const rebuilt = (rows.join('') + tail).replace(/\s+/g, ' ').trim();
    assert.equal(rebuilt, text.replace(/\s+/g, ' ').trim());
    assert.ok(rows.length >= 1, `long text became rows, not one blob (${rows.length})`);
    assert.ok(tail.length <= 240, `and the live tail stays bounded (${tail.length})`);
  });

  it('a newline ends a row', () => {
    const { rows, tail } = takeTraceRows('first thought\nsecond thought\nstill going');
    assert.deepEqual(rows, ['first thought', 'second thought']);
    assert.equal(tail, 'still going');
  });

  it('a long line breaks at a sentence, and the tail stays small', () => {
    const line = `${'a'.repeat(95)}. ${'b'.repeat(95)}. ${'c'.repeat(30)}`;
    const { rows, tail } = takeTraceRows(line);
    assert.equal(rows.length, 1, 'one row cut so far');
    assert.ok(rows[0].endsWith('.'), `cut at a sentence, not mid-word: ${rows[0].slice(-40)}`);
    assert.ok(rows[0].length < 200, 'and the row is readable');
    assert.ok(tail.length > 0, 'the rest waits in the tail');
  });

  it('a line with no sentence in it is cut anyway — nothing is held forever', () => {
    const url = 'https://example.com/' + 'x'.repeat(400);
    const { rows, tail } = takeTraceRows(url);
    assert.equal(rows.length, 1, 'cut at the cap rather than held');
    assert.ok(rows[0].length <= 220, 'a row is never longer than the cap');
    assert.equal(rows[0].length + tail.length, url.length, 'no character lost');
  });

  it('blank rows are not rows', () => {
    const { rows } = takeTraceRows('one\n\n\ntwo\n');
    assert.deepEqual(rows, ['one', 'two']);
  });
});

describe('the panel says what it is showing', () => {
  it('reasoning is reasoning, and narration is not dressed up as it', () => {
    assert.equal(thinkingLabel('reasoning'), 'Reasoning');
    assert.equal(thinkingLabel('narration'), "What it's doing");
    assert.equal(thinkingLabel(undefined), "What it's doing");
  });

  it('a row says how far into the task it happened', () => {
    assert.equal(formatElapsedShort(0), '+0s');
    assert.equal(formatElapsedShort(12_400), '+12s');
    assert.equal(formatElapsedShort(124_000), '+2m04s');
    assert.equal(formatElapsedShort(-5), '+0s');
  });
});

describe('the raw frame queue', () => {
  it('keeps the newest frames and counts what it dropped', () => {
    let queue = [];
    let dropped = 0;
    for (let i = 1; i <= 10; i++) {
      const next = pushFrame(queue, { i }, 3);
      queue = next.frames;
      // The counter is the caller's, so the number can be reported as a total
      // ("showing the last 300 of 1,842") rather than per frame.
      dropped += next.overflow;
    }
    assert.deepEqual(queue.map((f) => f.i), [8, 9, 10], 'the newest three');
    assert.equal(dropped, 7, 'and it knows how many went');
  });
});
