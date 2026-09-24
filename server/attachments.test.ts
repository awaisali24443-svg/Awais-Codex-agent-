/**
 * Attached files: what is accepted, what is refused and how it is written up.
 *
 * The interesting cases are all refusals — a 5 MB file, a fourth file, a binary
 * that arrived as text. Each one has to come back as a sentence naming the file,
 * because the operator sent it from a phone and cannot read a stack trace.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_LIMITS,
  attachmentNames,
  attachmentSummary,
  parseAttachments,
  withAttachments,
} from './attachments.js';

const file = (name: string, text: string) => ({ name, text });

describe('attached files are bounded', () => {
  test('no attachments is a normal answer, not an error', () => {
    for (const raw of [undefined, null, []]) {
      const parsed = parseAttachments(raw);
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.ok && parsed.attachments, []);
    }
  });

  test('a text file is accepted and its name is cleaned', () => {
    const parsed = parseAttachments([file('  my   notes.md ', '# hello')]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.attachments, [{ name: 'my notes.md', text: '# hello' }]);
  });

  test('too many files are refused with the limit', () => {
    const parsed = parseAttachments(Array.from({ length: ATTACHMENT_LIMITS.count + 1 }, (_, i) => file(`f${i}.txt`, 'x')));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : '', /at most 3 files/);
  });

  test('a file over the per-file cap names the file and the cap', () => {
    const parsed = parseAttachments([file('big.txt', 'x'.repeat(ATTACHMENT_LIMITS.bytes + 1))]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : '', /^big\.txt is larger than 200 KB$/);
  });

  test('three legal files can still add up to too much', () => {
    const each = 'x'.repeat(150_000);
    const parsed = parseAttachments([file('a.txt', each), file('b.txt', each), file('c.txt', each)]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : '', /add up to more than 400 KB/);
  });

  test('a binary that arrived as text is refused rather than sent', () => {
    // U+FFFD is what a decoder leaves behind when it was handed bytes that are
    // not text. Sending that to the model is worse than refusing it.
    const parsed = parseAttachments([file('photo.png', '\uFFFD\uFFFD\uFFFD')]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok === false ? parsed.message : '', /photo\.png is not a text file/);
  });

  test('a malformed entry explains itself', () => {
    assert.equal(parseAttachments({ name: 'x' }).ok, false);
    assert.equal(parseAttachments([file('', 'x')]).ok, false);
    assert.equal(parseAttachments([{ name: 'x.txt' }]).ok, false);
    assert.equal(parseAttachments(['nope']).ok, false);
  });
});

describe('attachments are announced, never impersonated', () => {
  const attached = [file('notes.md', 'line one'), file('plan.csv', 'a,b\n1,2')];

  test('the thread gets a line naming the files, not their contents', () => {
    const summary = attachmentSummary(attached);
    assert.match(summary, /Attached files: notes\.md, plan\.csv/);
    assert.ok(!summary.includes('line one'), 'the operator\u2019s message stays their own words');
    assert.equal(attachmentSummary([]), '', 'and nothing is added when nothing was attached');
  });

  test('the engine gets the words and then the files, fenced', () => {
    const prompt = withAttachments('Summarise this.', attached);
    assert.ok(prompt.startsWith('Summarise this.'), 'the question comes first');
    assert.ok(prompt.includes('--- notes.md ---'), 'each file is fenced with its name');
    assert.ok(prompt.includes('line one'));
    assert.ok(prompt.includes('--- end of plan.csv ---'), 'and closed again, so the model knows where it ended');
  });

  test('a prompt with no attachments is passed through untouched', () => {
    assert.equal(withAttachments('Just this.', []), 'Just this.');
  });

  test('names are listed in the order they were attached', () => {
    assert.equal(attachmentNames(attached), 'notes.md, plan.csv');
  });
});
