/**
 * The asset kit: imagery a page can have without a paid API, a stock library,
 * or a photograph the operator never supplied.
 *
 * The recipes tell the model to generate its imagery — mesh gradients, grain,
 * duotone treatment, procedural illustration — and until now it had to invent
 * the technique each time it was asked. That is exactly where generated pages
 * fall back to the same safe blur, or to nothing at all, so the page ends up as
 * text on a coloured rectangle.
 *
 * So the techniques are here, as code. Every snippet is self-contained CSS or an
 * inline SVG data URI: no network at runtime, no key, no build step, and it
 * degrades to a flat colour rather than a broken image. That is the freemium
 * constraint holding — the honest limit is that photoreal product photography
 * still cannot be generated, so the kit is written to make a page look finished
 * without a single photograph.
 *
 * Two rules the snippets keep, and the tests enforce:
 *   - `transform` and `opacity` only if anything moves, behind
 *     `prefers-reduced-motion`, so the reduced version is still complete.
 *   - No external URLs. A data URI is a technique; a CDN is a dependency.
 */
import type { DirectionId } from './types.js';

/** The kinds of asset a build can reach for. */
export type AssetKind = 'gradient' | 'texture' | 'treatment' | 'illustration';

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  /** One line saying what it is for, and what it is not. */
  note: string;
  /** The snippet, as written into the page. */
  code: string;
  /** Directions it belongs to. Empty means it belongs to all of them. */
  directions: DirectionId[];
}

/** The kit. Ordered so the most widely useful techniques come first. */
export const ASSETS: readonly Asset[] = [
  {
    id: 'mesh',
    name: 'Mesh gradient field',
    kind: 'gradient',
    note: 'Soft, wide, generated light. A background, not a banner — keep it under the content and below 40% opacity.',
    code: `.mesh {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background:
    radial-gradient(60% 55% at 18% 22%, color-mix(in srgb, var(--a) 55%, transparent), transparent 70%),
    radial-gradient(50% 50% at 82% 30%, color-mix(in srgb, var(--b) 45%, transparent), transparent 72%),
    radial-gradient(70% 60% at 50% 92%, color-mix(in srgb, var(--c) 40%, transparent), transparent 75%);
  filter: blur(24px) saturate(115%);
}`,
    directions: [],
  },
  {
    id: 'grain',
    name: 'Grain overlay',
    kind: 'texture',
    note: 'A single inline SVG, so there is no file to fetch and no flash. 2–5% is the range; more than that is a texture, not a surface.',
    code: `.grain::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  mix-blend-mode: overlay;
}`,
    directions: [],
  },
  {
    id: 'grid',
    name: 'Hairline grid',
    kind: 'texture',
    note: 'A drawn grid: two repeating gradients, one fine and one coarse. It is structure, so put it behind text at low contrast, never through it.',
    code: `.grid-bg {
  background-image:
    repeating-linear-gradient(to right, var(--hairline) 0 1px, transparent 1px 40px),
    repeating-linear-gradient(to bottom, var(--hairline) 0 1px, transparent 1px 40px);
  background-size: 40px 40px, 40px 40px;
}`,
    directions: ['blueprint', 'nocturne', 'neo-brutal'],
  },
  {
    id: 'aurora',
    name: 'Slow aurora',
    kind: 'gradient',
    note: 'The one moving background in the kit. It drifts for twenty seconds and stops entirely when motion is reduced, which is the only reason it is allowed.',
    code: `.aurora { position: absolute; inset: -20%; pointer-events: none;
  background: conic-gradient(from 180deg at 50% 50%, var(--a), var(--b), var(--c), var(--a));
  filter: blur(60px) saturate(130%); opacity: .45;
}
@media (prefers-reduced-motion: no-preference) {
  .aurora { animation: aurora-drift 20s ease-in-out infinite alternate; }
  @keyframes aurora-drift {
    from { transform: rotate(0deg) scale(1); }
    to   { transform: rotate(12deg) scale(1.08); }
  }
}`,
    directions: ['nocturne', 'cinematic', 'organica'],
  },
  {
    id: 'duotone',
    name: 'Duotone treatment',
    kind: 'treatment',
    note: 'Makes any image belong to the palette: greyscale, then the accent multiplied back in. Use it on supplied or generated media so nothing arrives in a colour the page did not choose.',
    code: `.duotone { position: relative; isolation: isolate; }
.duotone > img, .duotone > .generated { filter: grayscale(1) contrast(1.08); }
.duotone::before {
  content: ''; position: absolute; inset: 0; z-index: 1; mix-blend-mode: multiply;
  background: linear-gradient(140deg, var(--a), var(--b));
  opacity: .55;
}`,
    directions: ['atelier', 'cinematic', 'kinetic', 'retail'],
  },
  {
    id: 'abstract',
    name: 'Generated abstract frame',
    kind: 'illustration',
    note: 'The answer to "there is no photograph": a composed frame of layered gradients and drawn shapes. It should look deliberate and abstract — never like a stock photo stand-in.',
    code: `<figure class="abstract" role="img" aria-label="Abstract composition in the page palette">
  <svg viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="var(--a)"/><stop offset="1" stop-color="var(--b)"/>
      </linearGradient>
      <radialGradient id="g2" cx=".3" cy=".2" r=".8">
        <stop offset="0" stop-color="var(--c)" stop-opacity=".85"/><stop offset="1" stop-color="var(--c)" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="800" height="600" fill="url(#g1)"/>
    <circle cx="560" cy="200" r="220" fill="url(#g2)"/>
    <path d="M0 470 Q 240 380 460 470 T 800 430 V600 H0Z" fill="var(--ink)" opacity=".18"/>
    <path d="M0 520 Q 300 440 800 500" stroke="var(--ink)" stroke-opacity=".35" fill="none" stroke-width="2"/>
  </svg>
</figure>`,
    directions: [],
  },
  {
    id: 'blob',
    name: 'Organic blob mask',
    kind: 'illustration',
    note: 'A soft organic shape for an image or a panel. Use it once or twice — a page of blobs reads as generated.',
    code: `.blob {
  border-radius: 62% 38% 46% 54% / 54% 46% 54% 46%;
  overflow: hidden;
  background: linear-gradient(150deg, var(--a), var(--b));
}
@media (prefers-reduced-motion: no-preference) {
  .blob { transition: border-radius 900ms cubic-bezier(.34,1.2,.64,1); }
  .blob:hover { border-radius: 44% 56% 60% 40% / 40% 60% 44% 56%; }
}`,
    directions: ['organica', 'retail'],
  },
  {
    id: 'scrim',
    name: 'Media scrim',
    kind: 'treatment',
    note: 'How type stays readable over an image without a text-shadow: two layers, a soft one and a hard one, so the bottom third is genuinely dark.',
    code: `.media { position: relative; }
.media::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(to top, rgb(10 10 11 / .88) 0%, rgb(10 10 11 / .35) 38%, transparent 68%),
    linear-gradient(to top, rgb(10 10 11 / .45), transparent 22%);
}
.media > .caption { position: relative; z-index: 2; color: var(--paper); }`,
    directions: ['cinematic', 'retail', 'atelier'],
  },
  {
    id: 'halftone',
    name: 'Halftone dots',
    kind: 'texture',
    note: 'A printed dot field, flat and deliberate. It is a flat colour field — do not put it under body copy.',
    code: `.halftone {
  background-image: radial-gradient(currentColor 1.2px, transparent 1.3px);
  background-size: 8px 8px;
  opacity: .5;
}`,
    directions: ['neo-brutal', 'kinetic'],
  },
];

/** The assets a direction may reach for: its own, plus the universal ones. */
export function assetsFor(directionId?: DirectionId | string | null): readonly Asset[] {
  return ASSETS.filter(
    (asset) => asset.directions.length === 0 || (directionId ? asset.directions.includes(directionId as DirectionId) : true),
  );
}

/**
 * The kit as the model is handed it.
 *
 * Only the direction's own assets plus the universal ones travel, because the
 * kit is an instruction and not a library: handing over a halftone on a
 * fashion page is how a direction turns into a menu.
 */
export function assetKit(directionId?: DirectionId | string | null): string {
  const assets = assetsFor(directionId);
  const lines = [
    'ASSET KIT — generate the imagery. There is no stock library, no image API and no',
    'asset host here, so every image on this page is one of these techniques, a supplied',
    'file, or drawn. Each snippet is complete: paste it, add the palette variables, and',
    'it renders. Never link an image from another site.',
  ];
  for (const asset of assets) {
    lines.push('', `── ${asset.name} (${asset.kind}) ── ${asset.note}`, asset.code);
  }
  lines.push(
    '',
    'If the operator supplied images, use them and treat them with the duotone rather',
    'than shipping their original colours next to a palette that does not match.',
  );
  return lines.join('\n');
}
