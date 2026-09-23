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

import { extractUrls, checkSources } from './sources.js';

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
