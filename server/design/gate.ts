/**
 * The quality gate: what was built, checked against what was asked for.
 *
 * The reason this exists: "looks generated" is not a matter of taste, it is a
 * short list of mechanical failures — a hard-coded colour that matches nothing
 * else on the page, headings the size of body text, one transition on `width`,
 * the template shape, placeholder copy. Each of those is a fact about the file,
 * and a fact can be checked without an opinion.
 *
 * Two rules this file keeps to, because a checker that cries wolf gets ignored
 * and then the whole gate is dead weight:
 *
 *   1. Every finding names the file and the offending text. "Improve the
 *      design" is not a finding.
 *   2. The thresholds come from the chosen direction, not from a global idea of
 *      good. Dense documentation is allowed small headings; a festival page is
 *      not. The gate and the recipe read the same registry, so they cannot
 *      disagree about what the direction was.
 *
 * It is deliberately static. It cannot see the rendered page, so it checks the
 * things that are true of the source: tokens, literals, declarations, structure.
 * Layout that only breaks in a real viewport is the engine's own screenshot
 * pass, not this.
 */
import { describeDirection, directionById } from './directions.js';
import type { Direction, DirectionId } from './directions.js';

/** One built file: the path as written into the workspace, and its text. */
export interface BuiltFile {
  path: string;
  content: string;
}

/** Something the build did that the direction forbids. */
export interface Finding {
  rule: RuleId;
  file: string;
  detail: string;
}

export type RuleId =
  | 'tokens-missing'
  | 'colour-outside-tokens'
  | 'placeholder-copy'
  | 'display-scale'
  | 'reduced-motion'
  | 'layout-transition'
  | 'generic-shape'
  | 'no-imagery';

/** Files whose text is checked. Anything else (images, fonts) is skipped. */
const TEXT_FILE_RE = /\.(css|html|htm|js|jsx|ts|tsx|mjs|cjs|svelte|vue|astro|md)$/i;

/** The file every later file is allowed to take its values from. */
export const TOKEN_FILE_RE = /(^|\/)tokens?\.css$/i;

/** A build of one file has nowhere else to put its tokens, so R1 stands down. */
const MIN_FILES_FOR_TOKENS = 2;

/** How many custom properties a token set must actually declare. */
const MIN_TOKEN_COUNT = 8;

/** `#rgb`, `#rrggbb`, `#rrggbbaa` — the shape of a colour someone guessed. */
const HEX_RE = /#[0-9a-f]{3,8}\b/gi;
const FUNC_COLOUR_RE = /\b(?:rgba?|hsla?|oklch|lab|lch|color)\(/gi;

/** Copy that was never finished. Every one of these has shipped in a real page. */
const PLACEHOLDER_RES: Array<[RegExp, string]> = [
  [/lorem ipsum/i, 'lorem ipsum'],
  [/\blorem\b/i, 'lorem'],
  [/\bTODO\b/, 'TODO'],
  [/your headline here/i, 'a headline placeholder'],
  [/coming soon/i, 'coming soon'],
  [/example\.com/i, 'an example.com link'],
  [/href\s*=\s*["']#["']/i, 'a dead "#" link'],
  [/placeholder/i, 'the word placeholder'],
  [/\bplaceholder text\b/i, 'placeholder text'],
  [/555-0\d{3}/, 'a fake phone number'],
  [/\binsert [a-z]+ here\b/i, 'an "insert … here" gap'],
];

/** Properties that must never be animated — they force layout every frame. */
const LAYOUT_PROPS_RE = /\b(width|height|top|right|bottom|left|margin|padding|font-size|inset|max-height|min-height|border-width)\b/;

const MOTION_RE = /(?:^|[;{\s])(transition|animation)\s*:/i;

/**
 * Remove the places where a colour literal is legitimately not a token: SVG
 * data URIs (they cannot read CSS variables), inline `<svg>` fill/stroke, and
 * theme-color metadata. Without this the checker flags every favicon and every
 * generated texture, and the first thing anyone does with a noisy checker is
 * ignore it.
 */
function maskIrrelevantColours(source: string): string {
  return source
    .replace(/url\(\s*["']?data:[^)]*\)/gi, 'url(DATA)')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<meta\b[^>]*>/gi, '<meta>');
}

/** Text that was never finished, in any file that renders. */
function placeholderFinding(files: readonly BuiltFile[]): Finding | null {
  for (const file of files) {
    if (!/\.[a-z]+$/i.test(file.path)) continue;
    for (const [re, label] of PLACEHOLDER_RES) {
      const match = re.exec(file.content);
      if (match) {
        return { rule: 'placeholder-copy', file: file.path, detail: `contains ${label}: "${match[0].trim().slice(0, 60)}"` };
      }
    }
  }
  return null;
}

/**
 * The display scale: the largest heading in the build, in pixels.
 *
 * `clamp()` is the shape everyone reaches for, so the numbers inside it are read
 * nesting-aware (`clamp(calc(1px + 2vw), var(--x), 3rem)` has to yield 48, not
 * zero) and the largest resolvable value wins. Pixels are read at a 375px phone
 * for `vw`, which is the case that actually breaks. Body sizes are counted too:
 * "the largest type on the page is 17px" is a more useful sentence than "no
 * display type at all", and it is the same fact either way.
 */
export function displaySizes(css: string): number[] {
  const sizes: number[] = [];
  const re = /font-size\s*:\s*/gi;
  for (const match of css.matchAll(re)) {
    const value = declarationValue(css.slice((match.index ?? 0) + match[0].length)).trim();
    if (!value) continue;
    if (/^clamp\(/i.test(value)) {
      const px = splitArgs(value.replace(/^clamp\(/i, '').replace(/\)\s*$/, ''))
        .map((arg) => cssLengthToPx(arg))
        .filter((n) => n > 0);
      if (px.length) sizes.push(Math.max(...px));
      continue;
    }
    const px = cssLengthToPx(value.replace(/!important/i, '').trim());
    if (px > 0) sizes.push(px);
  }
  return sizes;
}

/** The largest declared font size in a stylesheet, in pixels (0 when none). */
export function largestDisplayPx(css: string): number {
  const sizes = displaySizes(css);
  return sizes.length ? Math.max(...sizes) : 0;
}

/** A declaration's value: up to the `;`, `}` or unbalanced `)` that ends it. */
function declarationValue(rest: string): string {
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return rest.slice(0, i);
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === '}')) return rest.slice(0, i);
  }
  return rest;
}

/** Split `a, b(c, d), e` on the commas that are not inside parentheses. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args.map((a) => a.trim()).filter(Boolean);
}

/** A CSS length as pixels. Unknown units count as zero rather than throwing. */
function cssLengthToPx(value: string): number {
  const match = /^([\d.]+)\s*(px|rem|em|vw|vmin|svmin|%)?$/i.exec(value.trim());
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = (match[2] ?? 'px').toLowerCase();
  if (unit === 'px') return n;
  if (unit === 'rem' || unit === 'em') return n * 16;
  if (unit === 'vw' || unit === 'vmin' || unit === 'svmin') return n * 3.75;
  return 0;
}

/**
 * Where the display scale is missing, and from which file to say so.
 *
 * The largest size decides the file the finding names: pointing at the token
 * file when the stylesheet is the one with 14px headings sends the model to the
 * wrong place, and a finding that sends you to the wrong file is worse than no
 * finding.
 */
function displayFinding(sources: readonly BuiltFile[], floor: number, direction: Direction | undefined): Finding | null {
  let largest = 0;
  let where = '';
  for (const file of sources) {
    const px = largestDisplayPx(file.content);
    if (px > largest) {
      largest = px;
      where = file.path;
    }
  }
  if (largest >= floor) return null;
  const folder = sources.find((f) => /\.css$/i.test(f.path) && !TOKEN_FILE_RE.test(f.path))?.path
    ?? sources.find((f) => /\.css$/i.test(f.path))?.path
    ?? sources[0]?.path
    ?? '(build)';
  return {
    rule: 'display-scale',
    file: where || folder,
    detail:
      largest === 0
        ? `no display type at all — ${direction?.name ?? 'this direction'} needs a heading at least ${minDisplayRem(direction)}rem`
        : `the largest type on the page is ${Math.round(largest)}px — ${minDisplayRem(direction)}rem or more is expected`,
  };
}

/** The smallest display size the direction considers a display size. */
function minDisplayRem(direction: Direction | undefined): number {
  // Dense documentation is allowed small headings; everything else is not. The
  // exception is one id, written once, instead of a rule spelled out per
  // direction that nobody would remember to update.
  return direction?.id === 'blueprint' ? 1.5 : 2.2;
}

/**
 * Check a finished build. Returns every rule it broke, worst-first; an empty
 * list means the gate passed.
 *
 * `directionId` is optional but changes two thresholds, so a caller that knows
 * the direction should always pass it.
 */
export function checkBuild(files: readonly BuiltFile[], directionId?: DirectionId | string | null): Finding[] {
  const direction = directionById(typeof directionId === 'string' ? directionId : undefined);
  const findings: Finding[] = [];
  const sources = files.filter((f) => TEXT_FILE_RE.test(f.path));
  const tokenFiles = sources.filter((f) => TOKEN_FILE_RE.test(f.path));

  // R1 — the tokens file, which is the single reason a build looks like one
  // build: without it every file invents its own values.
  if (sources.length >= MIN_FILES_FOR_TOKENS) {
    if (tokenFiles.length === 0) {
      findings.push({
        rule: 'tokens-missing',
        file: sources[0]?.path ?? '(build)',
        detail: `no tokens.css in a build of ${sources.length} files — every value must come from one declared set`,
      });
    } else {
      const declared = new Set(
        tokenFiles.flatMap((f) => [...f.content.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])),
      );
      if (declared.size < MIN_TOKEN_COUNT) {
        findings.push({
          rule: 'tokens-missing',
          file: tokenFiles[0].path,
          detail: `declares ${declared.size} custom properties — a token set needs at least ${MIN_TOKEN_COUNT}`,
        });
      }
    }
  }

  // R2 — a colour that is not a token is a colour that will not match anything.
  const strayColours: Array<{ file: string; colour: string }> = [];
  for (const file of sources) {
    if (TOKEN_FILE_RE.test(file.path)) continue;
    const masked = maskIrrelevantColours(file.content);
    for (const re of [HEX_RE, FUNC_COLOUR_RE]) {
      re.lastIndex = 0;
      for (const match of masked.matchAll(re)) {
        if (/rgb\(0\s*0\s*0\s*\/\s*0\)|transparent/i.test(match[0])) continue;
        strayColours.push({ file: file.path, colour: match[0] });
      }
    }
  }
  if (strayColours.length) {
    const first = strayColours[0];
    const list = [...new Set(strayColours.map((c) => c.colour))].slice(0, 5).join(', ');
    findings.push({
      rule: 'colour-outside-tokens',
      file: first.file,
      detail: `${strayColours.length} colour literal${strayColours.length > 1 ? 's' : ''} outside ${tokenFiles[0]?.path ?? 'the token file'} (${list}) — move them into tokens or use var()`,
    });
  }

  // R3 — copy that was never finished.
  const placeholder = placeholderFinding(sources);
  if (placeholder) findings.push(placeholder);

  // R4 — headings that are body text with a bold face on.
  const display = displayFinding(sources, minDisplayRem(direction) * 16, direction);
  if (display) findings.push(display);

  // R5 — motion without a way out of it.
  const animated = sources.some((f) => MOTION_RE.test(f.content));
  const guarded = sources.some((f) => /prefers-reduced-motion/i.test(f.content));
  if (animated && !guarded) {
    findings.push({
      rule: 'reduced-motion',
      file: sources.find((f) => MOTION_RE.test(f.content))?.path ?? '(build)',
      detail: 'animates without a prefers-reduced-motion guard — a reader who asked for less must get none',
    });
  }

  // R6 — animating layout properties forces the browser to re-layout every frame.
  for (const file of sources) {
    const match = /(?:^|[;{\s])transition\s*:[^;}]*/i.exec(file.content);
    const decl = match?.[0] ?? '';
    if (decl && LAYOUT_PROPS_RE.test(decl)) {
      findings.push({
        rule: 'layout-transition',
        file: file.path,
        detail: `transitions a layout property: "${decl.trim().slice(0, 70)}" — animate transform and opacity only`,
      });
      break;
    }
    if (/transition\s*:\s*all\b/i.test(file.content)) {
      findings.push({ rule: 'layout-transition', file: file.path, detail: 'transition: all — name the properties' });
      break;
    }
  }

  // R7 — the shape everybody recognises as generated.
  const centred = sources.some((f) => /text-align\s*:\s*center/i.test(f.content));
  const threeAcross = sources.some((f) => /grid-template-columns\s*:\s*(?:repeat\(\s*3\s*,|1fr\s+1fr\s+1fr)/i.test(f.content));
  const gradient = sources.some((f) => /(?:radial|linear)-gradient\(/i.test(f.content));
  if (centred && threeAcross && gradient) {
    findings.push({
      rule: 'generic-shape',
      file: sources[0]?.path ?? '(build)',
      detail: 'centred content, three equal columns and a gradient background at once — this is the generated-page shape every direction here forbids',
    });
  }

  // R8 — a page made only of type is not a page, whatever the direction says.
  const hasImagery = sources.some((f) =>
    /<(img|svg|canvas|picture|video)\b/i.test(f.content) ||
    /background-image\s*:/i.test(f.content) ||
    /(?:radial|linear|conic)-gradient\(/i.test(f.content) ||
    /url\(/i.test(f.content),
  );
  if (sources.length && !hasImagery) {
    findings.push({
      rule: 'no-imagery',
      file: sources[0].path,
      detail: 'no image, SVG, gradient or canvas anywhere — generate the imagery rather than shipping a text-only page',
    });
  }

  return findings;
}

/**
 * The gate's rules, as the checklist the builder runs on its own work.
 *
 * The server cannot read the files an engine builds in its own sandbox — they
 * are pulled only when someone downloads or previews one — so the checks have
 * to travel to the only place that can run them, which is the model that wrote
 * the page. It is the same rule set as `checkBuild`, keyed by the same ids, so
 * the checklist cannot quietly fall out of step with the checker: `Record<RuleId,
 * …>` means adding a rule without a line here does not compile.
 *
 * It is written as an instruction, not a warning, and it is last thing on the
 * wire before the operator's own words.
 */
export function gateChecklist(directionId?: DirectionId | string | null): string {
  const direction = directionById(typeof directionId === 'string' ? directionId : undefined);
  const floor = minDisplayRem(direction);
  const lines = (Object.entries(CHECKLIST_LINES) as Array<[RuleId, (floorRem: number) => string]>)
    .map(([, line], i) => `${i + 1}. ${line(floor)}`);
  return [
    'SELF-CHECK before you call this page finished — the same checks the server runs on a',
    'finished build. Fix every one that fails, in the files you already wrote:',
    ...lines,
    'Then the passes: 320px with no horizontal scroll, every tap target at least 44px, the',
    'tab order following the page, and every string read aloud.',
  ].join('\n');
}

/**
 * One line per rule, in the order they matter. A `Record` rather than a list, so
 * a new rule that nobody wrote a checklist line for does not compile.
 */
const CHECKLIST_LINES: Record<RuleId, (floorRem: number) => string> = {
  'tokens-missing': () =>
    'tokens.css exists and declares the palette, the type scale, the spacing scale, radii, shadows and motion curves — and everything else uses var() from it.',
  'colour-outside-tokens': () =>
    'Search every file you wrote for "#" and "rgb(" outside tokens.css. Each hit is a defect: move the value into tokens or use var(). Colours inside generated SVG and data URIs are fine.',
  'display-scale': (floorRem) =>
    `The largest type on the page is at least ${floorRem}rem and reached with clamp(), so it scales. A heading the size of body text with a bold face on fails this check.`,
  'reduced-motion': () =>
    'Every transition and animation sits inside a prefers-reduced-motion guard, and the reduced page is complete — just still.',
  'layout-transition': () =>
    'Nothing animates width, height, top, left, right, margin or padding: transform and opacity only, and never transition: all.',
  'placeholder-copy': () =>
    'Every string is final and real — no lorem, no "coming soon", no "your headline here", no TODO, no href="#" dead links, no fake phone numbers.',
  'generic-shape': () =>
    'It is not the shape: a centred hero, three equal cards, and one gradient behind them, all at once. Asymmetry, or a different structure, is the fix.',
  'no-imagery': () =>
    'There is real visual content — an image, an SVG illustration, a generated gradient or mesh, a canvas — and the signature moment is built and working.',
};

/** True when the build may be called done. */
export function gatePassed(findings: readonly Finding[]): boolean {
  return findings.length === 0;
}

/** One line per finding, for the run's step detail. */
export function gateSummary(findings: readonly Finding[]): string {
  if (!findings.length) return 'Quality gate passed.';
  return findings.map((f) => `${f.file}: ${f.detail}`).join('\n');
}

/**
 * The findings, written as the next instruction.
 *
 * A failed gate is not the end of a task — it is the start of the repair, so
 * the wording is a to-do list a builder can act on, and it says the build is
 * otherwise fine when only one thing is wrong.
 */
export function gateRepairPrompt(findings: readonly Finding[], directionId?: DirectionId | string | null): string {
  if (!findings.length) return '';
  const direction = directionById(typeof directionId === 'string' ? directionId : undefined);
  const lines = [
    '[Quality gate — the build was checked and did not pass. Fix every item below in the',
    'existing files. Do not rewrite the page: these are specific defects, and the rest of',
    'the work stands.]',
    '',
  ];
  for (const f of findings) lines.push(`- ${f.file} — ${f.detail}`);
  // Restated in the registry's own words, through the same function the plan
  // and the chips use, so the repair cannot drift into a different style.
  if (direction) lines.push('', `Direction, unchanged: ${describeDirection(direction)}.`);
  return lines.join('\n');
}
