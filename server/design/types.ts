/**
 * Shared types for the design engine.
 *
 * Kept in its own file so `directions.ts` (content) and `gate.ts` (checks) can
 * both depend on the vocabulary without depending on each other.
 */

/** The eight art directions, as ids. */
export type DirectionId =
  | 'nocturne'
  | 'atelier'
  | 'kinetic'
  | 'cinematic'
  | 'neo-brutal'
  | 'organica'
  | 'blueprint'
  | 'retail';

/** How a direction came to be the one being built. */
export type DirectionSource = 'brief' | 'operator' | 'default';
