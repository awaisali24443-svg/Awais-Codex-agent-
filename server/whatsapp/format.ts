/**
 * Markdown → WhatsApp.
 *
 * The agent answers in Markdown; WhatsApp has its own, smaller inline syntax
 * and it is not Markdown. Sending raw model output puts literal asterisks in
 * the chat — `**Total:** $42` arrives as `**Total:** $42` — which the platform's
 * own documentation calls the single most common way an agent reply looks
 * broken.
 *
 *   WhatsApp        Markdown it replaces
 *   *bold*          **bold** / __bold__
 *   _italic_        *italic*
 *   ~strike~        ~~strike~~
 *   ```block```     fenced code with a language tag
 *   `inline`        `inline`
 *
 * Headings, links, tables and horizontal rules have no WhatsApp equivalent at
 * all, so they are *reduced* rather than translated: a heading becomes bold, a
 * link becomes its text plus the URL in brackets (WhatsApp auto-links bare
 * URLs, so the reader still gets a tappable one).
 *
 * The conversion is intentionally conservative. WhatsApp has no escape
 * character, so anything that is not confidently Markdown is left exactly as
 * written — mangling an answer to make it prettier is a worse failure than a
 * stray asterisk.
 */

/** Fenced blocks are protected first, so formatting never rewrites code. */
const FENCE = /```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g;

interface Protected {
  text: string;
  blocks: string[];
}

/**
 * Pull fenced code out of the way.
 *
 * Code is the one place where `*` and `_` must survive verbatim: a Python
 * `**kwargs` or a shell `$*` would be mangled by the inline rules.
 */
function protectCode(input: string): Protected {
  const blocks: string[] = [];
  const text = input.replace(FENCE, (_match, _language: string, body: string) => {
    const trimmed = body.replace(/\s+$/, '');
    const index = blocks.push(`\`\`\`\n${trimmed}\n\`\`\``) - 1;
    return `\u0000${index}\u0000`;
  });
  return { text, blocks };
}

function restoreCode(input: string, blocks: string[]): string {
  return input.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? '');
}

/** Inline code spans are protected the same way, per line. */
function mapOutsideInlineCode(text: string, transform: (chunk: string) => string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? part : transform(part)))
    .join('');
}

function convertInline(line: string): string {
  return mapOutsideInlineCode(line, (chunk) => {
    // Finished conversions are held aside while the remaining rules run. This
    // is not tidiness: `**bold**` becomes `*bold*`, which the italic rule would
    // then happily rewrite a second time into `_bold_` — silently turning bold
    // into italic. Ordering the passes is not enough (the patterns overlap on
    // `a **b** c`), so the output of each pass is removed from their reach.
    const held: string[] = [];
    const hold = (value: string): string => `\u0001${held.push(value) - 1}\u0001`;

    let out = chunk;

    // Links: keep the text, show the URL — WhatsApp auto-links bare URLs.
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
      label && label !== url ? `${label} (${url})` : url,
    );

    // Bold: **x** and __x__ both become *x*.
    out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => hold(`*${body}*`));
    out = out.replace(/__([^_\n]+)__/g, (_m, body: string) => hold(`*${body}*`));

    // Strikethrough: ~~x~~ becomes ~x~.
    out = out.replace(/~~([^~\n]+)~~/g, (_m, body: string) => hold(`~${body}~`));

    // Single-asterisk italic (Markdown) becomes single-underscore (WhatsApp).
    // Requiring non-whitespace just inside the asterisks is what stops a stray
    // `2 * 3` from arriving as italics.
    out = out.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,!?:;]|$)/g, '$1_$2_');

    return out.replace(/\u0001(\d+)\u0001/g, (_m, index: string) => held[Number(index)] ?? '');
  });
}

function convertLine(line: string): string {
  const trimmed = line.trim();

  // Headings have no equivalent: bold the text and drop the hashes.
  const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (heading) return `*${heading[2].trim()}*`;

  // Horizontal rules likewise: a short divider reads better than `---`.
  if (/^([-*_])\1{2,}$/.test(trimmed)) return '———';

  // Block quotes already match WhatsApp's `> ` syntax; leave the body alone.
  if (trimmed.startsWith('>')) return trimmed;

  // Lists and task list items keep their marker.
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}- ${convertInline(bullet[2])}`;

  const ordered = /^(\s*\d+[.)])\s+(.*)$/.exec(line);
  if (ordered) return `${ordered[1]} ${convertInline(ordered[2])}`;

  return convertInline(line);
}

/** Convert one Markdown answer into a WhatsApp-safe message. */
export function toWhatsAppText(markdown: string): string {
  const source = String(markdown ?? '');
  if (!source.trim()) return '';

  const { text, blocks } = protectCode(source);

  // Tables: WhatsApp has no table rendering. A row becomes "a · b · c" and the
  // `|---|---|` separator disappears, so the information survives instead of
  // arriving as pipes and dashes.
  const withoutTables = text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.includes('|')) return line;
      if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed)) return '';
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        return trimmed
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(' · ');
      }
      return line;
    })
    .join('\n');

  const converted = withoutTables.split('\n').map(convertLine).join('\n');
  return restoreCode(converted, blocks).replace(/\n{3,}/g, '\n\n').trim();
}
