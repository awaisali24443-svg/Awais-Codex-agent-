/**
 * Brand + third-party scrub tests.
 *
 * The product must look like it was made by Awais Ali: the brand is
 * "Awais Codex" everywhere a user can see, the credit names him, and no
 * user-visible text mentions third-party products, models, or companies
 * (Antigravity, Manus, Gemini, OpenAI, ChatGPT, Claude, Meta, Muse...).
 *
 * Two things this file deliberately does NOT flag:
 *  1. Code comments ("Manus-style fork-on-edit") — not user-visible.
 *  2. Functional identifiers, allowlisted below: env var names
 *     (GEMINI_API_KEY, ANTIGRAVITY_AGENT), the secret name
 *     (gemini_api_key), the route (/settings/verify/gemini-key), class and
 *     file names (AntigravityEngine, engine/antigravity.ts), the engine
 *     type tag ('antigravity'), and the real default agent id
 *     (antigravity-preview-09-2026). Renaming those would break the wiring;
 *     they never reach the screen as prose.
 *
 * How the scan works: comments are stripped, then only string literals
 * (what the UI can actually render) plus HTML text are scanned. Bare code
 * identifiers like `const meta` therefore never trip the `\bmeta\b` rule;
 * the allowlist additionally covers `<meta` tags, `.meta` CSS classes, and
 * `meta[` attribute selectors found inside template strings.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const SCAN_FILES = [
  'web/index.html',
  'web/app.js',
  'web/welcome.js',
  'web/voice.js',
  'web/panel.js',
  'web/timeline.js',
  'web/sw.js',
  'web/manifest.json',
  'server/app.ts',
  'server/main.ts',
  'server/share.ts',
  'server/verify.ts',
  'server/settings.ts',
  'server/routes/settings.ts',
  'server/routes/runs.ts',
  'server/routes/artifacts.ts',
  'server/whatsapp/relay.ts',
  'server/engine/antigravity.ts',
  'server/ui-design-guide.md',
];

/** Functional identifiers that may appear inside user-facing strings. */
const ALLOWLIST = [
  'GEMINI_API_KEY',
  'ANTIGRAVITY_AGENT',
  'gemini_api_key',
  'gemini-key',
  'antigravity-preview-09-2026',
  './engine/antigravity.js',
  'server/engine/antigravity.ts',
  '<meta',
  '.meta',
  '="meta"',
  "='meta'",
  'meta[',
];

/**
 * A string literal that is exactly the engine's type tag. It only ever
 * appears as a value comparison (`engineName === 'antigravity'`) or the
 * engine's own `name`/`type` field — never as prose a user reads.
 */
const ENGINE_TAG = /^antigravity$/i;

const BANNED = [
  /\bantigravity\b/i,
  /\bmanus\b/i,
  /\bopenai\b/i,
  /\bchatgpt\b/i,
  /\bclaude\b/i,
  /\bmuse\b/i,
  /\bmeta\b/i,
];

const STRING_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gs;

function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)\/\/[^\n]*/g, ' ');
}

/** The text a user could actually see: HTML text + string literal contents. */
function userVisibleText(raw: string, file: string): string {
  if (file.endsWith('.md')) return raw;
  const code = stripComments(raw);
  const strings = [...code.matchAll(STRING_RE)]
    .map((m) => m[0].slice(1, -1))
    .filter((s) => !ENGINE_TAG.test(s.trim()));
  const joined = strings.join(' ');
  // Tag-stripped prose only applies to HTML; for JS/TS the code itself is
  // never user-visible, so only string literals are scanned there.
  const htmlText = file.endsWith('.html') ? code.replace(/<[^>]*>/g, ' ') : '';
  let blob = `${htmlText} ${joined}`;
  for (const a of ALLOWLIST) blob = blob.split(a).join('');
  return blob;
}

describe('brand', () => {
  test('page title is Awais Codex', () => {
    assert.ok(read('web/index.html').includes('<title>Awais Codex</title>'));
  });

  test('login screen and header carry the brand', () => {
    const html = read('web/index.html');
    assert.ok(html.includes('Leave it all to Awais Codex'));
    assert.ok(html.includes('id="topbar-title">Awais Codex'));
    assert.ok(html.includes('>Awais Codex</span>'));
  });

  test('credit names Awais Ali', () => {
    assert.ok(read('web/index.html').includes('Created by Awais Ali'));
    assert.ok(read('server/share.ts').includes('Created by Awais Ali'));
  });

  test('manifest names the app Awais Codex', () => {
    const manifest = JSON.parse(read('web/manifest.json')) as { name: string };
    assert.equal(manifest.name, 'Awais Codex');
  });

  test('assistant and share pages are branded Awais Codex', () => {
    assert.ok(read('web/welcome.js').includes('Awais Codex'));
    assert.ok(read('server/share.ts').includes('Awais Codex'));
  });
});

describe('third-party scrub', () => {
  for (const file of SCAN_FILES) {
    test(`no product words in user-visible text of ${file}`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} should exist`);
      const blob = userVisibleText(read(file), file);
      for (const re of BANNED) {
        const m = blob.match(re);
        assert.ok(
          !m,
          `${file} mentions a third-party product: "${m?.[0]}" near "...${blob
            .slice(Math.max(0, (m?.index ?? 0) - 60), (m?.index ?? 0) + 60)
            .replace(/\s+/g, ' ')}..."`,
        );
      }
    });
  }
});
