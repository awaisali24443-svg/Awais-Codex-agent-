/**
 * Art-direction and craft injection.
 *
 * The executor follows the same wire-only pattern as the planning protocol,
 * the LinkedIn contract, and the Google read contract:
 *
 *   OUT  `withDesignGuide(prompt, directionId)` — when the task is about
 *        designing or building a UI, prepend four things: the chosen art
 *        direction's recipe (canvas, type, space, motion, hero, skeleton, and
 *        the shapes it forbids), the craft guide that applies in every
 *        direction, the asset kit (generated imagery — gradient fields, grain,
 *        duotone, drawn frames — since there is no stock library and no image
 *        API on the free tier), and the self-check. The operator's stored
 *        prompt is never rewritten; only the text sent to the model carries
 *        them.
 *
 *        The direction is what stopped every page looking the same. "Warm,
 *        minimal, quiet" was the entire house style, so a jewellery launch and
 *        a developer console both came out as the same careful grey page with
 *        the same small type — and a page where nothing is allowed to be loud
 *        cannot have a moment, which is exactly what people recognise as
 *        generated.
 *
 *   COST  Non-UI tasks are returned untouched — the exact same string — so
 *        they pay zero extra tokens, and a UI task with no direction still
 *        gets the guide alone. The guide is read from disk once at boot and
 *        cached; a missing file degrades to "direction only".
 *
 *        A direction id that is not in the registry is ignored rather than
 *        guessed at: a page built in a direction nobody defined is worse than
 *        one built in the default, because the recipe and the plan would then
 *        disagree about what was being made.
 *
 * The detection is a two-factor intent check (a UI build verb AND a UI
 * noun), deliberately tighter than a single keyword list: "check the PIA
 * website for prices" must not pay for a design guide, while "design a
 * landing page" must.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findDir } from './paths.js';
import { directionById, recipeFor } from './design/directions.js';
import { gateChecklist } from './design/gate.js';
import { assetKit } from './design/assets.js';
import type { DirectionId } from './design/types.js';

/** Verbs that signal the operator wants something built or shaped. */
const UI_VERB_RE = /\b(design|redesign|restyle|build|create|make|code|prototype|mock\s?up)\b/i;

/** Nouns that signal the thing being built is a user interface. */
const UI_NOUN_RE =
  /\b(ui|ux|user[- ]interface|landing[- ]page|web[- ]?page|web[- ]?app|website|app( screen)?|dashboard|mockup|wireframe|theme|front[- ]?end|stylesheet|css|layout|screen design)\b/i;

/** A mission is UI-building when it pairs a build verb with a UI noun. */
export function looksLikeUiMission(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  return UI_VERB_RE.test(text) && UI_NOUN_RE.test(text);
}

let guideCache: string | null = null;
let guideLoaded = false;

/**
 * The guide text, loaded once and cached. Empty string when the file cannot
 * be found — the mission then runs exactly as it would without the guide.
 */
export function designGuideText(): string {
  if (guideLoaded) return guideCache ?? '';
  guideLoaded = true;
  try {
    const dir = findDir(['server'], 'ui-design-guide.md');
    if (!dir) {
      console.warn('[design] ui-design-guide.md not found — UI tasks run without the guide');
      guideCache = '';
      return '';
    }
    guideCache = fs.readFileSync(path.join(dir, 'ui-design-guide.md'), 'utf8').trim();
  } catch (err) {
    console.warn('[design] could not load ui-design-guide.md:', (err as Error).message);
    guideCache = '';
  }
  return guideCache ?? '';
}

const GUIDE_PREAMBLE = `[Craft guide — this task involves designing or building a user
interface. It applies on top of the art direction below, whichever direction
that is: the direction decides how the page looks, and this decides whether it
is any good.]

`;

const DIRECTION_PREAMBLE = `[Art direction — chosen before any file is written. Build the
whole page in it: it is not a theme, and it does not blend with another.]

`;

const ASSET_PREAMBLE = `[Asset kit — how this page gets its imagery without a stock
library, an image API or a key. These are complete snippets: use them rather than
inventing a technique, and never link an image from another site.]

`;

const SELF_CHECK_PREAMBLE = `[Self-check — the same checks the server runs on a finished
build. Run them on your own work before you say the page is done, and fix what
fails in the files you already wrote.]

`;

/**
 * Prepend the direction's recipe and the craft guide, on the wire only, when
 * the task is UI-building. Non-UI tasks get the identical string back — zero
 * added tokens.
 */
export function withDesignGuide(prompt: string, directionId?: DirectionId | string | null): string {
  if (!looksLikeUiMission(prompt)) return prompt;
  const direction = directionById(typeof directionId === 'string' ? directionId : undefined);
  const guide = designGuideText();
  if (!direction && !guide) return prompt;
  return (
    (direction ? DIRECTION_PREAMBLE + recipeFor(direction) + '\n\n' : '') +
    (guide ? GUIDE_PREAMBLE + guide + '\n\n' : '') +
    // Only with a direction, because the kit is filtered by it: the techniques
    // are chosen to suit the direction, and a halftone dot field handed to a
    // wellness page is how a direction turns into a menu.
    (direction ? ASSET_PREAMBLE + assetKit(direction.id) + '\n\n' : '') +
    // The server cannot read what the engine builds in its own sandbox, so the
    // gate's rules travel to the one thing that can run them: the model that
    // wrote the page. Same rules, same ids — see `gateChecklist`.
    SELF_CHECK_PREAMBLE +
    gateChecklist(direction?.id) +
    '\n\n' +
    prompt
  );
}
