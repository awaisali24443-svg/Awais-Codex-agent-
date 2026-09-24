/**
 * The gate is only worth having if it is right in both directions: it must
 * catch the failures that make a page look generated, and it must not flag a
 * good page — because the first time it flags good work, someone turns it off.
 *
 * So every rule gets a bad example that must be caught and a good example that
 * must pass. The good examples are the shapes the directions actually produce.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBuild,
  gatePassed,
  gateRepairPrompt,
  gateSummary,
  largestDisplayPx,
  type BuiltFile,
} from './gate.js';

/** A build in the direction registry's own vocabulary: tokens, then a page. */
const TOKENS = `:root {
  --canvas: #05060a;
  --surface: #0d1017;
  --ink: #f4f6fb;
  --muted: #98a2b8;
  --accent: #6ee7ff;
  --hairline: rgba(255,255,255,.08);
  --radius: 14px;
  --space-6: 48px;
  --dur: 600ms;
  --ease: cubic-bezier(.2,.8,.2,1);
}`;

const GOOD_PAGE = `<!doctype html>
<html><head><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="page.css"></head>
<body>
  <header><h1>Nightshift</h1></header>
  <section class="hero">
    <h2>Ship the thing you keep postponing.</h2>
    <svg viewBox="0 0 24 24"><path d="M4 12h16" fill="#6ee7ff"/></svg>
    <p>One sentence of real copy, written for this page.</p>
    <button>Start</button>
  </section>
</body></html>`;

const GOOD_CSS = `.hero { font-size: clamp(2.6rem, 8vw, 6rem); letter-spacing: -.03em; }
.hero h2 { transition: opacity 600ms var(--ease), transform 600ms var(--ease); }
.grid { display: grid; grid-template-columns: 7fr 5fr; gap: 24px; }
@media (prefers-reduced-motion: reduce) { .hero h2 { transition: none; } }`;

const goodBuild: BuiltFile[] = [
  { path: 'tokens.css', content: TOKENS },
  { path: 'page.css', content: GOOD_CSS },
  { path: 'index.html', content: GOOD_PAGE },
];

describe('a build that is actually right', () => {
  test('passes, with nothing to fix', () => {
    const findings = checkBuild(goodBuild, 'nocturne');
    assert.deepEqual(findings, [], gateSummary(findings));
    assert.equal(gatePassed(findings), true);
    assert.equal(gateRepairPrompt(findings, 'nocturne'), '');
  });

  test('the same page is judged the same way twice', () => {
    assert.deepEqual(checkBuild(goodBuild, 'nocturne'), checkBuild(goodBuild, 'nocturne'));
  });
});

describe('the failures that make a page look generated', () => {
  test('a colour that is not a token is caught, with the colour named', () => {
    const files = [
      ...goodBuild.slice(0, 2),
      { path: 'index.html', content: GOOD_PAGE.replace('</body>', '<style>.x{color:#ff00aa}</style></body>') },
    ];
    const finding = checkBuild(files, 'nocturne').find((f) => f.rule === 'colour-outside-tokens');
    assert.ok(finding, 'a stray hex is a finding');
    assert.equal(finding.file, 'index.html');
    assert.ok(finding.detail.includes('#ff00aa'), finding.detail);
  });

  test('colours inside generated SVG and data URIs are not stray', () => {
    // The recipe asks for SVG grain and textures. Flagging our own generated
    // assets would make the gate unusable on exactly the pages it is for.
    const files = [
      ...goodBuild.slice(0, 2),
      { path: 'grain.css', content: ".grain { background-image: url(\"data:image/svg+xml,%3Csvg fill='%23f4f6fb'%3E%3C/svg%3E\"); }" },
    ];
    assert.equal(checkBuild(files, 'nocturne').length, 0);
  });

  test('unfinished copy is caught', () => {
    const files = [
      ...goodBuild.slice(0, 2),
      { path: 'index.html', content: '<h1>Lorem ipsum dolor</h1><a href="#">Read more</a>' },
    ];
    const finding = checkBuild(files, 'nocturne').find((f) => f.rule === 'placeholder-copy');
    assert.ok(finding);
    assert.ok(/lorem/i.test(finding.detail), finding.detail);
  });

  test('headings the size of body text are caught', () => {
    const css = '.hero h2 { font-size: 20px; } .body { font-size: 16px; }';
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: css },
      { path: 'index.html', content: GOOD_PAGE },
    ];
    const finding = checkBuild(files, 'kinetic').find((f) => f.rule === 'display-scale');
    assert.ok(finding, 'a 20px heading is not a display size');
    assert.equal(finding.file, 'page.css', 'the finding names the file with the small type, not the token file');
    assert.ok(finding.detail.includes('largest type on the page is 20px'), finding.detail);
  });

  test('motion with no way out of it is caught', () => {
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: '.a { transition: opacity 300ms ease; font-size: clamp(3rem, 8vw, 6rem); }' },
      { path: 'index.html', content: GOOD_PAGE },
    ];
    const finding = checkBuild(files, 'nocturne').find((f) => f.rule === 'reduced-motion');
    assert.ok(finding, 'an unguarded animation is a finding');
  });

  test('animating a layout property is caught, named, and not confused with a colour', () => {
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: '.a { font-size: clamp(3rem, 8vw, 6rem); transition: width 300ms ease; }\n@media (prefers-reduced-motion: reduce) { .a { transition: none; } }' },
      { path: 'index.html', content: GOOD_PAGE },
    ];
    const finding = checkBuild(files, 'nocturne').find((f) => f.rule === 'layout-transition');
    assert.ok(finding);
    assert.ok(finding.detail.includes('width'), finding.detail);
    // `transition: all` is the same mistake wearing a hat.
    const all = checkBuild(
      [{ path: 'a.css', content: '* { transition: all 200ms; font-size: clamp(3rem, 8vw, 6rem); }\n@media (prefers-reduced-motion: reduce) {}' }],
      'nocturne',
    ).find((f) => f.rule === 'layout-transition');
    assert.ok(all?.detail.includes('transition: all'), all?.detail);
  });

  test('the generated-page shape is caught by name', () => {
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: '.hero { text-align: center; background: linear-gradient(#111, #222); font-size: clamp(3rem, 8vw, 6rem); transition: opacity 300ms; }\n.features { display: grid; grid-template-columns: repeat(3, 1fr); }\n@media (prefers-reduced-motion: reduce) {}' },
      { path: 'index.html', content: GOOD_PAGE },
    ];
    const finding = checkBuild(files, 'nocturne').find((f) => f.rule === 'generic-shape');
    assert.ok(finding, 'centred + three equal cards + gradient is the shape being designed away');
  });

  test('a build with no tokens file is caught before anything else is judged', () => {
    const files = [
      { path: 'index.html', content: GOOD_PAGE },
      { path: 'page.css', content: GOOD_CSS },
    ];
    const findings = checkBuild(files, 'nocturne');
    assert.ok(findings.some((f) => f.rule === 'tokens-missing'));
    // And one file on its own is not asked for a tokens file it cannot have.
    assert.equal(checkBuild([{ path: 'index.html', content: GOOD_PAGE }], 'nocturne').some((f) => f.rule === 'tokens-missing'), false);
  });

  test('a token set too small to be a set is caught', () => {
    const files = [
      { path: 'tokens.css', content: ':root { --a: #05060a; --b: #fff; }' },
      { path: 'page.css', content: GOOD_CSS },
      { path: 'index.html', content: GOOD_PAGE },
    ];
    const finding = checkBuild(files, 'nocturne').find((f) => f.rule === 'tokens-missing');
    assert.ok(finding?.detail.includes('2 custom properties'), finding?.detail);
  });

  test('a text-only page is caught', () => {
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: '.h { font-size: clamp(3rem, 8vw, 6rem); }' },
      { path: 'index.html', content: '<h1>Words only</h1><p>No image, no svg, no gradient anywhere at all.</p>' },
    ];
    assert.ok(checkBuild(files, 'blueprint').some((f) => f.rule === 'no-imagery'));
  });
});

describe('the direction decides the thresholds, so the gate cannot contradict the recipe', () => {
  test('a dense documentation page is allowed dense headings, a festival page is not', () => {
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: '.h { font-size: 1.7rem; }' },
      { path: 'index.html', content: GOOD_PAGE },
    ];
    assert.deepEqual(checkBuild(files, 'blueprint').filter((f) => f.rule === 'display-scale'), []);
    assert.equal(checkBuild(files, 'kinetic').some((f) => f.rule === 'display-scale'), true);
  });

  test('a direction is optional, and the gate still works without one', () => {
    assert.deepEqual(checkBuild(goodBuild), []);
    assert.ok(checkBuild([{ path: 'a.html', content: '<h1>Lorem ipsum</h1>' }], null).some((f) => f.rule === 'placeholder-copy'));
  });

  test('the repair prompt is a to-do list, and it stays in the direction', () => {
    const files = [
      { path: 'tokens.css', content: TOKENS },
      { path: 'page.css', content: '.a { font-size: 14px; }' },
      { path: 'index.html', content: '<h1>Real words, small type</h1><img src="a.png" alt="">' },
    ];
    const findings = checkBuild(files, 'atelier');
    const prompt = gateRepairPrompt(findings, 'atelier');
    assert.ok(prompt.startsWith('[Quality gate'), 'it announces itself');
    assert.ok(prompt.includes('Do not rewrite the page'), 'and does not invite a rewrite');
    assert.ok(prompt.includes('- page.css — '), 'each item names the file');
    assert.ok(prompt.includes('Direction, unchanged: Atelier — near-silent editorial'), 'the direction is restated, not renegotiated');
  });
});

describe('the display-size reader', () => {
  test('clamp is read at its maximum, in pixels', () => {
    assert.equal(largestDisplayPx('.h { font-size: clamp(2.6rem, 8vw, 6rem); }'), 96);
    assert.equal(largestDisplayPx('.h { font-size: clamp(4rem, 18vw, 14rem); }'), 224);
  });

  test('a vw size is read at phone width, because that is where it breaks', () => {
    assert.equal(largestDisplayPx('.h { font-size: 18vw; }'), 67.5);
  });

  test('the largest declared size wins, whatever the unit', () => {
    // It is a fact about the file, not a judgement: the judgement lives in the
    // rule and its direction-specific floor.
    assert.equal(largestDisplayPx('.p { font-size: 1.0625rem; } .s { font-size: 11px; }'), 17);
    assert.equal(largestDisplayPx('.s { font-size: 11px; } .h { font-size: 20px; }'), 20);
  });

  test('nonsense does not throw', () => {
    assert.equal(largestDisplayPx('.h { font-size: clamp(calc(1px + 2vw), var(--x), 3rem); }'), 48);
    assert.equal(largestDisplayPx(''), 0);
  });
});
