/**
 * The decision protocol, tested where it actually bites: the middle of a
 * stream.
 *
 * The model writes a `WHY:` line before each tool call, and those fragments
 * arrive split wherever the transport felt like splitting them — including
 * between the `W` and the `H`. The line must leave the answer, land on the
 * trace as its own row, and never take a real sentence with it.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { DecisionScanner, decisionInLine, stripDecisions, wantsDecisions, withDecisions } from './decisions.js';

const COMPLEX_PROMPT = [
  'Build me a small landing page for the shop.',
  '- it should load fast on a phone',
  '- include the three prices',
  '- link to the guide',
  'Take your time and check it renders before you finish.',
].join('\n');

/** Feed fragments through a scanner and collect what came out. */
function scan(...chunks: string[]): { text: string; decisions: string[] } {
  const scanner = new DecisionScanner();
  let text = '';
  const decisions: string[] = [];
  for (const chunk of chunks) {
    const out = scanner.push(chunk);
    text += out.text;
    decisions.push(...out.decisions);
  }
  const end = scanner.finish();
  text += end.text;
  decisions.push(...end.decisions);
  return { text, decisions };
}

describe('who gets asked for decisions', () => {
  test('the complex tasks, and only those', () => {
    // The same gate as the planning contract: a quick question pays for
    // neither, and the two always travel together.
    assert.equal(wantsDecisions('what is the capital of Pakistan'), false);
    assert.equal(wantsDecisions(COMPLEX_PROMPT), true);
    assert.equal(wantsDecisions(''), false);
  });

  test('a simple task gets its prompt back untouched — the identical string', () => {
    const simple = 'summarise this in three lines';
    assert.equal(withDecisions(simple), simple);
  });

  test('a complex task is told the exact form of the line', () => {
    const wrapped = withDecisions(COMPLEX_PROMPT);
    assert.ok(wrapped.includes('WHY: <one short sentence saying why this step'), 'the form is spelled out');
    assert.ok(wrapped.includes('removed from your answer'), 'and promises it will not be in the answer');
    assert.ok(wrapped.endsWith(COMPLEX_PROMPT), 'with the operator prompt untouched at the end');
  });
});

describe('a decision line, wherever the stream splits it', () => {
  test('one chunk, one decision, and the answer keeps the rest', () => {
    const { text, decisions } = scan('WHY: searching first because the prices change weekly\nHere is the answer.\n');
    assert.deepEqual(decisions, ['searching first because the prices change weekly']);
    assert.equal(text, 'Here is the answer.\n');
  });

  test('split between the W and the H', () => {
    // The failure this exists for: release "W" as prose and the operator reads
    // a stray W in their answer forever.
    const { text, decisions } = scan('W', 'H', 'Y', ': checking the file first\nThen the answer.');
    assert.deepEqual(decisions, ['checking the file first']);
    assert.equal(text, 'Then the answer.');
  });

  test('the tail is released as soon as it cannot be a decision', () => {
    const scanner = new DecisionScanner();
    const first = scanner.push('Here is a normal sentence about the weather');
    assert.equal(first.text, 'Here is a normal sentence about the weather', 'prose streams straight through');
    assert.deepEqual(first.decisions, []);
  });

  test('a long line is never held hostage', () => {
    // A model that never emits a newline must not stall the answer behind a
    // hold-back rule. 400 characters in, it is prose.
    const long = 'a'.repeat(500);
    const { text, decisions } = scan(long);
    assert.deepEqual(decisions, []);
    assert.equal(text.length, 500, 'every character still arrives');
  });

  test('markdown emphasis around the label is tolerated', () => {
    assert.equal(decisionInLine('**WHY:** the numbers are stale'), 'the numbers are stale');
    assert.equal(decisionInLine('### WHY: the page 404s'), 'the page 404s');
    assert.equal(decisionInLine('  WHY :  spaced out  '), 'spaced out');
  });

  test('prose is not mistaken for a decision', () => {
    assert.equal(decisionInLine('That is why: the file was already there.'), null);
    assert.equal(decisionInLine('The reason: it was cheaper.'), null);
    assert.equal(decisionInLine('why we did it'), null);
    const { text, decisions } = scan('That is why: the file was already there.\n');
    assert.deepEqual(decisions, []);
    assert.equal(text, 'That is why: the file was already there.\n');
  });

  test('several decisions in one answer, in order', () => {
    const { decisions } = scan(
      'WHY: read the config first\n',
      'Reading config…\n',
      'WHY: then the pricing table, it is the one that changes\n',
      'Done.\n',
    );
    assert.deepEqual(decisions, [
      'read the config first',
      'then the pricing table, it is the one that changes',
    ]);
  });

  test('a decision with no newline before the end of the stream still counts', () => {
    const { text, decisions } = scan('answer text\nWHY: last thought');
    assert.equal(text, 'answer text\n');
    assert.deepEqual(decisions, ['last thought']);
  });
});

describe('the stored answer never carries the protocol', () => {
  test('lines are removed whole, and a stray colon is not a reason to cut a sentence', () => {
    const stored = stripDecisions(
      'WHY: read the brief\n\nBuilt the page.\nIt links to the guide: yes.\n\nWHY: checked the render\nDone.',
    );
    assert.ok(!/WHY:/.test(stored), 'no protocol lines left');
    assert.ok(stored.includes('Built the page.'), 'prose kept');
    assert.ok(stored.includes('It links to the guide: yes.'), 'a colon mid-sentence is not a decision');
    assert.ok(!/\n{3,}/.test(stored), 'and the gap it left is closed');
  });

  test('a reason the model glued to the end of a sentence still comes out', () => {
    // The engine's own copy of the answer is a concatenation, not the stream:
    // a model that forgets the newline produces "Reading it through. WHY: the
    // prices change weekly". The scanner saw the line; the stored answer must
    // still lose it. The removal is by exact text, because we hold the reason
    // the model actually gave — never by hunting for the pattern.
    const engineCopy = 'Reading it through. WHY: the prices change weekly, so fetch them\nBuilt it at site/index.html.';
    const cleaned = stripDecisions(engineCopy, ['the prices change weekly, so fetch them']);
    assert.ok(!/WHY:/.test(cleaned), `no protocol left: ${cleaned}`);
    assert.match(cleaned, /Built it at site\/index\.html/, 'the answer survives');
    assert.match(cleaned, /Reading it through\./, 'and so does the sentence it was glued to');
  });

  test('prose that merely looks like a decision is left alone', () => {
    // The other half of the same rule: nothing is cut on a guess. This text
    // was never recorded as a reason, so it is prose, and prose is not ours to
    // delete — however much it looks like the protocol.
    const prose = 'It failed. Why: the file was missing, which the log confirmed.';
    assert.equal(stripDecisions(prose, ['read the config first']), prose);
  });

  test('idempotent — safe at every reconciliation point', () => {
    const once = stripDecisions('WHY: a\nanswer');
    assert.equal(stripDecisions(once), once);
    assert.equal(stripDecisions(''), '');
  });
});

describe('a reason at the very end of the stream', () => {
  test('finish() releases what the scanner was still holding', () => {
    // The scanner holds a tail while it could still become a reason. If the
    // stream stops mid-tail, that hold has to be released or the last thing the
    // model said is lost — which is exactly the likely case, a reason written
    // last with no newline after it.
    const scanner = new DecisionScanner();
    assert.deepEqual(scanner.push('WHY: the price changes weekly'), { text: '', decisions: [] }, 'held, not yet a reason');
    assert.deepEqual(scanner.finish(), { text: '', decisions: ['the price changes weekly'] });
    // The decorated forms hold too, and land the same way.
    const decorated = new DecisionScanner();
    assert.deepEqual(decorated.push('**WHY:** because the second source disagrees'), { text: '', decisions: [] });
    assert.deepEqual(decorated.finish().decisions, ['because the second source disagrees']);
  });

  test('a partial line that can never be a reason is text, not a swallow', () => {
    // The hold is not "keep the last N characters": it is "hold while this
    // could still turn into a reason line". A single letter that cannot, is
    // handed straight back.
    const scanner = new DecisionScanner();
    scanner.push('W');
    assert.equal(scanner.finish().text, 'W');
  });

  test('nothing is invented when the text already ended cleanly, and finishing twice is safe', () => {
    const scanner = new DecisionScanner();
    assert.equal(scanner.push('The price list has not changed\n').text, 'The price list has not changed\n');
    assert.deepEqual(scanner.finish(), { text: '', decisions: [] });
    assert.deepEqual(scanner.finish(), { text: '', decisions: [] });
  });

  test('a reason glued mid-sentence is prose, and prose is never cut on a guess', () => {
    // The honest limit of the protocol: a reason the model refuses to put on
    // its own line stays in the answer, because the alternative is a pattern
    // hunt for "why:" that would eat real sentences like this one.
    assert.equal(decisionInLine('Reading it through. WHY: the prices change weekly'), null);
    const scanner = new DecisionScanner();
    assert.equal(scanner.push('Reading it through. WHY: the prices change weekly').text, 'Reading it through. WHY: the prices change weekly');
  });
});
