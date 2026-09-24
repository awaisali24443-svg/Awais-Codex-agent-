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
  imageSummary,
  parseAttachments,
  parseImages,
  withAttachments,
  withImageNote,
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

describe('an image the operator attached', () => {
  const png = (name = 'shot.png', size = 800) => ({
    name,
    mimeType: 'image/png',
    data: 'A'.repeat(size),
  });

  test('a well-formed image is accepted as it arrived', () => {
    const parsed = parseImages([png()]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.images[0].mimeType, 'image/png');
    assert.equal(parsed.images[0].name, 'shot.png');
  });

  test('a data URL is accepted and stripped to the bytes the API wants', () => {
    const parsed = parseImages([
      { name: 'shot.png', data: `data:image/png;base64,${'A'.repeat(40)}` },
    ]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.images[0].data.startsWith('data:'), false, 'no prefix reaches the API');
    assert.equal(parsed.images[0].mimeType, 'image/png', 'the mime comes from the URL');
  });

  test('every refusal is a sentence naming the file', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[{ name: 'shot.svg', mimeType: 'image/svg+xml', data: 'AAAA' }], /shot\.svg/],
      [[{ name: 'shot.png', mimeType: 'image/png', data: 'not base64 !!!' }], /shot\.png/],
      [[{ mimeType: 'image/png', data: 'AAAA' }], /name/],
      [[{ name: 'shot.png', data: 'AAAA' }], /shot\.png/],
      ['nope', /list/],
    ];
    for (const [input, pattern] of cases) {
      const parsed = parseImages(input);
      assert.equal(parsed.ok, false, `expected a refusal for ${JSON.stringify(input)}`);
      if (parsed.ok) continue;
      assert.match(parsed.message, pattern);
    }
  });

  test('an SVG is refused by name, because it is markup, not pixels', () => {
    const parsed = parseImages([{ name: 'logo.svg', mimeType: 'image/svg+xml', data: 'AAAA' }]);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.message, /SVG|not a picture the model can look at|image type/);
  });

  test('the caps are the caps, and the sentence says which one broke', () => {
    const many = Array.from({ length: 4 }, (_, i) => png(`shot${i}.png`));
    const tooMany = parseImages(many);
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.match(tooMany.message, /at most 3 images/);

    const huge = parseImages([png('huge.png', 2_000_001)]);
    assert.equal(huge.ok, false);
    if (!huge.ok) assert.match(huge.message, /huge\.png/);

    const fat = parseImages([png('a.png', 1_500_000), png('b.png', 1_500_000), png('c.png', 1_500_000)]);
    assert.equal(fat.ok, false);
    if (!fat.ok) assert.match(fat.message, /add up to more than/);
  });

  test('no images is simply no images', () => {
    for (const raw of [undefined, null, []]) {
      const parsed = parseImages(raw);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.deepEqual(parsed.images, []);
    }
  });

  test('the thread hears what was sent, not what is in it', () => {
    const images = [png('shot.png'), { name: 'chart.jpg', mimeType: 'image/jpeg', data: 'B'.repeat(60) }];
    const summary = imageSummary(images);
    assert.match(summary, /1 image|2 images/);
    assert.ok(summary.includes('shot.png') && summary.includes('chart.jpg'), 'named');
    assert.ok(!summary.includes('AAAA'), 'and no pixels in the message');
    assert.equal(imageSummary([]), '', 'nothing when nothing was attached');
  });

  test('the engine is told the pictures are there, in order', () => {
    const withNote = withImageNote('Build this page.', [png('shot.png')]);
    assert.ok(withNote.startsWith('Build this page.'), 'the operator\u2019s words still come first');
    assert.ok(withNote.includes('shot.png'), 'the note names the image');
    assert.equal(withImageNote('Just this.', []), 'Just this.', 'and adds nothing when there is no image');
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
