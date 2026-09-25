/**
 * Files and pictures the operator attaches in the composer.
 *
 * A note, a CSV, a bug report, a page of JSON, or a screenshot of the layout
 * that is wrong — the things someone has in hand when they ask for something to
 * be done with them. Everything is read in the browser and travels inside the
 * request, so nothing has to be uploaded to a bucket, nothing has to be fetched
 * from a sandbox, and a file that never leaves the phone cannot leak from a
 * server. Pictures are the one thing the agent itself can look at: Google's
 * Antigravity agent takes text and image parts, images as inline base64.
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

/**
 * A picture the operator attached — a screenshot of the broken layout, the
 * chart they want read, the page they want matched.
 *
 * `data` is base64 with the `data:` prefix already gone, because that is
 * exactly the shape the agent's own image part wants: a small translation here
 * instead of a transformation at the API call.
 */
export interface ImageAttachment {
  /** The file's own name, trimmed and capped so it cannot break a line. */
  name: string;
  /** One of IMAGE_TYPES. */
  mimeType: string;
  /** Base64, no prefix. */
  data: string;
}

export const IMAGE_LIMITS = {
  /** Images per task. Three pictures is already a lot to look at in one pass. */
  count: 3,
  /** Base64 characters per image — about 1.5 MB of pixels. */
  bytes: 2_000_000,
  /** Base64 characters across all images, so three legal ones cannot add up to
   *  a request the API refuses. */
  total: 4_000_000,
} as const;

/**
 * What the agent can look at. The list is Google's, not a guess: the Antigravity
 * agent takes text and image parts, and these are the image types its siblings
 * document. SVG is deliberately absent — it is markup, not pixels, and sending
 * it as an image would hand the model a page of XML labelled "screenshot".
 */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
]);

export type ParsedImages =
  | { ok: true; images: ImageAttachment[] }
  | { ok: false; message: string };

/**
 * Validate the images that arrived on the request. Same rules as the files: the
 * body is `unknown` because a client — or anyone who found the URL — chose it,
 * and every refusal is a sentence naming the file.
 */
export function parseImages(raw: unknown): ParsedImages {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'images must be a list of files' };
  if (raw.length === 0) return { ok: true, images: [] };
  if (raw.length > IMAGE_LIMITS.count) {
    return { ok: false, message: `at most ${IMAGE_LIMITS.count} images per task` };
  }

  const images: ImageAttachment[] = [];
  let total = 0;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, message: 'each image needs a name and its data' };
    }
    const { name, mimeType, data } = entry as {
      name?: unknown;
      mimeType?: unknown;
      data?: unknown;
    };
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, message: 'each image needs a name' };
    }
    const shown = name.trim().slice(0, 60);
    if (typeof data !== 'string') {
      return { ok: false, message: `${shown} was sent without its image data` };
    }
    // A `data:` URL is accepted and unwrapped rather than refused: the operator
    // is not at fault for the shape a browser hands over, and the mime travels
    // in it.
    let body = data.trim();
    let mime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
    if (body.startsWith('data:')) {
      const comma = body.indexOf(',');
      if (comma === -1) return { ok: false, message: `${shown}: not valid image data` };
      const header = body.slice(5, comma);
      const fromUrl = header.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!mime && fromUrl) mime = fromUrl;
      body = body.slice(comma + 1);
    }
    if (!mime) return { ok: false, message: `${shown} arrived without an image type` };
    if (!IMAGE_TYPES.has(mime)) {
      if (mime === 'image/svg+xml') {
        return {
          ok: false,
          message: `${shown}: SVG is drawing instructions, not a picture the model can look at — send a PNG, JPEG or WEBP`,
        };
      }
      return {
        ok: false,
        message: `${shown}: ${mime} is not an image type I can send (PNG, JPEG, WEBP, GIF, HEIC or AVIF)`,
      };
    }
    if (!BASE64_RE.test(body)) return { ok: false, message: `${shown}: not valid image data` };
    if (body.length > IMAGE_LIMITS.bytes) {
      return {
        ok: false,
        message: `${shown} is larger than ${Math.round(IMAGE_LIMITS.bytes / 1500)} KB`,
      };
    }
    total += body.length;
    if (total > IMAGE_LIMITS.total) {
      return {
        ok: false,
        message: `the images add up to more than ${Math.round(IMAGE_LIMITS.total / 1500)} KB`,
      };
    }
    images.push({ name: cap(name), mimeType: mime, data: body });
  }
  return { ok: true, images };
}

/** Base64, and only base64: no whitespace, no prose, no half a data URL. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** "shot.png, chart.jpg" — for the line the thread shows under the question. */
export function imageNames(images: ImageAttachment[]): string {
  return images.map((i) => i.name).join(', ');
}

/** The line the operator's own message gains, so the thread says what was sent. */
export function imageSummary(images: ImageAttachment[]): string {
  if (images.length === 0) return '';
  return `\n\n🖼 ${images.length} image${images.length === 1 ? '' : 's'}: ${imageNames(images)}`;
}

/**
 * What the engine is told about them.
 *
 * The pixels travel as their own parts of the request, so this is a note, not a
 * payload: it names them and fixes their order, so an instruction like "match
 * the second screenshot" has something to point at.
 */
export function withImageNote(prompt: string, images: ImageAttachment[]): string {
  if (images.length === 0) return prompt;
  const one = images.length === 1;
  return (
    `${prompt}\n\n[The operator attached ${images.length} image${one ? '' : 's'} to this task: ` +
    `${imageNames(images)}. ${one ? 'It is' : 'They are'} part of this request, in that order — ` +
    `read ${one ? 'it' : 'them'} as the operator's own material.]`
  );
}

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
 * The operator's own words, recovered from the text the thread shows.
 *
 * The stored prompt is the operator's sentence plus a line naming what they
 * attached. Anything that has to judge *the request itself* — is this a complex
 * task? is it a build? — must read the sentence, not the attachment notice, or
 * a 300 KB paste would make every attachment look like a big task.
 */
export function stripAttachmentSummary(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\p{Extended_Pictographic}\s*(Attached|\d+ images?)/u.test(line))
    .join('\n')
    .trim();
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
