/**
 * Source extraction + verification tests.
 *
 * checkSources hits a local HTTP server, never the real internet: fast,
 * hermetic, and free of data charges.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { extractUrls, checkSources, searchQueryOf, urlsIn } from './sources.js';

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200).end();
    } else if (req.url === '/dead') {
      res.writeHead(404).end();
    } else if (req.url === '/nohead') {
      // Refuses HEAD like some real servers do; GET works.
      if (req.method === 'HEAD') res.writeHead(405).end();
      else res.writeHead(200).end('x');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('extractUrls finds, dedupes and cleans URLs', () => {
  const text = [
    'See https://example.com/a and https://example.com/a again.',
    'Trailing punctuation https://example.com/b, is stripped.',
    'Markdown [label](https://example.com/c) works.',
    'Not a URL: ftp://example.com/d or just example.com/e.',
  ].join('\n');
  assert.deepEqual(extractUrls(text), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
  ]);
});

test('extractUrls returns nothing for text without URLs', () => {
  assert.deepEqual(extractUrls('no links here, just words.'), []);
});

test('checkSources reports alive, dead and HEAD-refusing servers', async () => {
  const results = await checkSources([`${base}/ok`, `${base}/dead`, `${base}/nohead`]);
  const byUrl = Object.fromEntries(results.map((r) => [r.url, r]));
  assert.equal(byUrl[`${base}/ok`].ok, true);
  assert.equal(byUrl[`${base}/ok`].status, 200);
  assert.equal(byUrl[`${base}/dead`].ok, false);
  // /nohead refuses HEAD (405) but answers GET: alive.
  assert.equal(byUrl[`${base}/nohead`].ok, true);
});

test('checkSources never rejects on unreachable hosts', async () => {
  // Nothing listens here; must resolve to ok:false, not throw.
  const results = await checkSources(['http://127.0.0.1:1/unreachable']);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
});

// ---------------------------------------------------------------------------
// The live rail's two questions: what page is this call opening, and what is
// this call asking? Both are answered from whatever the agent sent, which is
// never a shape anyone promised.
// ---------------------------------------------------------------------------

test('urls are found wherever the agent buried them', () => {
  assert.deepEqual(urlsIn({ url: 'https://example.com/a' }), ['https://example.com/a']);
  assert.deepEqual(urlsIn(['https://example.com/a', 'https://example.com/b']), [
    'https://example.com/a',
    'https://example.com/b',
  ]);
  // Nested, mixed, and with the trailing punctuation that comes from prose.
  assert.deepEqual(
    urlsIn({ steps: [{ action: { target: 'see https://example.com/c.' } }] }),
    ['https://example.com/c'],
  );
  // Deduped within one call, and capped — the server's own cap is the last
  // line of defence, not the only one.
  assert.deepEqual(urlsIn(['https://example.com/a', 'https://example.com/a']), ['https://example.com/a']);
  assert.equal(urlsIn(Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`)).length, 5);
  assert.deepEqual(urlsIn({ nothing: 'here' }), []);
  assert.deepEqual(urlsIn(null), []);
});

test('a question is read from a lookup, and only from a lookup', () => {
  assert.equal(searchQueryOf('google_search', { query: 'blue widget prices' }), 'blue widget prices');
  assert.equal(searchQueryOf('browse', { url: 'https://example.com' }), null, 'a browse with no question is a page, not a search');
  assert.equal(searchQueryOf('read_file', { path: '/tmp/x' }), null);
  // A tool that happens to take a field called `input` is not a search.
  assert.equal(searchQueryOf('run_shell', { input: 'ls -la' }), null);
  assert.equal(searchQueryOf('web_search', { q: '  spaced  ' }), 'spaced');
  assert.equal(searchQueryOf('search', { query: '   ' }), null, 'blank is not a question');
  assert.equal(searchQueryOf('search', null), null);
  assert.equal(searchQueryOf('fetch_page', { url: 'https://example.com' }), null);
  assert.equal(searchQueryOf('search_web', { query: 'x'.repeat(400) })?.length, 140, 'and it is bounded');
});
