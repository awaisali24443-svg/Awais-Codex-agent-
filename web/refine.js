/**
 * Refinement: the five follow-up runs that turn one attempt into a result.
 *
 * A build is never finished on the first pass — every good builder's last 20%
 * is reworking what is already there. WAIS had no way to do that: the only move
 * available on a finished card was to describe the whole page again and hope.
 *
 * So the chips are fixed, their prompts are written here rather than left to
 * the operator to compose, and each one is a small, specific change to the
 * existing files. Two rules make them honest:
 *
 *   - Every prompt names what to change and what to leave alone. "Make it
 *     bolder" alone is a new brief; "push the display type one step and leave
 *     the palette" is a refinement.
 *   - Nothing is sent by tapping a chip. It fills the composer, the operator
 *     reads it, and the operator sends it — the same rule as voice transcripts.
 *
 * `Different direction` is the one chip that needs facts from the server: which
 * three directions the build was offered. They arrive on the run's own event,
 * so a chip can never offer a direction whose recipe does not exist.
 */

/**
 * The direction a run announced: what was built, why, and the alternates the
 * operator was offered instead. Every field is optional because a card can be
 * replayed from an event written before some of them existed.
 *
 * @typedef {object} Direction
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [blurb]
 * @property {string} [why]
 * @property {Array<{ id: string, name: string, blurb: string }>} [chips]
 */

/**
 * The four refinements that apply to any build, with the direction named.
 * @param {string} [name]
 */
export function baseRefinements(name = 'the current direction') {
  return [
    {
      id: 'bolder',
      label: 'Bolder',
      prompt:
        `Rework the page you just built: make it bolder. Push the display type up one step (still one clamp() scale), ` +
        `raise the contrast between the hero and everything under it, and let one section be genuinely loud. ` +
        `Keep ${name}, keep the palette tokens, and change nothing else.`,
    },
    {
      id: 'calmer',
      label: 'Calmer',
      prompt:
        `Rework the page you just built: calm it down. Ease one step off the loudest surface, widen the space between ` +
        `sections, and drop the least necessary element. Keep ${name} and keep the structure — this is a quieter ` +
        `version of the same page, not a different one.`,
    },
    {
      id: 'motion',
      label: 'More motion',
      prompt:
        `Rework the page you just built: add motion, in the one place it earns attention — the signature moment. ` +
        `Transform and opacity only, one curve, and the reduced-motion version must still read as finished. ` +
        `Keep everything else still: no scroll reveals, no hover lifts, no parallax.`,
    },
    {
      id: 'copy',
      label: 'Refine the copy',
      prompt:
        `Rework the copy on the page you just built. Every string should be final, specific and about this business — ` +
        `no sentence that could describe any company. Prices and hours stay facts. Do not touch the layout or the ` +
        `direction.`,
    },
  ];
}

/**
 * The chips for a finished build: the refinements, then a way out of the chosen
 * direction — built from the alternates the run was actually offered.
 * @param {Direction | null} [direction]
 */
export function refinementChips(direction = null) {
  const name = direction?.name ? direction.name : 'the current direction';
  const chips = baseRefinements(name);
  for (const alternate of direction?.chips ?? []) {
    chips.push({
      id: `direction:${alternate.id}`,
      label: `→ ${alternate.name}`,
      prompt:
        `Rebuild the page in ${alternate.name} — ${alternate.blurb}. Keep the copy the operator approved and the ` +
        `page structure where it still holds; change the direction, and the whole page with it.`,
    });
  }
  return chips;
}

/**
 * The direction line for a finished card: what was built, and why that one.
 * @param {Direction | null} [direction]
 */
export function directionLine(direction) {
  if (!direction?.name) return '';
  const why = direction.why ? ` (${direction.why})` : '';
  return `Direction: ${direction.name} — ${direction.blurb}${why}`;
}
