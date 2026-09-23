/**
 * UI design guide injection.
 *
 * The executor follows the same wire-only pattern as the planning protocol,
 * the LinkedIn contract, and the Google read contract:
 *
 *   OUT  `withDesignGuide(prompt)` — when the mission is about designing or
 *        building a UI, prepend the design guide so the engine's taste
 *        matches the house style (warm, minimal, Claude/ChatGPT/Manus
 *        spirit). The operator's stored prompt is never rewritten; only the
 *        text sent to the model carries the guide.
 *
 *   COST  Non-UI missions are returned untouched — the exact same string —
 *        so they pay zero extra tokens. The guide is read from disk once at
 *        boot and cached; a missing file degrades to "no guide" and never
 *        fails a mission.
 *
 * The detection is a two-factor intent check (a UI build verb AND a UI
 * noun), deliberately tighter than a single keyword list: "check the PIA
 * website for prices" must not pay for a design guide, while "design a
 * landing page" must.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findDir } from './paths.js';

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
      console.warn('[design] ui-design-guide.md not found — UI missions run without the guide');
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

const GUIDE_PREAMBLE = `[Design guide — this mission involves designing or building a user
interface. Follow the house style below: warm, minimal, quiet. Let the
interface disappear so the content can speak.]

`;

/**
 * Prepend the design guide on the wire only, when the mission is
 * UI-building. Non-UI missions get the identical string back — zero added
 * tokens.
 */
export function withDesignGuide(prompt: string): string {
  if (!looksLikeUiMission(prompt)) return prompt;
  const guide = designGuideText();
  if (!guide) return prompt;
  return GUIDE_PREAMBLE + guide + '\n\n' + prompt;
}
