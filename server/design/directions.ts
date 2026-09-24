/**
 * Art directions: the eight ways WAIS is allowed to build a page.
 *
 * Before this the house style was one thing — "warm, minimal, quiet" — so every
 * page came out the same shade of careful: same spacing, same small type, same
 * restraint. Restraint is a valid answer for a settings screen and a terrible
 * one for a fashion launch, and the model had no way to know which it was
 * looking at. Worse, "minimal" quietly caps quality: a page where nothing is
 * allowed to be loud cannot have a signature moment, and a page without a
 * signature moment is the thing everyone recognises as "generated".
 *
 * So there is no longer one style. There are eight, each a complete decision —
 * canvas, type, space, radius, motion, texture, hero architecture, and the one
 * moment the page is remembered by — and the task picks one *before* it writes
 * a single file. A direction is not decoration: it is what makes two pages built
 * by the same model on the same day look like they were built by two studios.
 *
 * The rules that keep it honest:
 *
 *   - A direction is inert unless the task is building a UI (`looksLikeUiMission`
 *     in `design.ts` decides), so a research task pays nothing.
 *   - Selection is deterministic and explainable — keyword signals, best score
 *     wins, registry order breaks ties. The operator sees which one was chosen
 *     and why, and can swap it before any file exists.
 *   - Nothing here names a third-party product or company. Directions are
 *     described by their mechanics ("emissive accents on deep black"), because
 *     `brand.test.ts` walks the shipped tree and recipes are shipped.
 *   - Every direction says what it must NOT do. A style with no don'ts is a
 *     filter, not a style.
 */
import type { DirectionId } from './types.js';

export type { DirectionId };

/** One complete art direction, and the words the model is handed for it. */
export interface Direction {
  id: DirectionId;
  /** Shown to the operator on a chip: no jargon, no mood-board words. */
  name: string;
  /** One line saying what it looks like, for the plan and the chips. */
  blurb: string;
  /** What the brief must say for this direction to be the answer. */
  signals: RegExp;
  /** The canvas and the accent, stated as hex so there is no interpretation. */
  palette: string;
  /** Display and body faces as behaviour (weight, tracking, size range). */
  type: string;
  /** The spacing rhythm, in pixels, with the section padding called out. */
  space: string;
  /** Corner treatment — a number, or "none" when edges are the design. */
  radius: string;
  /** Durations and curves, plus what is allowed to animate. */
  motion: string;
  /** The surface: grain, glass, hairlines, meshes. */
  texture: string;
  /** The architecture of the first screen. */
  hero: string;
  /** The one moment the page is remembered by. */
  moment: string;
  /** Section-by-section skeleton, top to bottom. */
  skeleton: readonly string[];
  /** Two worked fragments, showing the direction as actual markup decisions. */
  fragments: readonly string[];
  /** What this direction specifically must never do. */
  never: readonly string[];
}

/**
 * Failures that are wrong in every direction, and the reason the share of
 * generated pages that get called "generic" get called that.
 */
const SHARED_NEVER = [
  'A centred hero followed by three equal cards and one gradient — the shape of every template ever generated.',
  'Blanket 8px radius on everything, or a shadow nobody chose.',
  'One font at three sizes, with headings barely larger than body text.',
  'Placeholder copy, lorem, "Lorem", "Your headline here", "TODO", "#" links.',
  'Default blue links and default focus rings on a page that chose everything else.',
  'Generic stand-in imagery: soft-focus blobs, abstract "technology" swirls, a smiling person at a laptop.',
  'Motion on layout properties (width, top, margin). Transform and opacity only.',
];

/**
 * The order of work, which is the single biggest quality lever in here.
 *
 * Tokens first is not tidiness: it is the reason a page looks like one page.
 * When the values exist before the markup does, every later decision is a
 * choice between a small set of already-considered options instead of a new
 * invention per element — and it gives the checker something objective to test
 * the result against ("this colour is not in tokens.css" is a fact, not taste).
 */
const BUILD_ORDER = [
  'tokens.css first: every value above becomes a custom property. Nothing written afterwards may hard-code a colour, size, radius or duration.',
  'The shell: header, hero, footer in the direction above, at 375px wide before anything is widened.',
  'Sections one at a time, top to bottom, each finished before the next is started.',
  'The signature moment last, once the page reads well without it.',
  'Then the passes: 320px, reduced motion, keyboard tab order, and reading every string aloud.',
];

/** The eight. Registry order is the tie-breaker for selection. */
export const DIRECTIONS: readonly Direction[] = [
  {
    id: 'nocturne',
    name: 'Nocturne',
    blurb: 'deep black canvas, emissive accents, glass and glow',
    signals: /\b(ai|saas|startup|dev ?tool|developer tool|dashboard|analytics|security|cyber|cybersecurity|crypto|fintech|infrastructure|automation|observability|agent|model|neural)\b/i,
    palette:
      'canvas #05060a (not grey — a real black), raised surface #0d1017, hairline rgba(255,255,255,.08), ink #f4f6fb, muted #98a2b8, ONE emissive accent (#6ee7ff or #a78bfa or #4ade80 — pick one and keep it), accent used at most on 3 elements per screen.',
    type:
      'Display: tight geometric sans, weight 600–700, size clamp(2.6rem, 8vw, 6rem), letter-spacing -0.03em, line-height .95. Body: 16–17px, line-height 1.65, max 68ch, muted. Labels: 11px, uppercase, letter-spacing .12em. Two faces maximum.',
    space:
      '8px base: 4 8 12 16 24 32 48 64 96 128. Section padding 96px mobile / 160px desktop. Hero min-height 100svh. Dense sections are allowed to touch 32px — the contrast between tight and vast is what makes the vast read as vast.',
    radius: '14px panels, 999px pills, 8px inputs. Never the same value everywhere.',
    motion:
      'Reveals 600ms cubic-bezier(.2,.8,.2,1), transform and opacity only. Parallax at 0.15 of scroll, on decorative layers only. Hover states 180ms. All of it inside @media (prefers-reduced-motion: no-preference).',
    texture:
      'Grain overlay at 3% (an inline SVG feTurbulence, mix-blend-mode: overlay), glass panels with backdrop-filter: blur(18px) saturate(140%), and one large radial gradient field bleeding off a corner as light source.',
    hero:
      'Full-bleed dark with a product artefact floating in perspective (transform: perspective(1200px) rotateX(6deg)), an emissive rim light along its top edge, and the headline set to the left of it rather than above it.',
    moment:
      'A scroll-driven sequence where a system diagram draws itself: hairlines extend, nodes light up in the accent, one connection pulses. It must degrade to a static diagram with no scroll input.',
    skeleton: [
      'Sticky header, translucent, border-bottom hairline only — no shadow, no filled bar.',
      'Hero: headline left, artefact right, one primary button plus one quiet text link.',
      'A single proof row: three metrics with tabular numerals, separated by hairlines, no boxes.',
      'The feature story as an asymmetric bento — one tile the size of two, one tall, two small.',
      'The drawing-itself diagram, with a two-sentence caption above it.',
      'One dense spec or comparison table on the darkest surface, hairlines only.',
      'Pricing or access: one bordered panel in the accent, two plain ones beside it.',
      'Footer: small, calm, real links, no newsletter box unless the brief asks for one.',
    ],
    fragments: [
      'Glass panel: background: color-mix(in srgb, #0d1017 72%, transparent); backdrop-filter: blur(18px) saturate(140%); border: 1px solid rgba(255,255,255,.08); border-radius: 14px;',
      'Emissive accent used as light, not as fill: box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent), 0 24px 80px -32px var(--accent);',
    ],
    never: [
      'Pastel gradients on a dark canvas, or neon on a light one.',
      'A coloured drop shadow doing the job of a border.',
      'More than one accent colour, or the accent on more than a few elements.',
      'Pure #000 or pure #fff anywhere — both read as defaults.',
    ],
  },
  {
    id: 'atelier',
    name: 'Atelier',
    blurb: 'near-silent editorial, huge space, one image, careful type',
    signals: /\b(fashion|jewel|luxur|perfume|cosmetic|beauty|couture|atelier|boutique|craft|ceramic|bakery|patisserie|restaurant|winery|cafe|tea|florist|tailor|handmade|gallery)\b/i,
    palette:
      'Warm off-white canvas #f7f4ef (never #fff), ink #16130f, muted #6b6259, hairlines #e2dbd1, and one warm metal accent (#b08d57) used so rarely it is almost a secret. Pure black text on pure white is a document, not a brand.',
    type:
      'Display: high-contrast serif, weight 400–500, size clamp(3rem, 8vw, 7.5rem), line-height 1.02, letter-spacing -0.02em, sentence case. Body 16px/1.7 in a neutral sans, 60ch maximum. Labels: 11px uppercase, letter-spacing .22em — the widest tracking on the page.',
    space:
      'Sections 160px apart on mobile, 240px on desktop. Text sits in a 60ch column that is never centred when an image is beside it. Margins can exceed the content width; that asymmetry is the style.',
    radius: '0. Edges are the design. No rounded images, no rounded cards, no pills.',
    motion:
      'Fades and image reveals only: 900ms ease-out opacity, and images that settle from scale(1.06) to 1. Nothing bounces, nothing slides sideways, nothing moves on hover except a hairline growing to full width under a link.',
    texture:
      'Paper grain at 2% over the whole page, no drop shadows at all, and hairlines doing every job a box would do elsewhere.',
    hero:
      'One full-bleed image with the title set at the bottom-left in the display serif across two lines, a one-line standfirst beneath it in small caps, and the first section starting immediately below the fold — no buttons in the hero unless the brief sells something.',
    moment:
      'A horizontal rail of images that drifts at 0.4x the scroll speed while the caption stays still, so the words hold their place and the world moves behind them.',
    skeleton: [
      'Header: wordmark in the display serif, four text links, no button, on one hairline.',
      'Hero: one full-bleed image, title bottom-left, standfirst in small caps.',
      'A statement paragraph alone on the page — no heading, big margins, 8 words or fewer.',
      'Three-part story: image, then text in a 60ch column, then image again, alternating sides.',
      'The drift rail with captions that stay put.',
      'A quiet list of details (materials, dates, hours) as a definition list, not cards.',
      'One invitation to act, set as a sentence with an underlining link — not a filled button.',
      'Footer: address, hours, two links, the year. Small.',
    ],
    fragments: [
      'Small-caps label: font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: var(--muted);',
      'Image reveal: clip-path: inset(0 0 0 0); transition: clip-path 900ms ease-out, transform 900ms ease-out; starting from clip-path: inset(6% 6% 6% 6%) and scale(1.06).',
    ],
    never: [
      'Cards, borders around images, or icons standing in for sentences.',
      'Bold sans-serif headlines — the serif is the whole voice.',
      'Centring everything.',
      'More than one accent, or the accent at full saturation.',
      'Filling space because it is empty. Empty is the point.',
    ],
  },
  {
    id: 'kinetic',
    name: 'Kinetic',
    blurb: 'type as the artwork, saturated blocks, hard cuts',
    signals: /\b(music|band|album|festival|concert|dj|sport|athlet|football|basketball|event|club|streetwear|sneaker|dance|exhibition|culture|film festival|nightlife|tour|competition|league)\b/i,
    palette:
      'Pick one: off-white #f2f0ea with ink #0b0b0b, or near-black #0b0b0b with #f2f0ea. Then ONE loud colour at full strength — acid lime #d7ff3e, hot coral #ff4d3d, or cobalt #2b3aff — as large flat fields, never as a thin tint. Saturation is the point; do not dilute it.',
    type:
      'Display: ultra-heavy grotesk or condensed, weight 800–900, clamp(4rem, 18vw, 14rem), line-height .82, letter-spacing -0.04em, text-transform: uppercase for the loud lines and sentence case for the quiet ones. Body 16px/1.6. Numbers set in tabular figures at display size.',
    space:
      'Tight and grid-breaking: 8px base with 16–40px section gaps, 4–8px gutters between blocks, and text allowed to run edge to edge. Sections butt against each other; the colour change is the separator.',
    radius: '0 to 6px. Hard corners, hard colour, no softness anywhere.',
    motion:
      'Fast and decisive: 180–240ms, cubic-bezier(.2,0,0,1). Marquee loops at constant speed (transform only, duplicated track, pause on hover). Hover inverts or fills a title through a mask. Nothing eases slowly — slow motion contradicts the direction.',
    texture:
      'Halftone dots or a 4% noise layer, one dithered pattern as a background field, and full-bleed colour blocks with no gradients between them.',
    hero:
      'The headline at 18vw filling the viewport width and deliberately overflowing (overflow: hidden), a marquee running under it, and the first colour block cut by a hard horizontal edge just below.',
    moment:
      'Hovering a title fills it with the loud colour through a mask that sweeps in from the left, while the rest of the list steps back in opacity.',
    skeleton: [
      'Header: wordmark at display size, navigation in one line of small caps, one loud button.',
      'Hero: overflowing type, marquee, colour block edge.',
      'A running list of names/dates as rows with hairlines, each row inverting on hover.',
      'Full-bleed colour section with a single sentence set at 6vw.',
      'A two-column asymmetric split: image in a hard-edged block, text tight beside it.',
      'Numbers section: tabular figures at display size, three of them, no explanation.',
      'Ticket or signup block in the loud colour with one action.',
      'Footer as one line of small caps.',
    ],
    fragments: [
      'Overflowing display type: font-size: clamp(4rem, 18vw, 14rem); line-height: .82; letter-spacing: -.04em; white-space: nowrap; overflow: hidden;',
      'Mask fill on hover: background-image: linear-gradient(var(--loud), var(--loud)); background-size: 0% 100%; background-repeat: no-repeat; transition: background-size 240ms cubic-bezier(.2,0,0,1); and 100% 100% on :hover.',
    ],
    never: [
      'A centred paragraph hero with a soft gradient behind it.',
      'Thin or light font weights anywhere.',
      'Pastels, muted tones, or a grey palette with one accent used tastefully.',
      'Slow easing that makes the page feel sleepy.',
    ],
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    blurb: 'full-bleed media, scroll-driven camera, slow fades',
    signals: /\b(travel|hotel|resort|villa|property|real ?estate|architecture|interior|film|cinema|car|automotive|airline|tour|expedition|yacht|safari|destination|lodge|retreat)\b/i,
    palette:
      'The media is the palette: deep neutral frames (#0a0a0b) with warm highlights pulled from the imagery (#e8dcc8 for type, #b9a889 for accents), and a single cool counterpoint (#7ea6c4) used once. Never lay white type on a light image without a scrim.',
    type:
      'Display: expanded grotesk or transitional serif, weight 300–500, clamp(2.8rem, 9vw, 7rem), line-height 1.0, letter-spacing .01em on the wide quiet lines. Body 17px/1.7 in a neutral sans. Captions 12px uppercase, letter-spacing .18em.',
    space:
      'Full-viewport sections (min-height: 100svh) with content held in a bottom band of 20% of the viewport. Text breathes: 128–200px vertical padding, and never more than 12 words in a line.',
    radius: '4px on frames and controls only. Media is otherwise unrounded and full-bleed.',
    motion:
      'Slow: 1200ms ease-out for fade and reveal, 1.4s cross-fades between media, scroll-driven camera (scale 1.12 to 1 and translateY -8%) on the active frame, and a 200ms snap for controls. Everything transform/opacity, everything inside the reduced-motion guard.',
    texture:
      'Film grain at 3%, a vignette on full-bleed media, letterbox bands on video frames, and no borders — depth comes from the image, not from chrome.',
    hero:
      'One 100svh media frame (video if supplied, graded image if not) with the headline in the bottom third, a one-line standfirst beneath, a scroll cue at the bottom edge, and a fixed translucent header that disappears on scroll down and returns on scroll up.',
    moment:
      'A scroll sequence where the frame scales down as the caption cross-fades to the next — three beats maximum, and the whole sequence collapses to a static stack of captioned frames without scroll or motion.',
    skeleton: [
      'Transparent header that hides on scroll down, returns on scroll up.',
      'Hero: 100svh frame, headline bottom third, scroll cue.',
      'One number or fact set large against black — the quiet beat after the image.',
      'Three chapters, each a full-viewport frame with a caption in the bottom band.',
      'A price or availability block on the darkest surface, tabular figures, hairline rules.',
      'A gallery of 3–5 frames in one row that steps to a 1.4 cross-fade on tap.',
      'Closing block: one action, one sentence, no form unless the brief asks.',
      'Footer over a still frame, small type, real contact details.',
    ],
    fragments: [
      'Scroll camera: transform: scale(calc(1.12 - var(--progress) * .12)) translateY(calc(var(--progress) * -8%)); — set --progress from scroll with transform-only writes, never from layout reads.',
      'Readable type over media: two-layer scrim, linear-gradient(to top, rgba(10,10,11,.86), rgba(10,10,11,.2) 45%, transparent), rather than a text-shadow.',
    ],
    never: [
      'White story sections between dark ones — the page is one continuous frame.',
      'Cards, boxes, or rounded panels over photographs.',
      'Fast or bouncy motion.',
      'More than two sentences of copy in a full-viewport section.',
    ],
  },
  {
    id: 'neo-brutal',
    name: 'Neo-brutal',
    blurb: 'raw grid, 2px black borders, one loud colour, zero radius',
    signals: /\b(studio|portfolio|agency|magazine|editorial|drop|exhibition|theatre|record label|zine|art direction|collective|publishing|newspaper|journal|manifesto|residency)\b/i,
    palette:
      'Off-white paper #f4f2ec, black #111, one loud colour at full strength (#2b3aff cobalt, #ff5c00 safety orange, or #00c46a green), and nothing between them. No greys except a single 20% tint used for secondary text.',
    type:
      'Grotesk set hard: display weight 700–800 with clamp(2.8rem, 10vw, 8rem) and negative tracking; metadata in mono at 11–12px uppercase, letter-spacing .1em, with visible measurement feel ("UPPER", "SINCE", "01/09"). Body 16px/1.6. Underlines on links, always.',
    space:
      'A visible grid: 1px black hairlines between blocks, uneven column spans (5/7, 4/4/4), 0 external margins in places, 12px internal padding — the box edges are content. Nothing floats in space.',
    radius: '0, everywhere, always. A single rounded corner breaks the whole direction.',
    motion:
      'Hard and instant: 120ms steps or none at all. Hover inverts a block to the loud colour with black text. One marquee is allowed. No easing curves, no fades, no parallax.',
    texture:
      'Flat fills only. No gradients, no shadows, no blur. Optional dither or 1-bit pattern used as a flat field, and 2px black borders doing the work shadows would do elsewhere.',
    hero:
      'An oversized statement that breaks the grid, sitting inside a 2px black frame with a rotated sticker or stamp overlapping one corner, and a metadata line (date, place, index number) in mono above it.',
    moment:
      'Hovering any section inverts it completely — background to the loud colour, all type to black, borders staying black — like a screen-printed flip.',
    skeleton: [
      'Header as a bordered bar: wordmark left, mono index right, one loud button.',
      'Hero: framed statement, rotated sticker, mono metadata line.',
      'A 2x2 grid of bordered blocks with uneven spans and one loud cell.',
      'A list of items as bordered rows: name, mono metadata right, arrow.',
      'Full-width loud colour band with black type and one sentence.',
      'A statement paragraph in three uneven columns, justified left, no justification tricks.',
      'Contact or booking block as a bordered form, 2px borders, black labels.',
      'Footer as one bordered strip of mono links.',
    ],
    fragments: [
      'Border as structure: border: 2px solid #111; border-radius: 0; and grid gap: 0 with borders collapsing via outline-offset: -1px so two blocks never double their line.',
      'Invert on hover: background: var(--loud); color: #111; transition: none; — and the type does not move.',
    ],
    never: [
      'Rounded corners anywhere, at any size.',
      'Soft shadows or blurred glass.',
      'Wide grey palettes, subtle tints, or tasteful muted accents.',
      'Slow easing, parallax, or anything that softens the edges.',
      'Three equal cards in a centred row — the whole point is an uneven grid.',
    ],
  },
  {
    id: 'organica',
    name: 'Organica',
    blurb: 'soft mesh gradients, rounded forms, asymmetric flow',
    signals: /\b(wellness|health|yoga|spa|clinic|therapy|climate|sustainab|organic|farm|food|recipe|nutrition|education|school|course|kids|children|non-?profit|community|charity|garden|nature|skincare)\b/i,
    palette:
      'Warm off-white #fbf9f5, ink #22302a, sage #7f9c86, clay #c98a6b, water #8fb8c9, sun #e8c179. Two of the three colours per page, never all of them, and always as soft fields rather than flat fills.',
    type:
      'Humanist sans for body (16–18px/1.7, 70ch max) with a rounded or soft-serif display at clamp(2.2rem, 7vw, 4.6rem), sentence case, letter-spacing normal. Nothing uppercase except 12px labels. Nothing condensed, nothing ultra-bold.',
    space:
      'Flowing rather than rhythmic: 24px base with 32–64px section gaps, asymmetric 7/5 and 8/4 splits, and elements allowed to overlap by 24–48px so sections feel grown rather than stacked.',
    radius: '24–40px on panels, 999px on buttons and image masks, and organic SVG border-radius values (a comma-separated eight-value radius) on feature shapes.',
    motion:
      'Gentle and slow at the edges: 400ms cubic-bezier(.34,1.2,.64,1) for entrances, a 20s drifting float on decorative blobs, and a fade-up on scroll by 16px. Never more than one moving element in the same region, and all of it behind prefers-reduced-motion.',
    texture:
      'Soft mesh gradients (three overlapping radial gradients at low opacity), 2% grain over everything, blurred curved SVG shapes, and no hard shadow — elevation is a soft colour tint, e.g. 0 24px 60px -32px rgba(34,48,42,.25).',
    hero:
      'A bento of four to six unequal rounded tiles: one large with a mesh gradient and a curved SVG form, one with the headline, one with a single metric, one with a photograph or generated illustration. No full-width banner.',
    moment:
      'A section where a soft gradient field shifts hue as the reader scrolls, blended behind the text at low opacity, so the page seems to breathe — and sits still when motion is reduced.',
    skeleton: [
      'Header: rounded pill nav, soft, with one calm action.',
      'Hero bento: unequal rounded tiles, one mesh gradient, one headline tile.',
      'A gentle three-step explainer, each step a 24px-rounded panel with an SVG curve.',
      'One overlapping section that rises 40px into the one above it.',
      'A quote or testimonial on a soft tinted field, no border, no quote-mark decoration.',
      'A metric block: three numbers in sentence case, spelled out, with a line of context each.',
      'One action block with a pill button the width of its text.',
      'Footer: two columns, soft, with real contact details.',
    ],
    fragments: [
      'Organic shape: border-radius: 62% 38% 46% 54% / 54% 46% 54% 46%; background: radial-gradient(120% 120% at 20% 20%, var(--sage), transparent 60%), radial-gradient(120% 120% at 80% 60%, var(--water), transparent 55%);',
      'Calm elevation: box-shadow: 0 24px 60px -32px color-mix(in srgb, var(--ink) 25%, transparent); background: var(--paper);',
    ],
    never: [
      'Pure black canvases or neon accents.',
      'Hard 90-degree section edges stacked in a rhythm.',
      'Dense tables, tight mono labels, or utilitarian borders.',
      'More than two moving things on screen at once.',
    ],
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'mono microtype, hairlines, tabular data, one signal accent',
    signals: /\b(docs|documentation|api|reference|developer|dev tools|sdk|infrastructure|system|database|data|logs|pipeline|open source|changelog|spec|specification|schema|protocol|library|framework|cli|endpoint|request|response|version)\b/i,
    palette:
      'Canvas #fbfbfa (light) or #0e1013 (dark) with hairline rgba(0,0,0,.10) / rgba(255,255,255,.10), ink #1b1d21, muted #6a7076, and ONE signal accent (#2563eb or #12b981) reserved for state: active, success, API verbs. Colour never decorates here.',
    type:
      'Mono for all UI: labels, navigation, tables, values, at 11–13px with letter-spacing .04em and uppercase for section labels. Prose in a neutral sans at 16px/1.7. Every number tabular. Code in the mono face at 13px with a tinted background, not a dark box.',
    space:
      'A dense 4px grid: 8 12 16 24 32 48. Section padding 48–64px, never 160. Max content width 1200px with a visible 12-column rhythm; dense regions get 12px internal padding and hairlines instead of gaps.',
    radius: '4–6px maximum. Pills for status only, and only when a value needs a shape.',
    motion:
      'Nearly none: 120–160ms linear on state changes, no reveal animations, no parallax. The permitted motion is functional — a terminal cursor blink (1s steps), a progress hairline that fills, a diff row that highlights. All transform/opacity, all inside the reduced-motion guard.',
    texture:
      'A blueprint grid background: 8px minor lines at 3% and a 40px major line at 6%, drawn with repeating-linear-gradient. Hairline borders everywhere. No shadows at all — depth is a 1px line.',
    hero:
      'A split: dense specification copy on the left (label, headline, one paragraph, a two-button row, an install line in mono with a copy affordance) and on the right a hairline-framed live-looking panel — terminal output or a data table with real values.',
    moment:
      'An annotated diagram where callout lines draw in sequence as the reader scrolls, each label in mono at 11px with a hairline leader to the node it names; static and fully legible with scroll position ignored.',
    skeleton: [
      'Header: mono wordmark, mono nav, version badge, one signal-coloured action.',
      'Hero split: spec copy left, framed panel right.',
      'A three-column feature grid with hairline separators and mono labels.',
      'A real code block with a copy button and a line-number gutter.',
      'A comparison or spec table with sticky header, tabular figures, hairline rows.',
      'The annotated diagram with drawing callouts.',
      'A metrics row: p50/p95-style values in mono, no adjectives.',
      'Footer: hairlines, three mono link columns, build/version metadata.',
    ],
    fragments: [
      'Hairline grid: background-image: repeating-linear-gradient(to right, rgba(0,0,0,.06) 0 1px, transparent 1px 40px), repeating-linear-gradient(to bottom, rgba(0,0,0,.06) 0 1px, transparent 1px 40px);',
      'Mono label: font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--hairline);',
    ],
    never: [
      'Gradient blobs, aurora fields, or glass panels.',
      'Large rounded cards with generous padding.',
      'A serif display face or oversized marketing type.',
      'Drop shadows standing in for hairlines.',
      'Marketing adjectives on the same screen as the numbers.',
    ],
  },
  {
    id: 'retail',
    name: 'Retail-polished',
    blurb: 'confident hero, product-led rhythm, trust above the fold',
    signals: /\b(shop|store|ecommerce|e-commerce|retail|product page|menu|order|booking|salon|gym|plumber|electrician|dentist|local|franchise|clinic|service|catalogue|catalog|deal|offer|cart|checkout|basket|shipping|delivery|price|prices|pricing|buy|stock|refund)\b/i,
    palette:
      'Warm neutral base #fdfcfa, ink #14161a, muted #62686f, one brand colour (the business\'s own — if unknown, a deep green #14532d or wine #7f1d3a) used on the single primary action only, and a success green for stock/live states. Prices always in ink, never muted.',
    type:
      'Sturdy display sans, weight 600–700, clamp(2.2rem, 6vw, 4rem), line-height 1.05, sentence case; body 16px/1.65 with 65ch max; prices in tabular figures at display size on product cards; availability and hours in 13px muted.',
    space:
      'A 80–120px section rhythm with a tight 20–24px product grid gap. Above the fold: value line, one action, and the trust row within 600px of height. Nothing important below 900px.',
    radius: '10–12px on cards and inputs, 999px on the primary button. Consistent, not expressive.',
    motion:
      '250ms standard ease-out, hover lift of 2px with a slightly stronger shadow, image zoom to 1.04 inside a fixed frame, and a sticky add-to-cart that appears when the product image scrolls out. Reveal animations on scroll are not allowed above the fold.',
    texture:
      'Subtle neutral grain, soft card shadow 0 12px 30px rgba(20,22,26,.08), real product photography, and one flat colour band for the trust row. No glass, no glow, no mesh.',
    hero:
      'Split hero: value line, one-sentence proof, a primary action and a secondary text link on the left, the product or venue photograph on the right, and a trust row beneath (hours, location, rating, delivery) in 13px muted type.',
    moment:
      'The product grid where hovering or tapping a card swaps to the second photograph and reveals stock and lead time, so browsing feels like handling the thing.',
    skeleton: [
      'Header: wordmark, five links, phone number or hours right, one primary action.',
      'Split hero with the trust row above the fold.',
      'Three-to-four product or service cards: image, name, price, one line of detail.',
      'A proof band: three real facts (years, customers, guarantee), flat colour.',
      'The full menu or catalogue as a grid, categories as filter chips that actually filter.',
      'One testimonial with a real name and a real detail, not a stock portrait.',
      'Booking or order block: the form only — four fields maximum, with the CTA beside the last field.',
      'Footer: address with a map link, hours table, payment marks, legal links.',
    ],
    fragments: [
      'Card with a real hover: transition: transform 250ms ease-out, box-shadow 250ms ease-out; :hover { transform: translateY(-2px); box-shadow: 0 18px 40px rgba(20,22,26,.12); } and the image inside at overflow: hidden with scale(1.04).',
      'Price, said clearly: font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink); with the unit and any saving in 13px muted beneath it.',
    ],
    never: [
      'Stock-abstract imagery standing in for the product.',
      'Prices hidden behind a click, or "contact us" where a price belongs.',
      'Two competing action colours.',
      'The trust information below the fold.',
      'Dense legal text anywhere above the fold.',
    ],
  },
];

/** Look a direction up by id. Unknown ids return undefined rather than guess. */
export function directionById(id: string | null | undefined): Direction | undefined {
  if (!id) return undefined;
  return DIRECTIONS.find((d) => d.id === id);
}

/**
 * Rank every direction for a brief: how many of its signals the brief hits,
 * best first. Ties keep registry order, so the same brief always ranks the same
 * way and the operator can predict the tool they are using.
 */
export function rankDirections(brief: string): readonly Direction[] {
  const text = String(brief ?? '');
  const score = (d: Direction) => {
    const matches = text.match(new RegExp(d.signals.source, 'gi'));
    return matches ? matches.length : 0;
  };
  return [...DIRECTIONS]
    .map((d, index) => ({ d, index, score: score(d) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((row) => row.d);
}

/** The direction the brief points at. With no signal at all, Nocturne. */
export function pickDirection(brief: string): Direction {
  const ranked = rankDirections(brief);
  return ranked[0] ?? DIRECTIONS[0];
}

/**
 * True when the brief actually pointed somewhere, as opposed to falling back to
 * the first direction. The plan says which of the two happened, because "your
 * brief said fashion" and "your brief said nothing, so I chose" are different
 * claims and only one of them is about the operator.
 */
export function briefChoseDirection(brief: string): boolean {
  const text = String(brief ?? '');
  return DIRECTIONS.some((d) => d.signals.test(text));
}

/** The directions offered as chips: the ranked best, minus the chosen one. */
export function chipDirections(brief: string, count = 3): readonly Direction[] {
  const ranked = rankDirections(brief);
  const chosen = ranked[0];
  return ranked.filter((d) => d.id !== chosen?.id).slice(0, count);
}

/**
 * Everything a run needs to announce its direction, and to offer alternatives.
 *
 * One payload, built from the registry, so the step the operator sees, the
 * alternates they are offered, and the recipe the model was handed all come
 * from the same eight definitions — a "different direction" chip cannot offer a
 * direction whose recipe does not exist.
 */
export function directionPayload(
  brief: string,
  chosenId?: DirectionId | string | null,
): {
  id: DirectionId;
  name: string;
  blurb: string;
  why: string;
  chips: Array<{ id: DirectionId; name: string; blurb: string }>;
} {
  // `chosenId` is what makes the payload tell the truth once somebody has
  // answered: without it this re-derives the pick from the brief, so a task the
  // operator pointed at Kinetic would announce Nocturne and build Kinetic —
  // the plan and the page disagreeing, which is the failure the ask exists to
  // prevent.
  const answered = directionById(typeof chosenId === 'string' ? chosenId : undefined);
  const chosen = answered ?? pickDirection(brief);
  return {
    id: chosen.id,
    name: chosen.name,
    blurb: chosen.blurb,
    why: answered
      ? 'chosen before the build started'
      : briefChoseDirection(brief)
        ? 'the brief points here'
        : 'nothing in the brief pointed anywhere, so this is the default',
    // The alternates are still the ones this brief would offer, minus whatever
    // is now being built: a finished page must not offer to become the
    // direction it already is.
    chips: rankDirections(brief)
      .filter((d) => d.id !== chosen.id)
      .slice(0, 3)
      .map((d) => ({ id: d.id, name: d.name, blurb: d.blurb })),
  };
}

/**
 * Read the owner's reply to the direction ask: `1`, `2`, `3`, or "choose".
 *
 * The ask goes out on WhatsApp (the owner is often on the phone), so the reply
 * has to survive a phone keyboard — a bare number, a number with punctuation, a
 * spelled-out name, or "you choose". Anything else returns null so the ordinary
 * verdict path still sees YES / NO / CHANGE: a parser that guesses would turn
 * "yes" into a direction.
 *
 * @param text       what the owner replied
 * @param chips      the alternates, in the order they were listed
 * @param proposedId the direction that was proposed as the default
 */
export function parseDirectionReply(
  text: string,
  chips: ReadonlyArray<{ id: string; name?: string }>,
  proposedId?: string | null,
): { id: DirectionId } | { auto: true } | null {
  const clean = String(text ?? '').trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (!clean) return null;
  if (/^(choose|auto|you choose|you pick|wais choose|let wais choose|whatever you think|up to you)$/.test(clean)) {
    return { auto: true };
  }
  const numbered = /^(?:#|option |direction |number )?(\d)$/.exec(clean);
  if (numbered) {
    const pick = chips[Number(numbered[1]) - 1];
    const direction = pick ? directionById(pick.id) : undefined;
    return direction ? { id: direction.id } : null;
  }
  // A name typed out, with or without a leading verb: "kinetic", "go with
  // kinetic", "use blueprint". Matched against the ids and names of every
  // direction, so this cannot be talked into something that does not exist.
  const words = clean.replace(/^(go with|use|do|pick|choose|make it)\s+/, '');
  const named = DIRECTIONS.find((d) => d.id === words || d.name.toLowerCase() === words);
  if (named) return { id: named.id };
  // "the one you said", "the default" — the proposal, said the long way.
  if (/^(the )?(one you (said|proposed|suggested)|default|first one)$/.test(clean)) {
    const proposed = directionById(typeof proposedId === 'string' ? proposedId : undefined);
    return proposed ? { id: proposed.id } : null;
  }
  return null;
}

/** One line for the plan: what the operator reads before any file exists. */
export function describeDirection(direction: Direction): string {
  return `${direction.name} — ${direction.blurb}`;
}

/**
 * The brief the model is handed for the chosen direction.
 *
 * Generated from the direction's own fields rather than hand-written per
 * direction, so a direction cannot ship with a documented palette and an
 * undocumented motion rule — the same source feeds the recipe, the plan line
 * and the chips.
 */
export function recipeFor(direction: Direction): string {
  const lines = [
    `ART DIRECTION — ${direction.name}: ${direction.blurb}.`,
    'Build the whole page in this direction. It is not a suggestion and it is not a theme you can blend with another.',
    '',
    `PALETTE   ${direction.palette}`,
    `TYPE      ${direction.type}`,
    `SPACE     ${direction.space}`,
    `RADIUS    ${direction.radius}`,
    `MOTION    ${direction.motion}`,
    `TEXTURE   ${direction.texture}`,
    '',
    'HERO',
    direction.hero,
    '',
    'PAGE SKELETON',
    ...direction.skeleton.map((line, i) => `${i + 1}. ${line}`),
    '',
    'THE SIGNATURE MOMENT',
    `${direction.moment} One moment, done well, beats six done adequately. If it cannot be built without breaking the page, build the page without it and say so.`,
    '',
    'WORKED FRAGMENTS — the level of specificity expected of every value',
    ...direction.fragments.map((f) => `- ${f}`),
    '',
    'BUILD ORDER',
    ...BUILD_ORDER.map((line, i) => `${i + 1}. ${line}`),
    '',
    'NEVER, HERE',
    ...[...direction.never, ...SHARED_NEVER].map((line) => `- ${line}`),
  ];
  return lines.join('\n');
}
