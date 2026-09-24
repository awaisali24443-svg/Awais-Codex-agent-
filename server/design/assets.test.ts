/**
 * The asset kit has one job: make a page look finished without a photograph,
 * a key or a network. These tests hold it to that — no external URLs, nothing
 * that moves without a reduced-motion escape, snippets that are code rather than
 * description, and a kit that is filtered to the direction so it stays an
 * instruction instead of a menu.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ASSETS, assetKit, assetsFor } from './assets.js';

describe('every asset is usable as it stands', () => {
  test('nothing reaches for the network', () => {
    // The freemium constraint, in one rule: a data URI is a technique, a CDN is
    // a dependency that breaks on a metered phone with no signal.
    for (const asset of ASSETS) {
      assert.ok(!/https?:\/\//.test(asset.code.replace(/xmlns='http:\/\/www\.w3\.org\/2000\/svg'/g, '')), `${asset.id} links out`);
      const urls = asset.code.match(/url\(([^)]+)\)/g) ?? [];
      for (const url of urls) {
        assert.ok(/url\((["']?data:|#|var\(|"g1"|"g2")/.test(url) || /url\(#[a-z0-9]+\)/i.test(url), `${asset.id} has an unfetchable reference: ${url}`);
      }
    }
  });

  test('anything that moves stops moving when the reader asks', () => {
    for (const asset of ASSETS) {
      const moves = /animation|@keyframes|transition/.test(asset.code);
      if (!moves) continue;
      assert.ok(
        asset.code.includes('prefers-reduced-motion: no-preference'),
        `${asset.id} animates without a reduced-motion guard`,
      );
      // And only ever transform/opacity: a layout animation on a decorative
      // layer is the same defect the quality gate flags.
      assert.ok(!/(animation|transition)[^;]*\b(width|height|top|left|margin|padding)\b/i.test(asset.code), `${asset.id} animates a layout property`);
    }
  });

  test('the snippets are code, and they are balanced', () => {
    for (const asset of ASSETS) {
      assert.ok(asset.code.length > 80, `${asset.id} is a real snippet`);
      assert.ok(asset.note.length > 40, `${asset.id} says what it is for`);
      const open = (asset.code.match(/\{/g) ?? []).length;
      const close = (asset.code.match(/\}/g) ?? []).length;
      assert.equal(open, close, `${asset.id} has unbalanced braces`);
      const parens = (asset.code.match(/\(/g) ?? []).length - (asset.code.match(/\)/g) ?? []).length;
      assert.equal(parens, 0, `${asset.id} has unbalanced parentheses`);
      // A snippet that declares nothing is prose: CSS declares with `:`, SVG
      // and HTML structure with a tag.
      assert.ok(/[:;]/.test(asset.code) || /[<>]/.test(asset.code), `${asset.id} is not markup`);
    }
  });

  test('no snippet names a product, and none of them says mission', () => {
    const banned = /\b(antigravity|manus|openai|chatgpt|claude|gemini|figma|tailwind|bootstrap|stripe|vercel)\b/i;
    for (const asset of ASSETS) {
      const blob = JSON.stringify(asset);
      assert.ok(!banned.test(blob), `${asset.id} names a product`);
      assert.ok(!/\bmission\b/i.test(blob), `${asset.id} says mission`);
    }
  });
});

describe('the kit is filtered, so it stays an instruction', () => {
  test('a direction gets its own techniques plus the universal ones', () => {
    const universal = ASSETS.filter((a) => a.directions.length === 0).map((a) => a.id);
    const organica = assetsFor('organica').map((a) => a.id);
    assert.ok(universal.every((id) => organica.includes(id)), 'the universal ones always travel');
    assert.ok(organica.includes('blob'), 'and the direction-specific ones do');
    assert.ok(!organica.includes('halftone'), 'but a printed dot field does not belong on a wellness page');
    assert.ok(assetsFor('neo-brutal').map((a) => a.id).includes('halftone'));
    assert.ok(assetsFor('cinematic').map((a) => a.id).includes('scrim'), 'legibility over media is a cinematic problem');
  });

  test('with no direction known, everything is available; with a wrong one, only the universal set', () => {
    // No direction at all means nothing has been chosen yet, so nothing is
    // withheld. An unrecognised id is different: the safe answer is the
    // techniques that suit every direction, never another direction's.
    assert.equal(assetsFor(null).length, ASSETS.length);
    const universal = ASSETS.filter((a) => a.directions.length === 0).map((a) => a.id);
    assert.deepEqual(assetsFor('not-a-direction').map((a) => a.id), universal);
  });

  test('the injected kit names every asset it includes, and stays under budget', () => {
    const kit = assetKit('nocturne');
    for (const asset of assetsFor('nocturne')) {
      assert.ok(kit.includes(asset.name), `${asset.id} is named`);
      assert.ok(kit.includes(asset.code), `${asset.id} arrives with its code`);
    }
    assert.ok(kit.includes('no stock library'), 'and says why the kit exists');
    assert.ok(kit.length < 9_000, `kit is ${kit.length} chars — too much to inject`);
  });

  test('every kind of asset is represented, so no direction gets a thin kit', () => {
    const kinds = new Set<string>(ASSETS.map((a) => a.kind));
    for (const kind of ['gradient', 'texture', 'treatment', 'illustration']) {
      assert.ok(kinds.has(kind), `the kit has a ${kind}`);
    }
    for (const id of ['nocturne', 'atelier', 'kinetic', 'cinematic', 'neo-brutal', 'organica', 'blueprint', 'retail'] as const) {
      assert.ok(assetsFor(id).length >= 4, `${id} gets at least four techniques`);
    }
  });
});
