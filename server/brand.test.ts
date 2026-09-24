/**
 * Brand + third-party scrub tests.
 *
 * The product must look like it was made by Awais Ali: the brand is
 * "WAIS" everywhere a user can see, the credit names him, and no
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
  test('page title is WAIS', () => {
    assert.ok(read('web/index.html').includes('<title>WAIS</title>'));
  });

  test('login screen and header carry the brand', () => {
    const html = read('web/index.html');
    assert.ok(html.includes('Leave it all to WAIS'));
    assert.ok(html.includes('id="topbar-title">WAIS'));
    assert.ok(html.includes('>WAIS</span>'));
  });

  test('credit names Awais Ali', () => {
    assert.ok(read('web/index.html').includes('Created by Awais Ali'));
    assert.ok(read('server/share.ts').includes('Created by Awais Ali'));
  });

  test('manifest names the app WAIS', () => {
    const manifest = JSON.parse(read('web/manifest.json')) as { name: string; short_name: string };
    assert.equal(manifest.name, 'WAIS');
    assert.equal(manifest.short_name, 'WAIS');
  });

  test('assistant and share pages are branded WAIS', () => {
    assert.ok(read('web/welcome.js').includes('WAIS'));
    assert.ok(read('server/share.ts').includes('WAIS'));
  });

  test('no surface still says the old name', () => {
    // Every place a person can read the product's name: the app, the install
    // prompt, the replay page, the boot banner, the messages WhatsApp sends, the
    // commits this server writes to GitHub, and the identity the agent is told
    // it has.
    for (const file of [
      'web/index.html',
      'web/app.js',
      'web/welcome.js',
      'web/manifest.json',
      'server/share.ts',
      'server/main.ts',
      'server/verify.ts',
      'server/routes/github.ts',
      'server/whatsapp/alerts.ts',
      'memory-engine.ts',
      'metadata.json',
    ]) {
      assert.ok(!read(file).includes('Awais Codex'), `${file} still shows the old name`);
    }
  });

  test('the rename did not touch the three identifiers that must never change', () => {
    // These are not brand surface, they are load-bearing:
    //  - the AAD prefix every stored secret was encrypted under,
    //  - the service id monitors and /healthz consumers key off,
    //  - the deployed host baked into share links and the APK.
    assert.ok(read('server/crypto.ts').includes("const AAD_PREFIX = 'awais-codex:secret:'"));
    assert.ok(read('server/app.ts').includes("service: 'awais-codex'"));
    // The host is not written in the code — it comes from APP_URL — so the guard
    // is that the code still *takes* it from the environment rather than
    // inventing a name of its own.
    assert.ok(read('server/config.ts').includes("appUrl: (env.APP_URL ?? '').trim()"));
  });
});

/**
 * The mark.
 *
 * One drawing, three consumers: the favicon (web/icon.svg), the PWA icons that
 * are rendered from it (`npm run icons`), and the two inline copies on the
 * login and welcome screens. These tests pin the parts that break silently —
 * a missing gradient id renders black, a missing file is an invisible icon, and
 * a duplicated id means whichever copy the browser sees first wins.
 */
describe('logo', () => {
  test('web/icon.svg is the WAIS mark, not a placeholder', () => {
    const svg = read('web/icon.svg');
    assert.ok(svg.includes('viewBox="0 0 100 100"'), 'it is a square viewBox');
    assert.ok(svg.includes('id="wais-mark"'), 'the monogram is a group the icon script can scale');
    assert.ok(svg.includes('aria-label="WAIS"'));
    // The three stops that make it the product's mark and not a generic glyph.
    assert.ok(svg.includes('#c2613e'), 'the spark carries the accent colour');
    assert.ok(svg.includes('#0f0e16'), 'the badge has its own dark ground');
  });

  test('the page loads the mark and the PWA icons', () => {
    const html = read('web/index.html');
    assert.ok(html.includes('href="/icon.svg"'));
    assert.ok(html.includes('href="/apple-touch-icon.png"'));
    const manifest = JSON.parse(read('web/manifest.json')) as {
      icons: Array<{ src: string; purpose?: string }>;
    };
    const sources = manifest.icons.map((i) => i.src);
    for (const src of ['/icon.svg', '/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-512x512.png']) {
      assert.ok(sources.includes(src), `${src} is declared`);
    }
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'Android needs a maskable icon');
    for (const icon of manifest.icons) {
      assert.ok(fs.existsSync(path.join(ROOT, 'web', icon.src)), `${icon.src} exists`);
    }
  });

  test('the logo is on the welcome screen, animated', () => {
    const html = read('web/index.html');
    assert.ok(html.includes('badge-hero'), 'the welcome screen shows the mark');
    assert.ok(html.includes('class="hero-name">WAIS'), 'with the name under it');
    const css = read('web/styles.css');
    assert.ok(css.includes('@keyframes badge-write'), 'the W draws itself in');
    assert.ok(css.includes('@keyframes badge-spark'), 'the spark lands');
    assert.ok(css.includes('@keyframes rise-in'), 'the screen arrives, it does not appear');
  });

  test('every inline copy has its own gradient ids', () => {
    const html = read('web/index.html');
    const ids = [...html.matchAll(/id="(wa-[a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 8, `expected both badge copies to define gradients, saw ${ids.length}`);
    assert.equal(new Set(ids).size, ids.length, 'duplicate ids would make the second copy borrow the first');
  });

  test('the animation still stops for anyone who asked it to', () => {
    const css = read('web/styles.css');
    const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    assert.ok(reduce.includes('animation-duration: .01ms'), 'motion is opt-out, always');
  });
});

/**
 * One word, everywhere — over the whole shipped surface, not a list of files.
 *
 * "Mission" is the word this product used before it was called WAIS: the model
 * is *told* to plan "this mission", names its notes "Mission:", and then echoes
 * every one of those words back in the answer the operator reads. Renaming the
 * interface while leaving the wire prompts alone produced exactly that — an
 * answer that talked about missions while the button underneath said task.
 *
 * The first version of this block listed the files it checked by hand: four
 * wire prompts, five client files. The server had sixty-odd by then, and
 * everything the list missed kept saying "mission" where people could read it —
 * the Settings copy, the download errors, the WhatsApp plan replies, the boot
 * banners, and the UI design guide the model is handed before it builds a page.
 * A list maintained by hand is a list that falls behind, so this test walks the
 * tree instead: every non-test source under `server/` and `web/`, plus the
 * operator's own CLI, plus the shipped docs the model reads.
 *
 * Internal identifiers (`mission_steps.ts`, `getMissionSteps`, the SQL that
 * selects from the `mission_steps` table) are deliberately left alone: renaming
 * files and tables is churn nobody reads.
 */
describe('the product says task, never mission', () => {
  /** Every non-test file under `dir` whose name matches `exts`. */
  function shippedSources(dir: string, exts: RegExp): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return shippedSources(rel, exts);
      // Tests are allowed to name the old word: they are how anyone finds out
      // it is gone. They never ship.
      if (/\.test\.[cm]?ts$/.test(entry.name)) return [];
      return exts.test(entry.name) ? [rel] : [];
    });
  }

  const SCANNED = [
    ...shippedSources('server', /\.(ts|md)$/),
    ...shippedSources('web', /\.(js|html|json)$/),
    'scripts/verify-integrations.ts',
  ];

  /**
   * Every string in a file, comments already gone and `${…}` interpolations
   * removed — the *value* of an interpolation is a variable, and a variable
   * called `mission` is code, not copy. Markdown is prose all the way down, so
   * a `.md` file is scanned whole.
   */
  function literals(file: string): string[] {
    const raw = read(file);
    if (file.endsWith('.md')) return [raw];
    const code = stripComments(raw);
    return [...code.matchAll(STRING_RE)].map((m) => m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, ''));
  }

  /**
   * Code rather than copy: a bare identifier (`recordMissionStep`), a module
   * path (`./mission_steps.js`), or a query that names an internal table. None
   * of these is prose, and a query starts with a SQL verb.
   */
  function isInternal(literal: string): boolean {
    const t = literal.trim();
    if (/^[A-Za-z_$][\w$.]*$/.test(t)) return true;
    if (/^\.{1,2}\/[\w./-]+$/.test(t)) return true;
    return /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER)\b/i.test(t);
  }

  test('nothing a person or the model can read says mission', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      for (const literal of literals(file)) {
        if (isInternal(literal)) continue;
        if (/mission/i.test(literal)) {
          offenders.push(`${file}: ${literal.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} file(s) still say "mission" where they can be read:\n${offenders.join('\n')}`,
    );
  });

  test('the files that carry the wording are actually in the scan', () => {
    // A tree walk that silently lists nothing would pass the test above, so
    // hold a few of the surfaces that have to be covered.
    for (const file of [
      'server/runs.ts',
      'server/settings.ts',
      'server/whatsapp/approvals.ts',
      'server/ui-design-guide.md',
      'server/routes/artifacts.ts',
      'web/app.js',
      'scripts/verify-integrations.ts',
    ]) {
      assert.ok(SCANNED.includes(file), `${file} should be scanned for wording`);
    }
    assert.ok(SCANNED.length > 55, `expected the whole shipped surface, got ${SCANNED.length} files`);
  });

  test('the exact sentences that used to say mission now say task', () => {
    assert.ok(read('server/planning.ts').includes('this task is complex'));
    assert.ok(read('server/planning.ts').includes('do NOT start the task yet'));
    assert.ok(read('server/planning.ts').includes('during this task — Gmail'));
    assert.ok(read('server/executor.ts').includes('Work this task exhaustively'));
    assert.ok(read('server/executor.ts').includes('This is the SAME task'));
    assert.ok(read('server/executor.ts').includes('Continue the task with these results'));
    assert.ok(read('server/executor.ts').includes('Task:\\n${mission}'));
    assert.ok(read('server/design.ts').includes('this task involves designing'));
    // The guide the model reads before it builds a page, and the two places the
    // operator meets the same word: Settings and the WhatsApp plan replies.
    // Rewritten when the guide stopped prescribing one house style, so the
    // pinned sentence is the new opening — the guarantee it carries is the same
    // one: the model is addressed with a task, never with a mission.
    assert.ok(read('server/ui-design-guide.md').includes('A direction has been chosen for this task'));
    assert.ok(read('server/settings.ts').includes('Takes effect on the next task'));
    assert.ok(read('server/whatsapp/approvals.ts').includes('the task is running now'));
    assert.ok(read('server/mission_steps.ts').includes('RESUMING an interrupted task'));
  });

  test('what the operator reads after a failure says task too', () => {
    const engine = read('server/engine/antigravity.ts');
    assert.ok(engine.includes('The task was closed so the slot stays free'));
    assert.ok(engine.includes('rate-limited the task'));
    assert.ok(engine.includes('refused the task or hit a limit'));
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
