/**
 * Files the operator attaches in the composer.
 *
 * A note, a CSV, a bug report, a page of JSON — the things someone has open
 * when they ask for something to be done with them. They are read in the
 * browser and travel inside the request as text, so nothing has to be uploaded
 * to a bucket, nothing has to be fetched from a sandbox, and a file that never
 * leaves the phone cannot leak from a server.
 *
 * Two rules shape everything here:
 *
 *   1. The operator's own words stay the record. The file contents are folded
 *      into the *wire* prompt — what the engine is handed — and never into the
 *      message stored in the conversation. A thread that shows 40 KB of CSV in
 *      the operator's own voice is a thread nobody can read.
 *   2. A refusal is a sentence, not a status code. Every rejection names the
 *      file and the limit it broke, because "400 Bad Request" is not an answer
 *      to "why did my file not send".
 */

export interface Attachment {
  /** The file's own name, trimmed and capped so it cannot break a header. */
  name: string;
  text: string;
}

export const ATTACHMENT_LIMITS = {
  /** Files per task. Three is already a lot to reason about in one prompt. */
  count: 3,
  /** Bytes per file. A note or a data extract, not a novel. */
  bytes: 200_000,
  /** Bytes across all files, so three legal files cannot add up to a book. */
  total: 400_000,
} as const;

export type ParsedAttachments =
  | { ok: true; attachments: Attachment[] }
  | { ok: false; message: string };

const isText = (s: string): boolean => !s.includes('\u0000') && !s.includes('\uFFFD');

/**
 * Validate what arrived on the request.
 *
 * Callers pass `unknown` on purpose: this bounds a body that a client — or
 * anyone who found the URL — chose. Anything that is not a well-formed list of
 * text files is refused with the reason, and an absent field is simply no files.
 */
export function parseAttachments(raw: unknown): ParsedAttachments {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'attachments must be a list of files' };
  if (raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > ATTACHMENT_LIMITS.count) {
    return { ok: false, message: `at most ${ATTACHMENT_LIMITS.count} files per task` };
  }

  const attachments: Attachment[] = [];
  let total = 0;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, message: 'each attachment needs a name and its text' };
    }
    const { name, text } = entry as { name?: unknown; text?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, message: 'each attachment needs a name' };
    }
    if (typeof text !== 'string') {
      return { ok: false, message: `${name.trim().slice(0, 60)} was sent without its text` };
    }
    if (!isText(text)) {
      return { ok: false, message: `${name.trim().slice(0, 60)} is not a text file` };
    }
    if (text.length > ATTACHMENT_LIMITS.bytes) {
      return {
        ok: false,
        message: `${name.trim().slice(0, 60)} is larger than ${Math.round(ATTACHMENT_LIMITS.bytes / 1000)} KB`,
      };
    }
    total += text.length;
    if (total > ATTACHMENT_LIMITS.total) {
      return {
        ok: false,
        message: `the files add up to more than ${Math.round(ATTACHMENT_LIMITS.total / 1000)} KB`,
      };
    }
    attachments.push({ name: cap(name), text });
  }
  return { ok: true, attachments };
}

/** A name that is safe to print, safe in a header, and still recognisable. */
function cap(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 120);
}

/** "notes.md, plan.csv" — for the line the thread shows under the question. */
export function attachmentNames(attachments: Attachment[]): string {
  return attachments.map((a) => a.name).join(', ');
}

/**
 * The line the operator's own message gains, so the thread says what was sent
 * without pretending the file was typed. Returns '' when nothing was attached.
 */
export function attachmentSummary(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';
  const names = attachmentNames(attachments);
  return `\n\n📎 ${attachments.length === 1 ? 'Attached' : 'Attached files'}: ${names}`;
}

/**
 * The prompt the engine reads: the operator's words, then the files.
 *
 * Fenced and labelled, because a model handed raw CSV after a sentence will
 * read the CSV as the sentence's continuation. The fence also gives the model
 * something to point at when it answers.
 */
export function withAttachments(prompt: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return prompt;
  const blocks = attachments.map((a) =>
    `--- ${a.name} ---\n${a.text}${a.text.endsWith('\n') ? '' : '\n'}--- end of ${a.name} ---`,
  );
  return (
    `${prompt}\n\n` +
    `[The operator attached ${attachments.length} file${attachments.length === 1 ? '' : 's'} ` +
    `to this task. ${attachmentNames(attachments)} ${attachments.length === 1 ? 'is' : 'are'} below, ` +
    `between the markers. Use them as the operator's own material.]\n\n` +
    blocks.join('\n\n')
  );
}
