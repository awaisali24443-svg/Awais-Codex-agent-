/**
 * Records: file cards and cited sources.
 *
 * Everything here is a parser over things the model wrote — a filename, an
 * answer full of links — so the cases that matter are the ugly ones: a URL with
 * a full stop stuck to it, the same link cited twice with a name and without,
 * an extension nobody has seen before.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  artifactKind,
  artifactMeta,
  badgeFor,
  domainOf,
  markDead,
  sourcesFromText,
  sourcesSummary,
} from '../web/records.js';

const bytes = (n: number) => `${Math.round(n / 1000)} KB`;

describe('a produced file knows what it is', () => {
  test('common kinds are named from the extension', () => {
    assert.equal(artifactKind('index.html').label, 'Web page');
    assert.equal(artifactKind('shot.PNG').label, 'Image');
    assert.equal(artifactKind('app-debug.apk').label, 'Android app');
    assert.equal(artifactKind('report.csv').label, 'Spreadsheet');
    assert.equal(artifactKind('data.json').label, 'Data');
    assert.equal(artifactKind('notes.md').label, 'Document');
    assert.equal(artifactKind('main.ts').label, 'Code');
    assert.equal(artifactKind('bundle.zip').label, 'Archive');
  });

  test('an unknown extension is a file, not a guess', () => {
    assert.deepEqual(artifactKind('mystery.qqq'), { id: 'file', label: 'File', icon: 'file' });
    assert.deepEqual(artifactKind(''), { id: 'file', label: 'File', icon: 'file' });
    assert.deepEqual(artifactKind(undefined), { id: 'file', label: 'File', icon: 'file' });
  });

  test('the meta line drops what it does not have', () => {
    assert.equal(artifactMeta({ name: 'a.md', size: 12_000 }, bytes), 'Document · 12 KB');
    assert.equal(artifactMeta({ name: 'a.md', size: 12_000, pinned: true }, bytes), 'Document · 12 KB · Kept');
    assert.equal(artifactMeta({ name: 'a.md' }, bytes), 'Document');
    // `stored` is not the same promise as `pinned`: the bytes are on the disk
    // today, and nothing keeps them there.
    assert.equal(artifactMeta({ name: 'a.md', size: 10, stored: true }, bytes), 'Document · 0 KB');
  });
});

describe('an answer\u2019s sources', () => {
  test('markdown links are taken in order, with their names', () => {
    const text = 'See [the circular](https://rbi.org.in/x.pdf) and [the rules](https://sebi.gov.in/y).';
    const sources = sourcesFromText(text);
    assert.deepEqual(sources.map((s) => s.url), ['https://rbi.org.in/x.pdf', 'https://sebi.gov.in/y']);
    assert.equal(sources[0].label, 'the circular');
    assert.equal(sources[0].domain, 'rbi.org.in');
    assert.equal(sources[0].badge, 'R');
  });

  test('a bare URL still counts', () => {
    const sources = sourcesFromText('I read https://example.com/article today.');
    assert.deepEqual(sources.map((s) => s.url), ['https://example.com/article']);
    assert.equal(sources[0].label, 'example.com', 'unnamed links are labelled by their domain');
  });

  test('a full stop at the end of a sentence is not part of the link', () => {
    assert.deepEqual(sourcesFromText('From https://example.com/page.').map((s) => s.url), ['https://example.com/page']);
    assert.deepEqual(sourcesFromText('See [x](https://example.com/page).').map((s) => s.url), ['https://example.com/page']);
  });

  test('a markdown link is never counted twice', () => {
    const sources = sourcesFromText('See [name](https://example.com/a) now.');
    assert.equal(sources.length, 1);
  });

  test('the same link cited twice appears once, and keeps the better name', () => {
    const sources = sourcesFromText('https://example.com/a came first, then [the report](https://example.com/a).');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].label, 'the report', 'the named citation wins');
  });

  test('things that are not web links are ignored', () => {
    for (const junk of ['mailto:someone@example.com', 'ftp://example.com/f', 'javascript:alert(1)', 'no links here']) {
      assert.deepEqual(sourcesFromText(junk), [], junk);
    }
  });

  test('the domain loses its www, and an empty badge stays a bullet', () => {
    assert.equal(domainOf('https://www.example.com/a'), 'example.com');
    assert.equal(domainOf('not a url'), '');
    assert.equal(badgeFor(''), '•');
  });
});

describe('what the link check adds', () => {
  const sources = sourcesFromText('[a](https://one.example/x) [b](https://two.example/y)');

  test('dead links are marked, not dropped', () => {
    const marked = markDead(sources, ['https://two.example/y']);
    assert.deepEqual(marked.map((s) => !!s.dead), [false, true]);
    assert.equal(marked.length, 2, 'the dead one is still listed — the reader should see it');
  });

  test('the summary never claims more coverage than happened', () => {
    assert.equal(sourcesSummary(markDead(sources, []), 2), '2 sources');
    assert.equal(sourcesSummary(markDead(sources, ['https://two.example/y']), 2), '2 sources · 1 dead');
    // The server checked fewer links than the answer cites.
    assert.equal(sourcesSummary(markDead(sources, []), 1), '1 of 2 sources checked');
    assert.equal(sourcesSummary([]), '');
  });
});
