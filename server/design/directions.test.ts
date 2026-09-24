/**
 * The direction registry is content, and content rots quietly.
 *
 * These tests are the four ways it could rot without anyone noticing: two
 * directions converging on the same look, a recipe that ships without don'ts,
 * a recipe so long it costs more than it is worth, a shipped string naming a
 * product, and a selection that is not explainable. Each one is a fact about
 * the text, so each is checkable here rather than discovered in a generated
 * page months later.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTIONS,
  directionPayload,
  parseDirectionReply,
  briefChoseDirection,
  chipDirections,
  describeDirection,
  directionById,
  pickDirection,
  rankDirections,
  recipeFor,
} from './directions.js';

describe('the directions are eight, and they are not variations of one', () => {
  test('all eight exist, with unique ids and names', () => {
    assert.equal(DIRECTIONS.length, 8);
    assert.equal(new Set(DIRECTIONS.map((d) => d.id)).size, 8);
    assert.equal(new Set(DIRECTIONS.map((d) => d.name)).size, 8);
    for (const d of DIRECTIONS) {
      assert.ok(d.blurb.length > 12, `${d.id} has a blurb an operator can read`);
      assert.ok(d.blurb === d.blurb.trim());
    }
  });

  test('every direction decides all seven things, with real values', () => {
    // A direction that leaves one of these open is how pages drift back to the
    // same careful grey: the model fills the gap with its default taste.
    for (const d of DIRECTIONS) {
      for (const field of ['palette', 'type', 'space', 'radius', 'motion', 'texture', 'hero', 'moment'] as const) {
        assert.ok(d[field].length > 40, `${d.id}.${field} is a decision, not a placeholder`);
      }
      assert.ok(d.skeleton.length >= 6, `${d.id} has a page skeleton, not a section list`);
      assert.ok(d.fragments.length >= 2, `${d.id} shows its values as code`);
      assert.ok(d.never.length >= 3, `${d.id} says what it must not do`);
    }
  });

  test('no two directions make the same central decision', () => {
    // The point of the registry: two briefs, same model, same day, pages that
    // do not look like siblings.
    const byPalette = new Set(DIRECTIONS.map((d) => d.palette.slice(0, 40)));
    assert.equal(byPalette.size, 8, 'no two directions share a canvas rule');
    const byMotion = new Set(DIRECTIONS.map((d) => d.motion.slice(0, 40)));
    assert.equal(byMotion.size, 8, 'no two directions move the same way');
    const byHero = new Set(DIRECTIONS.map((d) => d.hero.slice(0, 30)));
    assert.equal(byHero.size, 8, 'no two directions open the page the same way');
  });

  test('the flat-against-soft split is real, not decorative', () => {
    // Radius is the cheapest tell that a page was generated: one value on
    // everything. Somewhere in these eight, zero has to be a deliberate answer.
    assert.equal(directionById('atelier')?.radius, '0. Edges are the design. No rounded images, no rounded cards, no pills.');
    assert.ok(directionById('neo-brutal')?.radius.startsWith('0'));
    assert.ok(directionById('blueprint')?.radius.includes('6px'));
    assert.ok(directionById('organica')?.radius.startsWith('24'));
  });
});

describe('a recipe is something the model can actually build from', () => {
  test('every direction produces the full recipe', () => {
    for (const d of DIRECTIONS) {
      const recipe = recipeFor(d);
      assert.ok(recipe.includes(`ART DIRECTION — ${d.name}`), `${d.id} names its direction`);
      for (const heading of ['PALETTE', 'TYPE', 'SPACE', 'RADIUS', 'MOTION', 'TEXTURE', 'HERO', 'PAGE SKELETON', 'THE SIGNATURE MOMENT', 'BUILD ORDER', 'NEVER, HERE']) {
        assert.ok(recipe.includes(heading), `${d.id} recipe has ${heading}`);
      }
      assert.ok(recipe.includes('tokens.css first'), 'tokens come before markup, always');
      // The hard ceiling on what a UI task costs: ~1.2k tokens of direction.
      assert.ok(recipe.length < 4_800, `${d.id} recipe is ${recipe.length} chars — over budget`);
    }
  });

  test('the generic shape is banned in every single recipe', () => {
    // This exact failure is why the work started. If it is not named in every
    // recipe, it comes back in whichever direction gets forgotten.
    for (const d of DIRECTIONS) {
      const recipe = recipeFor(d);
      assert.ok(/centred hero followed by three equal cards/.test(recipe), `${d.id} bans the default shape`);
      assert.ok(recipe.includes('Placeholder copy'), `${d.id} bans placeholder copy`);
    }
  });

  test('the recipe is generated from the fields, so it cannot drift from them', () => {
    const d = directionById('blueprint')!;
    const recipe = recipeFor(d);
    assert.ok(recipe.includes(d.palette));
    assert.ok(recipe.includes(d.motion));
    assert.ok(recipe.includes(d.moment));
    // And the skeleton is numbered rather than dashed off.
    assert.ok(recipe.includes(`1. ${d.skeleton[0]}`));
    assert.ok(recipe.includes(`${d.skeleton.length}. ${d.skeleton[d.skeleton.length - 1]}`));
  });
});

describe('selection is explainable, and the operator always outranks it', () => {
  test('the brief picks the direction it is actually about', () => {
    const cases: Array<[string, string]> = [
      ['a landing page for a jewellery atelier in Lahore', 'atelier'],
      ['build a docs site for our API with a reference table', 'blueprint'],
      ['a website for a music festival with a lineup', 'kinetic'],
      ['a travel site for a desert lodge with full-bleed photos', 'cinematic'],
      ['an online shop for a bakery, with prices and delivery', 'retail'],
      ['a portfolio for a design studio, brutal and loud', 'neo-brutal'],
      ['a wellness clinic site, soft and calm', 'organica'],
      ['a launch page for an AI security platform', 'nocturne'],
    ];
    for (const [brief, expected] of cases) {
      assert.equal(pickDirection(brief).id, expected, brief);
      assert.equal(briefChoseDirection(brief), true, brief);
    }
  });

  test('a brief that points nowhere falls back, and says it fell back', () => {
    const direction = pickDirection('make me a nice page');
    assert.equal(direction.id, 'nocturne');
    assert.equal(briefChoseDirection('make me a nice page'), false, 'the plan must not claim the brief chose');
    assert.equal(briefChoseDirection(''), false);
  });

  test('ranking is deterministic and stable for the same brief', () => {
    const brief = 'a shop for a boutique bakery with a menu and prices';
    const first = rankDirections(brief).map((d) => d.id);
    const second = rankDirections(brief).map((d) => d.id);
    assert.deepEqual(first, second);
    assert.equal(first.length, 8, 'every direction is ranked, so a swap is always possible');
    assert.equal(first[0], pickDirection(brief).id);
  });

  test('the chips never include the direction already chosen', () => {
    // Offering the choice you already made, as one of three alternatives, is
    // how a choice turns into a fake choice.
    for (const brief of ['a fashion launch', 'a data platform', 'nothing in particular']) {
      const chosen = pickDirection(brief).id;
      const chips = chipDirections(brief);
      assert.equal(chips.length, 3, brief);
      assert.ok(!chips.some((c) => c.id === chosen), `${brief}: chips exclude ${chosen}`);
      assert.equal(new Set(chips.map((c) => c.id)).size, 3);
    }
  });
});

describe('what ships must not name a product', () => {
  test('no direction text mentions a third-party company or model', () => {
    // `brand.test.ts` scans the shipped tree for these; the recipes are shipped
    // straight to the model, so they are subject to the same rule.
    // `linear` and `framer` are deliberately absent: they are CSS words here
    // (`linear-gradient`, `frame`), and a scrubber that flags its own
    // vocabulary gets switched off.
    const banned = /\b(antigravity|manus|openai|chatgpt|claude|gemini|figma|webflow|tailwind|bootstrap|stripe|vercel|notion|apple|google|microsoft|adobe)\b/i;
    for (const d of DIRECTIONS) {
      const blob = JSON.stringify(d);
      assert.ok(!banned.test(blob), `${d.id} names a product: ${blob.match(banned)?.[0]}`);
    }
    // Emoji and mood-board words are the other way a brief degrades: they are
    // not buildable and they are not checkable.
    for (const d of DIRECTIONS) {
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(JSON.stringify(d)), `${d.id} ships emoji`);
      assert.ok(!/\b(vibe|aesthetic)\b/i.test(d.blurb), `${d.id} blurb is a mood, not a description`);
    }
  });

  test('a direction is described in one line the operator can read', () => {
    assert.equal(describeDirection(directionById('organica')!), 'Organica — soft mesh gradients, rounded forms, asymmetric flow');
  });
});

describe('the payload tells the truth once somebody has answered', () => {
  test('a chosen direction is what the task announces, not what the brief would have picked', () => {
    // The bug this exists for: the payload re-derived the pick from the brief,
    // so a task pointed at Kinetic announced Nocturne and built Kinetic.
    const brief = 'Build a launch page for an AI security platform';
    assert.equal(pickDirection(brief).id, 'nocturne', 'the brief points at Nocturne');
    const payload = directionPayload(brief, 'kinetic');
    assert.equal(payload.id, 'kinetic');
    assert.equal(payload.name, 'Kinetic');
    assert.equal(payload.why, 'chosen before the build started', 'and says why it is that one');
  });

  test('the alternates never include the direction already being built', () => {
    const payload = directionPayload('a website for a fashion boutique', 'atelier');
    assert.equal(payload.chips.length, 3);
    assert.ok(!payload.chips.some((c) => c.id === 'atelier'), 'no chip offers to become what it already is');
  });

  test('an unknown or absent choice falls back to the brief, with the brief\u2019s own reason', () => {
    const brief = 'Build a website for a music festival';
    assert.equal(directionPayload(brief).id, 'kinetic');
    assert.equal(directionPayload(brief).why, 'the brief points here');
    assert.equal(directionPayload(brief, 'nothing-like-this').id, 'kinetic');
    assert.equal(directionPayload('make me a nice page').why, 'nothing in the brief pointed anywhere, so this is the default');
  });
});

describe('reading the answer off a phone keyboard', () => {
  const chips = [
    { id: 'atelier', name: 'Atelier' },
    { id: 'kinetic', name: 'Kinetic' },
    { id: 'blueprint', name: 'Blueprint' },
  ];

  test('a bare number picks the alternate that was listed in that place', () => {
    assert.deepEqual(parseDirectionReply('1', chips, 'nocturne'), { id: 'atelier' });
    assert.deepEqual(parseDirectionReply('2', chips, 'nocturne'), { id: 'kinetic' });
    assert.deepEqual(parseDirectionReply(' 3. ', chips, 'nocturne'), { id: 'blueprint' });
    assert.deepEqual(parseDirectionReply('option 2', chips, 'nocturne'), { id: 'kinetic' });
    // A number with no alternate behind it is not a choice.
    assert.equal(parseDirectionReply('4', chips, 'nocturne'), null);
  });

  test('"choose" keeps the proposal, however it is typed', () => {
    // "You choose" is the operator declining to choose; naming the proposal is
    // a different act, and the record keeps them apart.
    for (const text of ['choose', 'CHOOSE', 'you choose', 'wais choose', 'let wais choose', 'auto', 'up to you']) {
      assert.deepEqual(parseDirectionReply(text, chips, 'nocturne'), { auto: true }, text);
    }
    assert.deepEqual(parseDirectionReply('the default', chips, 'nocturne'), { id: 'nocturne' }, 'named, not declined');
    assert.deepEqual(parseDirectionReply('the one you proposed', chips, 'nocturne'), { id: 'nocturne' });
  });

  test('a direction typed by name is understood, with or without a verb', () => {
    assert.deepEqual(parseDirectionReply('atelier', chips, 'nocturne'), { id: 'atelier' });
    assert.deepEqual(parseDirectionReply('go with Blueprint', chips, 'nocturne'), { id: 'blueprint' });
    assert.deepEqual(parseDirectionReply('use kinetic', chips, 'nocturne'), { id: 'kinetic' });
  });

  test('yes, no and a change note are left alone', () => {
    // The reason this parser returns null instead of guessing: "yes" belongs to
    // the approval, and a change note that happens to contain a number must stay
    // a change note.
    for (const text of ['yes', 'no', 'approve', 'change: make the hero bigger', '', '   ', 'make it 2 lines shorter']) {
      assert.equal(parseDirectionReply(text, chips, 'nocturne'), null, text);
    }
  });

  test('a name that is not a direction is not invented', () => {
    assert.equal(parseDirectionReply('brutalist vaporwave', chips, 'nocturne'), null);
    assert.equal(parseDirectionReply('2', [], 'nocturne'), null, 'no alternates were offered');
  });
});
