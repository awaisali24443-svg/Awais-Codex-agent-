/**
 * Refinement chips are the difference between one attempt and a result, so the
 * prompts behind them are held to the same standard as any other text the model
 * receives: specific, bounded, and impossible to confuse with a new brief.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { baseRefinements, directionLine, refinementChips } from '../web/refine.js';

const DIRECTION = {
  id: 'nocturne',
  name: 'Nocturne',
  blurb: 'deep black canvas, emissive accents, glass and glow',
  why: 'the brief points here',
  chips: [
    { id: 'atelier', name: 'Atelier', blurb: 'near-silent editorial, huge space, one image, careful type' },
    { id: 'kinetic', name: 'Kinetic', blurb: 'type as the artwork, saturated blocks, hard cuts' },
    { id: 'blueprint', name: 'Blueprint', blurb: 'mono microtype, hairlines, tabular data, one signal accent' },
  ],
};

describe('the refinements a finished build offers', () => {
  test('all four are there, and each is a change rather than a new brief', () => {
    const chips = baseRefinements();
    assert.deepEqual(chips.map((c) => c.label), ['Bolder', 'Calmer', 'More motion', 'Refine the copy']);
    for (const chip of chips) {
      assert.ok(chip.prompt.length > 80, `${chip.id} prompt is a real instruction`);
      assert.ok(/rework|Rework/.test(chip.prompt), `${chip.id} says it is reworking what exists`);
      assert.ok(/keep|Keep|Do not touch|not a different one/.test(chip.prompt), `${chip.id} says what to leave alone`);
    }
  });

  test('the direction is named, so a chip cannot drift the style', () => {
    const bolder = baseRefinements('Atelier').find((c) => c.id === 'bolder');
    assert.ok(bolder?.prompt.includes('Keep Atelier'), bolder?.prompt);
    // And with no direction known, it says something true instead of nothing.
    assert.ok(baseRefinements()[0].prompt.includes('Keep the current direction'));
  });

  test('motion is bounded: one moment, transform and opacity, reduced motion intact', () => {
    const motion = baseRefinements().find((c) => c.id === 'motion');
    assert.ok(motion?.prompt.includes('Transform and opacity only'));
    assert.ok(motion?.prompt.includes('reduced-motion'));
    assert.ok(motion?.prompt.includes('Keep everything else still'), 'and the rest of the page is left alone');
  });

  test('a different direction offers the alternates the run was actually given', () => {
    // The chips come from the payload the server sent, which came from the same
    // registry the recipe did: a chip cannot offer a direction that has no
    // recipe behind it.
    const chips = refinementChips(DIRECTION);
    const alternates = chips.filter((c) => c.id.startsWith('direction:'));
    assert.deepEqual(alternates.map((c) => c.label), ['→ Atelier', '→ Kinetic', '→ Blueprint']);
    assert.ok(alternates[0].prompt.includes('Rebuild the page in Atelier — near-silent editorial'));
    assert.ok(alternates[0].prompt.includes('Keep the copy the operator approved'), 'the copy is not thrown away with the look');
  });

  test('with no direction known it still offers the four refinements, not a broken row', () => {
    assert.equal(refinementChips(null).length, 4);
    assert.equal(refinementChips({}).length, 4);
    assert.equal(refinementChips({ name: 'Organica', chips: [] }).length, 4);
  });

  test('nothing here can be sent by accident, and nothing says mission', () => {
    // The chips fill the composer; the operator sends. That is the contract, and
    // it lives in the client — but the prompt text has to be readable first.
    for (const chip of refinementChips(DIRECTION)) {
      assert.ok(!/\bmission\b/i.test(chip.prompt), `${chip.id} says mission`);
      assert.ok(!/\bmission\b/i.test(chip.label), `${chip.id} label says mission`);
      assert.ok(chip.prompt.length < 600, `${chip.id} prompt is ${chip.prompt.length} chars — too long to review`);
    }
  });

  test('the direction line is one sentence the operator can read', () => {
    assert.equal(
      directionLine(DIRECTION),
      'Direction: Nocturne — deep black canvas, emissive accents, glass and glow (the brief points here)',
    );
    assert.equal(directionLine(null), '');
    assert.equal(directionLine({ name: 'Kinetic', blurb: 'type as the artwork' }), 'Direction: Kinetic — type as the artwork');
  });
});
