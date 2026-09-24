/**
 * The interface audit, kept as a test.
 *
 * Every case here is something an audit of the shipped stylesheet and markup
 * found broken or unbalanced — a fix that is easy to undo by accident, because
 * none of it is visible in a function's signature:
 *
 *   - the toast was the app's only voice and sat *under* the outputs panel and
 *     the command palette, so "Copied" and "Could not save that" were invisible
 *     on exactly the two screens where you are most likely to do something
 *     worth confirming;
 *   - five inputs removed the browser's focus ring and none put one back, in an
 *     app that ships a ⌘K palette and arrow-key lists;
 *   - the phone's tap targets were 30–36px, below the 44px both Apple and
 *     Google publish;
 *   - the top bar carried five controls on a phone-width header;
 *   - the stylesheet had grown by appending and carried repeated blocks that
 *     had been superseded, which is how a stylesheet becomes unreadable.
 *
 * Structural assertions on the shipped files, in the spirit of
 * `web_client.test.ts`: cheap, and they fail the moment one of these comes
 * back.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const html = () => read('web/index.html');
const css = () => read('web/styles.css');
const app = () => read('web/app.js');

/** Strip comments: a `{` inside prose must not break the scan. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Block {
  selector: string;
  decls: Array<[string, string]>;
  media: string | null;
}

/** Every top-level block, with its at-rule context. */
function blocks(): Block[] {
  const text = stripComments(css());
  const out: Block[] = [];

  const walk = (body: string, media: string | null): void => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('{', i);
      if (open < 0) return;
      let depth = 1;
      let close = open + 1;
      while (close < body.length && depth > 0) {
        if (body[close] === '{') depth += 1;
        else if (body[close] === '}') depth -= 1;
        close += 1;
      }
      const selector = body.slice(i, open).trim();
      const inner = body.slice(open + 1, close - 1);
      if (selector.startsWith('@media') || selector.startsWith('@supports')) {
        walk(inner, selector.replace(/\s+/g, ' '));
      } else if (!selector.startsWith('@')) {
        out.push({
          selector,
          media,
          decls: inner
            .split(';')
            .map((d) => d.trim())
            .filter(Boolean)
            .map((d) => {
              const at = d.indexOf(':');
              return [d.slice(0, at).trim(), d.slice(at + 1).trim()] as [string, string];
            })
            .filter(([prop]) => prop.length > 0),
        });
      }
      i = close;
    }
  };
  walk(text, null);
  return out;
}

/** The last declaration wins, exactly as the browser resolves it. */
function effective(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const block of blocks()) {
    if (block.media !== null) continue; // breakpoint rules are additions, not overrides
    for (const selector of block.selector.split(',').map((s) => s.trim()).filter(Boolean)) {
      const known = out.get(selector) ?? new Map<string, string>();
      for (const [prop, value] of block.decls) known.set(prop, value);
      out.set(selector, known);
    }
  }
  return out;
}

/** The z-index a selector ends up with, at the last place it is declared. */
function zIndexOf(selector: string): number {
  const found = effective().get(selector)?.get('z-index');
  assert.ok(found, `${selector} declares no z-index`);
  return Number(found);
}

describe('the layers are in the right order', () => {
  test('the toast is on top of every surface that can cover it', () => {
    // It is the app's only voice. Under the panel and the palette, it spoke to
    // nobody exactly when it mattered.
    const toast = zIndexOf('.toast');
    // `.sheet` left this list with the mode modal it belonged to: the sheet
    // became an inline tray in the composer, so there is no overlay left for
    // the toast to hide under.
    for (const selector of ['.palette', '.palette-backdrop', '.panel', '.panel-backdrop', '.drawer', '.scrim']) {
      assert.ok(toast > zIndexOf(selector), `the toast is above ${selector}`);
    }
  });

  test('the ladder is written down where it is used', () => {
    assert.ok(css().includes('The stacking ladder, in one place'), 'the numbers are documented');
    assert.ok(/^\s*80\s+the toast/m.test(css()), 'including the toast, at the top');
  });

  test('an overlay never covers the thing that opened it', () => {
    assert.ok(zIndexOf('.palette') > zIndexOf('.panel'), 'the palette is above the artifact panel');
    assert.ok(zIndexOf('.panel') > zIndexOf('.drawer'), 'the panel is above the drawer');
    assert.ok(zIndexOf('.drawer') > zIndexOf('.scrim'), 'the drawer is above its own scrim');
  });
});

describe('the keyboard can see where it is', () => {
  test('every focus ring removal has a keyboard ring to replace it', () => {
    const stylesheet = stripComments(css());
    assert.ok(/:focus-visible\s*\{/.test(stylesheet), 'there is a ring');
    assert.ok(/:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none/.test(stylesheet), 'and a rule that removes it for pointers only');

    // No base rule may suppress the outline outright: that is what killed the
    // ring on the login field, the settings inputs and the palette's box.
    const offenders: string[] = [];
    for (const block of blocks()) {
      if (/:focus-visible/.test(block.selector)) continue;
      if (block.decls.some(([prop, value]) => prop === 'outline' && value === 'none')) {
        offenders.push(`${block.selector} (${block.media ?? 'top level'})`);
      }
    }
    assert.deepEqual(offenders, [], `outline: none outside a :focus-visible rule: ${offenders.join(', ')}`);
  });

  test('the ring is drawn where the container will not clip it', () => {
    // A ring 2px outside a row inside a scrolling list is a ring you cannot see.
    assert.ok(css().includes('.palette-row:focus-visible'), 'palette rows',
    );
    assert.ok(css().includes('outline-offset: -2px'), 'get an inside ring');
  });
});

/**
 * What a browser would actually apply to one element.
 *
 * A mini cascade, because the bug this guards against was a *specificity*
 * problem: `.composer .icon-btn.sm { width: 32px }` silently beat the touch
 * block's `.icon-btn.sm { width: 40px }`, and a test that only read the touch
 * block could not have seen it. So this resolves the winner the way the browser
 * does — specificity first, source order second — for an element described by
 * its classes and the classes of its ancestors.
 */
function winningValue(
  classes: string[],
  ancestors: string[],
  property: string,
  { coarse = false, tag = 'button' }: { coarse?: boolean; tag?: string } = {},
): { value: string; from: string } | null {
  const element = new Set(classes);
  const specificityOf = (selector: string): number => {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const classish = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    const types = (selector.replace(/[.#:\[][^\s>+~]*/g, ' ').match(/\b[a-z][\w-]*\b/g) ?? []).length;
    return ids * 100 + classish * 10 + types;
  };
  const matchesCompound = (compound: string): boolean => {
    const parts = compound.match(/\.[\w-]+/g) ?? [];
    if (!parts.every((part) => element.has(part.slice(1)))) return false;
    const types = (compound.replace(/[.#:\[][^\s>+~]*/g, ' ').match(/\b[a-z][\w-]*\b/g) ?? []).filter(
      (t) => t !== 'button' || tag === 'button',
    );
    // `button` in a selector has to match the element's own tag; anything else
    // (a stray word from a comment, say) disqualifies the compound.
    return types.every((t) => t === tag || t === '*');
  };
  const matchesSelector = (selector: string): boolean => {
    if (/[:\[>+~]/.test(selector)) return false; // state/child selectors: not the resting style
    const parts = selector.trim().split(/\s+/);
    const right = parts.pop() ?? '';
    if (!matchesCompound(right)) return false;
    return parts.every((part) => {
      const classesIn = part.match(/\.[\w-]+/g) ?? [];
      return classesIn.every((c) => ancestors.includes(c.slice(1)));
    });
  };

  let best: { value: string; from: string; weight: number; order: number } | null = null;
  let order = 0;
  for (const block of blocks()) {
    const inTouch = block.media !== null && /pointer:\s*coarse/.test(block.media);
    // A coarse-pointer device gets the base rules *and* the touch block: the
    // base rules are what the touch block overrides, and a more specific base
    // rule is exactly how the 32px button survived the first audit.
    const applies = block.media === null || (coarse && inTouch);
    if (!applies) {
      order += 1;
      continue;
    }
    const decl = block.decls.find(([prop]) => prop === property);
    order += 1;
    if (!decl) continue;
    for (const selector of block.selector.split(',').map((t) => t.trim())) {
      if (!matchesSelector(selector)) continue;
      const weight = specificityOf(selector) * 1000 + (inTouch ? 500 : 0) + order;
      if (!best || weight >= best.weight) best = { value: decl[1], from: selector, weight, order };
    }
  }
  return best ? { value: best.value, from: best.from } : null;
}

describe('a finger is not a cursor', () => {
  test('touch targets are at least 44px where a thumb does the pointing', () => {
    const touch = blocks().filter((b) => b.media !== null && /pointer:\s*coarse/.test(b.media));
    assert.ok(touch.length > 0, 'there is a coarse-pointer block');

    const sizes = new Map<string, string>();
    for (const block of touch) {
      for (const selector of block.selector.split(',').map((s) => s.trim())) {
        for (const [prop, value] of block.decls) {
          if (prop === 'width' || prop === 'min-width' || prop === 'min-height' || prop === 'height') {
            const bare = selector.replace(/^@media[^:]*::\s*/, '');
            sizes.set(`${bare}|${prop}`, value);
          }
        }
      }
    }
    assert.equal(sizes.get('.icon-btn|width'), '44px', 'a top-bar icon is 44px');
    assert.equal(sizes.get('.send|width'), '44px', 'send is 44px');
    assert.ok(sizes.has('.msg-btn.icon|min-width'), 'the answer actions get a real target too');
    assert.ok(sizes.has('.drawer-row|min-height'), 'and so do the drawer rows');
  });

  test('no more specific rule shrinks a target back down on touch', () => {
    // The cascade the flat check above cannot see. Each case is a real element
    // and its real ancestors.
    const cases: Array<{ what: string; classes: string[]; ancestors: string[]; min: number }> = [
      { what: 'the attach button', classes: ['icon-btn', 'sm'], ancestors: ['composer'], min: 40 },
      { what: 'the drawer close button', classes: ['icon-btn', 'sm'], ancestors: ['drawer'], min: 40 },
      { what: 'send', classes: ['send'], ancestors: ['composer'], min: 44 },
      { what: 'remove an attached file', classes: [], ancestors: ['attach-chip'], min: 32 },
      { what: 'move a plan step', classes: ['plan-move'], ancestors: ['plan-edit-row'], min: 36 },
      { what: 'drop a plan step', classes: ['plan-remove'], ancestors: ['plan-edit-row'], min: 36 },
    ];
    for (const entry of cases) {
      // Width or min-width: whichever the winning rule actually sets.
      const target =
        winningValue(entry.classes, entry.ancestors, 'width', { coarse: true }) ??
        winningValue(entry.classes, entry.ancestors, 'min-width', { coarse: true });
      assert.ok(target, `${entry.what} has a width`);
      const px = Number.parseInt(String(target?.value), 10);
      assert.ok(
        Number.isFinite(px) && px >= entry.min,
        `${entry.what} is ${target?.value} on a phone (from ${target?.from}), needs ${entry.min}px`,
      );
    }
  });

  test('the bigger targets cannot start a sideways scroll', () => {
    // The rule the phone screenshots taught: rows wrap, columns never widen.
    const row = effective().get('.composer-row');
    assert.equal(row?.get('flex-wrap'), 'wrap', 'the composer row wraps');
    assert.ok(!css().includes('width: 100vw'), 'and nothing is sized to the viewport');
  });
});

describe('the top bar is balanced', () => {
  test('four controls at most, and each one has a name', () => {
    // Five unlabelled icons in a phone-width header is a toolbar, not a header.
    const topbar = html().slice(html().indexOf('<header class="topbar"'), html().indexOf('</header>'));
    const buttons = [...topbar.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length <= 4, `the top bar carries ${buttons.length} buttons`);
    for (const button of buttons) {
      assert.match(button, /aria-label="[^"]+"/, `every top-bar control is named: ${button}`);
    }
    // The theme switch moved to the drawer, where it says the state in words.
    assert.ok(!topbar.includes('btn-theme'), 'the theme icon is gone from the top bar');
    assert.ok(html().includes('id="btn-theme-2"'), 'and lives in the drawer');
    assert.ok(app().includes("const mark = $('btn-theme-2')?.querySelector('svg');"), 'where its mark follows the setting');
  });

  test('every button says what it is, so no stray submit can fire', () => {
    const withoutType = [...html().matchAll(/<button[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/type=/.test(tag));
    assert.deepEqual(withoutType, [], 'every button carries a type');
  });
});

describe('the stylesheet does not grow by accident', () => {
  test('no block repeats what an earlier block already said', () => {
    // The cleanup this pins: `.composer-wrap`, `.send`, `.convo` and a dozen
    // others were declared three times with the same values, left behind by
    // successive rounds. A later block may *override* — that is how CSS is
    // meant to work — but a block that changes nothing is dead weight.
    const seen = new Map<string, Map<string, string>>();
    const noops: string[] = [];
    for (const block of blocks()) {
      if (block.media !== null) continue;
      const selectors = block.selector.split(',').map((s) => s.trim()).filter(Boolean);
      const isNoop =
        block.decls.length > 0 &&
        selectors.every((selector) => {
          const known = seen.get(selector);
          if (!known) return false;
          return block.decls.every(([prop, value]) => known.get(prop) === value);
        });
      if (isNoop) noops.push(block.selector);
      for (const selector of selectors) {
        const known = seen.get(selector) ?? new Map<string, string>();
        for (const [prop, value] of block.decls) known.set(prop, value);
        seen.set(selector, known);
      }
    }
    assert.deepEqual(noops, [], `blocks that repeat earlier declarations: ${noops.join(', ')}`);
  });

  test('the variables it uses exist', () => {
    const theme = read('web/theme.css');
    const used = new Set([...css().matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    const defined = new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !defined.has(name) && !css().includes(`${name}:`));
    assert.deepEqual(missing, [], `custom properties used but never defined: ${missing.join(', ')}`);
  });
});

describe('an icon cannot grow to fill its row', () => {
  test('the drawer sizes the icons itself, not their classes', () => {
    // The bug: `applyTheme` swapped the drawer row's mark by replacing the SVG's
    // markup, and the replacement had no class — so `.drawer-row-icon`'s 17px
    // never applied, and an inline SVG with no intrinsic size grew to the width
    // of the drawer. What shipped was a moon the size of a phone screen.
    assert.ok(css().includes('.drawer-row > svg'), 'the row sizes any icon inside it');
    assert.ok(/^\.drawer-row > svg,[\s\S]{0,80}flex: none/m.test(css()), 'with a fixed size and no flex growth');
  });

  test('every icon the client injects carries the class its styles expect', () => {
    const client = app();
    // The theme marks are injected as markup, so their class is part of the fix.
    const themeIcons = client.slice(client.indexOf('const THEME_ICONS'), client.indexOf('function themePreference'));
    const svgs = themeIcons.match(/<svg[^>]*>/g) ?? [];
    assert.ok(svgs.length >= 3, 'there are three theme marks');
    for (const svg of svgs) {
      assert.match(svg, /class="drawer-row-icon"/, `a theme mark without its class grows: ${svg}`);
    }
  });
});

describe('the small things a reader notices', () => {
  test('motion is opt-in everywhere it is used', () => {
    const animations = (css().match(/animation:/g) ?? []).length;
    const guards = (css().match(/prefers-reduced-motion/g) ?? []).length;
    assert.ok(guards >= 4, `reduced-motion is honoured (${guards} blocks for ${animations} animations)`);
    assert.ok(read('web/theme.css').includes('prefers-reduced-motion'), 'including at the theme level');
  });

  test('nothing in the app is a third-party product name', () => {
    // The other half of brand.test.ts, from the angle this round touched: these
    // two files were never in its scan list, and both were carrying borrowed
    // names in comments. A comment is read by anyone who opens the file.
    for (const word of ['manus', 'claude', 'gemini', 'chatgpt', 'superhuman', 'raycast']) {
      assert.ok(!new RegExp(word, 'i').test(css()), `styles.css keeps ${word} out`);
      assert.ok(!new RegExp(word, 'i').test(html()), `index.html keeps ${word} out`);
    }
    // Capitalised, because lowercase `linear` is a gradient and an easing.
    assert.ok(!/\bLinear\b/.test(css()), 'styles.css keeps the product name out');
    assert.ok(!/\bLinear\b/.test(read('web/theme.css')), 'theme.css too');
  });
});
