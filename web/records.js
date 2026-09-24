/* ==========================================================================
   Records: what a file is, and what a cited link is.

   Pure functions only — no DOM, no browser globals, no network. The browser
   wiring lives in app.js; everything here is unit-testable under tsx, which is
   how the parsing rules below are pinned.

   Two jobs:

   1. A file the task produced gets a *card*, not a filename. The card needs to
      know what kind of thing it is (an HTML page reads differently from an APK
      or a CSV), how big it is, and whether it is being kept.
   2. An answer that cites the web should show its sources as a small list —
      domain, title, and whether the link was actually checked. The links are
      already in the answer text; this turns them into something a reader can
      scan.
   ========================================================================== */

/** Kind of a produced file, from its name alone. Ordered: first match wins. */
const KINDS = [
  { id: 'html', label: 'Web page', icon: 'globe', re: /\.(html?|xhtml)$/i },
  { id: 'image', label: 'Image', icon: 'eye', re: /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i },
  { id: 'pdf', label: 'PDF', icon: 'file', re: /\.pdf$/i },
  { id: 'apk', label: 'Android app', icon: 'android', re: /\.(apk|aab)$/i },
  { id: 'archive', label: 'Archive', icon: 'package', re: /\.(zip|tar|gz|tgz|7z|rar)$/i },
  { id: 'sheet', label: 'Spreadsheet', icon: 'list', re: /\.(csv|tsv|xlsx?|ods)$/i },
  { id: 'data', label: 'Data', icon: 'code', re: /\.(json|ya?ml|xml|sql|db|sqlite)$/i },
  { id: 'doc', label: 'Document', icon: 'file', re: /\.(md|markdown|txt|rtf|docx?|odt)$/i },
  { id: 'code', label: 'Code', icon: 'code', re: /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|cc|cpp|h|cs|php|swift|sh|css|scss)$/i },
];

/**
 * What kind of file this is. Unknown extensions are files, honestly labelled —
 * a wrong guess is worse than no guess. The parameter is typed loosely because
 * it comes off an API response, where anything can be missing.
 * @param {unknown} name
 * @returns {{ id: string, label: string, icon: string }}
 */
export function artifactKind(name) {
  const text = typeof name === 'string' ? name : '';
  for (const kind of KINDS) {
    if (kind.re.test(text)) return { id: kind.id, label: kind.label, icon: kind.icon };
  }
  return { id: 'file', label: 'File', icon: 'file' };
}

/**
 * The one line under a file's name: what it is, how big it is, whether it is
 * being kept. Empty pieces are dropped rather than leaving stray separators.
 * @param {{ name?: unknown, size?: number|null, pinned?: boolean, stored?: boolean }} artifact
 * @param {(bytes: number) => string} formatBytes
 */
export function artifactMeta(artifact, formatBytes) {
  const kind = artifactKind(artifact?.name ?? '');
  const parts = [kind.label];
  if (artifact?.size) parts.push(formatBytes(artifact.size));
  // "Kept" is a promise about retention; "stored" only means the bytes are in
  // the database right now. Only the first belongs on the card.
  if (artifact?.pinned) parts.push('Kept');
  return parts.join(' · ');
}

/** A URL's host, without `www.`, or '' when it is not a usable link. */
export function domainOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The letter on a source's badge, for a list that has no favicons. */
export function badgeFor(domain) {
  const letter = String(domain || '').trim().charAt(0);
  return letter ? letter.toUpperCase() : '•';
}

const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()"']+/g;
/** Trailing punctuation belongs to the sentence, not to the URL. */
const TRAILING = /[.,;:!?]+$/;

/**
 * Every link an answer cites, in the order it cites them, deduplicated.
 *
 * Markdown links win over bare URLs for the same target, because their text is
 * what the answer meant to call the source ("RBI circular" beats
 * "rbi.org.in/..."). Bare URLs still count: models write them.
 *
 * @param {string} text the answer as written
 * @returns {Array<{ url: string, label: string, domain: string, badge: string }>}
 */
export function sourcesFromText(text) {
  const source = typeof text === 'string' ? text : '';
  const found = new Map();

  const add = (url, label) => {
    const clean = String(url).replace(TRAILING, '');
    const domain = domainOf(clean);
    if (!domain) return;
    const existing = found.get(clean);
    if (existing) {
      // A later markdown link doesn't override an earlier named one.
      if (!existing.named && label && label !== clean) {
        found.set(clean, { ...existing, label, named: true });
      }
      return;
    }
    found.set(clean, {
      url: clean,
      label: label && label !== clean ? label : domain,
      domain,
      badge: badgeFor(domain),
      named: !!(label && label !== clean),
    });
  };

  for (const m of source.matchAll(MD_LINK)) add(m[2], m[1]);
  // Skip inside markdown-link syntax so `](url)` is not read twice.
  const withoutMd = source.replace(MD_LINK, ' ');
  for (const m of withoutMd.matchAll(BARE_URL)) add(m[0], '');

  return [...found.values()].map(({ url, label, domain, badge }) => ({ url, label, domain, badge }));
}

/**
 * Mark each source with what the server's link check found. A dead link is a
 * fact about the answer, so it is shown rather than hidden.
 * @param {Array<{url: string}>} sources
 * @param {string[]} dead
 */
export function markDead(sources, dead) {
  const deadSet = new Set((Array.isArray(dead) ? dead : []).map((u) => String(u).replace(TRAILING, '')));
  return sources.map((s) => ({ ...s, dead: deadSet.has(s.url) }));
}

/** How the strip's summary line reads. */
export function sourcesSummary(sources, checked = 0) {
  const total = sources.length;
  const dead = sources.filter((s) => s.dead).length;
  if (total === 0) return '';
  const word = total === 1 ? 'source' : 'sources';
  if (checked > 0 && total > checked) {
    // The server checked fewer links than the answer cites; say the smaller,
    // true number rather than claiming more coverage than happened.
    return `${checked} of ${total} ${word} checked${dead ? ` · ${dead} dead` : ''}`;
  }
  return `${total} ${word}${dead ? ` · ${dead} dead` : ''}`;
}
