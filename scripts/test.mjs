/**
 * The test runner, with a deterministic exit.
 *
 * `node --test --test-force-exit` exits the moment the event loop looks idle.
 * That flag is here for a real reason — an aborted fetch leaves a socket in
 * Node's keep-alive pool, and that socket keeps the process alive long after
 * every test has passed (see the note at the top of antigravity.test.ts) — but
 * it has a cost that is worse than slow: **it can exit before a file reports**.
 *
 * Measured, three runs of the same tree within a minute of each other: 1040,
 * 1051 and 1037 tests. The gap is exactly one file's results, and every run
 * said "0 fail". A green suite that silently skipped a file is the one result
 * nobody can act on, so the flag is gone from the script and this file does the
 * job properly:
 *
 *   1. run every test file through `node:test` programmatically,
 *   2. wait for the reporter to drain — not for the event loop to look idle,
 *   3. print the real totals, and exit non-zero if anything failed.
 *
 * The forced exit still happens, just at the right moment.
 */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every test file the suite has always covered: `server/*.test.ts` and one level deeper. */
function testFiles() {
  const dir = path.join(ROOT, 'server');
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(path.join(dir, entry.name));
    if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name);
      for (const inner of fs.readdirSync(nested)) {
        if (inner.endsWith('.test.ts')) found.push(path.join(nested, inner));
      }
    }
  }
  return found.sort();
}

/**
 * The children get the forced exit; this process does not.
 *
 * Each test file runs in its own child process, and a child with a socket in
 * the keep-alive pool never exits on its own — that is the hang the flag was
 * added for. But the flag on the *parent* is what truncated results: it exited
 * while files were still reporting. Setting it on `execArgv` gives it to the
 * children (node's runner passes `execArgv` down) and leaves this process to
 * exit deliberately, once the reporter has drained.
 */
if (!process.execArgv.includes('--test-force-exit')) {
  process.execArgv = [...process.execArgv, '--test-force-exit'];
}

const files = testFiles();
if (files.length === 0) {
  console.error('no test files found — refusing to report a passing suite');
  process.exit(1);
}

const totals = new Map();
let failures = 0;

const stream = run({ files });

stream.on('test:fail', () => {
  failures += 1;
});
stream.resume(); // the reporter consumes it too; this keeps the counter live
stream.on('test:diagnostic', (event) => {
  // The summary lines ("tests 1051", "fail 0", …) arrive as diagnostics. On
  // this Node the listener is handed the data object itself, not an envelope.
  const message = typeof event?.message === 'string' ? event.message : (event?.data?.message ?? '');
  const match = /^(tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(message);
  if (match) totals.set(match[1], Number(match[2]));
});

const reporter = stream.compose(new spec());
reporter.pipe(process.stdout);
reporter.on('end', () => {
  const seen = Number(totals.get('tests') ?? 0);
  const failed = Number(totals.get('fail') ?? failures);
  // A run that ended without a summary is a run that did not finish. Say so
  // rather than letting a truncated suite look green.
  if (totals.size === 0) {
    console.error('\nthe test run ended without a summary — treating it as a failure');
    process.exit(1);
  }
  console.log(`\n[test] ${seen} tests across ${files.length} files · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
