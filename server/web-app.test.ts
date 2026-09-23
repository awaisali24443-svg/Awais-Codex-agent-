/**
 * Guards for the browser app.
 *
 * `web/app.js` is plain JavaScript with no bundler and no type checking, so a
 * typo in a function name is not caught by anything until it runs — and when it
 * runs, it is a `ReferenceError` inside `enter()`, which the boot handler
 * catches as "not signed in". The symptom of a broken renderer is a sign-in
 * screen that nothing can get past.
 *
 * That is not hypothetical: `enter()` called `loadMemory()` while no such
 * function existed anywhere in the file. Every line after it — resuming a task
 * that is already running, opening the last conversation — was dead, and the
 * app looked like it wanted a password. These checks would have failed on that
 * commit, and they need no browser:
 *
 *   1. every `$('some-id')` lookup has a matching id in index.html
 *   2. those ids are unique, so a lookup cannot silently pick the wrong node
 *   3. every asset the page references exists, and every collapsible panel in
 *      the drawer is bound to something that fills it in
 *
 * Check 1 is `npm run lint:web` (tsconfig.web.json), not this file: the
 * TypeScript compiler already parses both browser modules and answers
 * "Cannot find name" exactly. What is left here are the two things a type
 * checker cannot know — that the ids being looked up exist in the markup, and
 * that every asset and panel the page declares is really there.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { findDir } from './paths.js';
import { SECRET_SOURCES } from './settings.js';

const WEB_ROOT = findDir(['web'], 'index.html') ?? path.join(process.cwd(), 'web');

function read(name: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, name), 'utf-8');
}

describe('web/app.js', () => {
  const source = read('app.js');

  test('every $() lookup has a matching id in index.html', () => {
    const html = read('index.html');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

    const looked = [...source.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    const missing = [...new Set(looked)].filter((id) => !ids.has(id));

    assert.deepEqual(
      missing,
      [],
      `app.js looks up ${missing.map((id) => `#${id}`).join(', ')} but no such id exists in index.html`,
    );
  });

  test('the ids the app binds are unique in the markup', () => {
    const html = read('index.html');
    const seen = new Map<string, number>();
    for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    assert.deepEqual(duplicated, [], `index.html repeats ${duplicated.map((id) => `#${id}`).join(', ')}`);
  });

  test('every asset the page references exists', () => {
    const html = read('index.html');
    const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);

    const missing = assets.filter((asset) => !fs.existsSync(path.join(WEB_ROOT, asset.replace(/^\//, ''))));
    assert.deepEqual(missing, [], `index.html references ${missing.join(', ')}, which is not in web/`);

    // The service worker precaches a list of its own; a file that only exists
    // in one of the two places is a 404 on a phone with no network.
    const sw = read('sw.js');
    assert.match(sw, /const VERSION = '[^']+';/, 'sw.js must keep a versioned cache name');
  });

  test('the panel already knows every credential state the server can report', () => {
    // A source the UI has no label for renders as "not set" — a stored key
    // displayed as missing, which is worse than no panel at all.
    const table = /const SECRET_STATE = \{([\s\S]*?)\n\};/.exec(source);
    assert.ok(table, 'SECRET_STATE table not found in app.js');
    // Top-level keys only: the entries are indented two spaces, their bodies
    // more, so a looser pattern picks up `text:` from inside a label object.
    const known = [...table[1].matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]).sort();

    assert.deepEqual(known, [...SECRET_SOURCES].sort());
  });

  test('the panels in the drawer are all wired to a renderer', () => {
    // Each collapsible panel has a toggle and a body; the bug this file guards
    // against was a panel whose body was never populated by anything.
    const html = read('index.html');
    const toggles = [...html.matchAll(/id="([a-z-]+)-toggle"/g)].map((m) => `${m[1]}-body`);
    const bound = [...source.matchAll(/bindPanel\(\s*el\.\w+,\s*el\.(\w+)\s*\)/g)].map((m) => m[1]);

    assert.ok(toggles.length >= 2, 'expected the drawer collapsibles to still exist');
    assert.equal(
      bound.length,
      toggles.length,
      `index.html has ${toggles.length} collapsible panel(s) but app.js binds ${bound.length}`,
    );
  });

  // The markdown renderer is a set of pure functions inside app.js (no DOM),
  // so the tests evaluate just that slice instead of the whole browser script.
  function loadMarkdown(): (source: string) => string {
    const start = source.indexOf('function escapeHtml(text) {');
    const end = source.indexOf('\nfunction relativeTime(iso) {');
    assert.ok(start !== -1 && end > start, 'markdown helpers not found in app.js');
    return new Function(`${source.slice(start, end)}; return { markdown };`)().markdown;
  }

  test('markdown() renders a table instead of raw pipe text', () => {
    const markdown = loadMarkdown();
    const out = markdown('| Factor | What to Expect |\n| --- | --- |\n| Payback | 6 to 10 years |');
    assert.match(out, /<table>/);
    assert.match(out, /<th>Factor<\/th>/);
    assert.match(out, /<td>6 to 10 years<\/td>/);
    assert.doesNotMatch(out, /\| --- \|/);
  });

  test('markdown() renders a table that follows intro text in the same block', () => {
    const markdown = loadMarkdown();
    const out = markdown('Summary\n| A | B |\n|---|---|\n| 1 | 2 |');
    assert.match(out, /<p>Summary<\/p>/);
    assert.match(out, /<table>.*<th>A<\/th>.*<td>2<\/td>.*<\/table>/s);
  });

  test('markdown() honours alignment-style separator rows and inline markup in cells', () => {
    const markdown = loadMarkdown();
    const out = markdown('| A | B |\n|:---|---:|\n| **x** | `y` |');
    assert.match(out, /<table>/);
    assert.match(out, /<td><strong>x<\/strong><\/td>/);
    assert.match(out, /<td><code>y<\/code><\/td>/);
  });

  test('markdown() leaves pipe text without a separator row alone', () => {
    const markdown = loadMarkdown();
    const out = markdown('| not | a table |');
    assert.doesNotMatch(out, /<table>/);
    assert.match(out, /\| not \| a table \|/);
  });

  test('markdown() still renders headings and lists', () => {
    const markdown = loadMarkdown();
    assert.match(markdown('# Hi'), /<h1>Hi<\/h1>/);
    assert.match(markdown('- a\n- b'), /<ul>.*<li>a<\/li>.*<li>b<\/li>.*<\/ul>/s);
    assert.match(markdown('1. a\n2. b'), /<ol>.*<li>a<\/li>.*<li>b<\/li>.*<\/ol>/s);
  });

  test('settings templates keep spaces around inline elements', () => {
    // A 2026-09-23 QA pass reported fused words ("connectedas",
    // "onlyreadyour") in the Settings panel. The templates are correctly
    // spaced today; this scan fails the build if a word ever abuts an
    // inline <b>/<code>/<i> tag again.
    const fused: string[] = [];
    for (const m of source.matchAll(/[A-Za-z0-9]<(?:b|code|i)>/g)) fused.push(m[0]);
    for (const m of source.matchAll(/<\/(?:b|code|i)>[A-Za-z0-9]/g)) fused.push(m[0]);
    assert.deepEqual(fused, [], `words fused across inline tags: ${fused.join(', ')}`);
  });
});
