/**
 * WhatsApp Agent Platform client — the wire, and nothing else.
 *
 * This speaks `POST /messages`, `GET /updates` and `POST /statuses` against
 * `https://api.whatsapp.com/agent/v1` (overridable, so tests point it at a
 * local fake). It knows nothing about runs, tasks or the database: the poller
 * above it decides what an inbound message means.
 *
 * The facts that shape every line here, all from the platform's own contract:
 *
 *   ONE RECIPIENT
 *     An agent has exactly one recipient — its creator. `to` is optional and
 *     must be the `user:<id>` the platform gave us on an inbound message, so
 *     the id is learned from traffic and passed back unchanged, never typed in.
 *
 *   SENDS ARE NOT IDEMPOTENT
 *     A 4xx means it was not sent and a retry fails the same way; a 429 or a
 *     503/131016 means it was not sent and a retry is safe; a 500 or a dropped
 *     connection means *unknown*, and a blind retry can deliver twice. So sends
 *     are never retried here — the caller decides, and the answer is no.
 *
 *   ORDER IS NOT PRESERVED UNDER CONCURRENCY
 *     Two sends in flight at once can arrive out of order, so every send goes
 *     through one caller-side queue (see the poller).
 *
 *   MARKING READ DELETES
 *     A message leaves the platform's buffer the moment it is marked read, so
 *     read receipts are sent only after the message is safely recorded.
 */

export const DEFAULT_API_BASE = 'https://api.whatsapp.com/agent/v1';

/** Documented cap on a text body. Longer replies must be split. */
export const MAX_TEXT_CHARS = 4_096;

export type WaErrorKind =
  | 'aborted'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'rate_limited'
  | 'poll_replaced'
  | 'unavailable'
  | 'server'
  | 'network'
  | 'unknown';

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly kind: WaErrorKind,
    readonly status?: number,
    readonly code?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }

  /**
   * Safe to retry: the platform said it did not deliver. Deliberately excludes
   * `server` and `network`, where the message may well have gone out.
   */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

export interface InboundMessage {
  /** wamid — the platform's message id, and our idempotency key. */
  id: string;
  /** `user:<id>`; also the value to send back to. */
  from: string;
  timestamp: number | null;
  type: string;
  /** Present for `type: 'text'`. */
  text: string;
  /** Quote context, when the user replied to one of our messages. */
  contextId: string | null;
  profileName: string | null;
}

export interface InboundStatus {
  id: string;
  status: string;
  recipient: string | null;
  timestamp: number | null;
}

export interface Updates {
  messages: InboundMessage[];
  statuses: InboundStatus[];
  contacts: Array<{ waId: string; name: string | null }>;
  nextOffset: number;
  agentId: string | null;
  raw: unknown;
}

export interface WhatsAppOptions {
  token: string;
  baseUrl?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Extra slack on top of the long-poll window before the socket is aborted. */
  timeoutSlackMs?: number;
}

interface FetchOutcome {
  status: number;
  headers: Headers;
  text: string;
}

function parseErrorCode(body: unknown): number | undefined {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === 'number' ? error.code : undefined;
}

function parseErrorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: { message?: unknown; details?: unknown } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message : fallback;
  const details = typeof error?.details === 'string' ? ` (${error.details})` : '';
  return `${message}${details}`;
}

/** Map status + platform error code onto something the poller can act on. */
function classify(status: number, code: number | undefined, message: string): WaErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  // 409 (1752041) means a newer poll replaced ours: one poll per agent.
  if (status === 409) return 'poll_replaced';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) {
    // 100 = malformed request or bad token; 190 = missing/malformed header.
    return code === 190 ? 'auth' : 'invalid';
  }
  if (status === 503 && code === 131016) return 'unavailable';
  if (status >= 500) return 'server';
  return 'unknown';
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

/**
 * Split a reply into platform-legal chunks.
 *
 * Breaks on the last paragraph, then sentence, then word boundary so a chunk
 * never lands mid-word. A single unbreakable run longer than the cap is cut
 * hard — losing a line break is better than failing to deliver the answer.
 */
export function splitText(text: string, limit = MAX_TEXT_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf(' '),
    );
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class WhatsAppClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutSlackMs: number;

  constructor(private readonly options: WhatsAppOptions) {
    if (!options.token) throw new Error('WhatsAppClient: token is required');
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutSlackMs = options.timeoutSlackMs ?? 15_000;
  }

  private async call(
    path: string,
    init: {
      method: string;
      body?: unknown;
      query?: Record<string, string | number>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<FetchOutcome> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    // The read timeout must outlast the long poll, or every empty poll would
    // look like a network failure.
    const budget = (init.timeoutMs ?? 30_000) + this.timeoutSlackMs;

    // One controller fed by two sources: the wall clock and the caller's stop
    // signal. A 25-second long poll means `AbortSignal.timeout` alone would
    // make shutdown wait out the whole window.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), budget);
    const onExternalAbort = (): void => controller.abort(new Error('aborted'));
    init.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw new WhatsAppError(`call to ${path} aborted`, 'aborted');
      const message = err instanceof Error ? err.message : String(err);
      throw new WhatsAppError(`network failure calling ${path}: ${message}`, 'network');
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onExternalAbort);
    }

    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  }

  private static parseJson(text: string): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Long-poll for inbound updates.
   *
   * Returns `null` for the 204 that means "nothing yet" — and a 204 carries no
   * `next_offset`, so the caller must re-poll with the same offset.
   */
  async getUpdates(options: {
    offset?: number | null;
    limit?: number;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  } = {}): Promise<Updates | null> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    const timeoutSeconds = Math.min(Math.max(Math.trunc(options.timeoutSeconds ?? 25), 0), 25);
    const query: Record<string, string | number> = { limit, timeout: timeoutSeconds };
    // Omitting `offset` resolves to the head *at request time*; only ever done
    // once, on a first run with no stored cursor. After that the stored value
    // is passed explicitly so nothing can slip between two polls.
    if (options.offset !== null && options.offset !== undefined) query.offset = options.offset;

    const outcome = await this.call('/updates', {
      method: 'GET',
      query,
      timeoutMs: timeoutSeconds * 1000,
      signal: options.signal,
    });

    if (outcome.status === 204) return null;

    const body = WhatsAppClient.parseJson(outcome.text);
    if (outcome.status !== 200) {
      const code = parseErrorCode(body);
      throw new WhatsAppError(
        parseErrorMessage(body, `updates failed with HTTP ${outcome.status}`),
        classify(outcome.status, code, outcome.text),
        outcome.status,
        code,
        retryAfterMs(outcome.headers),
      );
    }

    return parseUpdates(body);
  }

  async sendText(
    body: string,
    options: { replyTo?: string | null; previewUrl?: boolean } = {},
  ): Promise<{ messageId: string | null; waId: string | null }> {
    if (body.length > MAX_TEXT_CHARS) {
      throw new WhatsAppError(
        `text is ${body.length} characters; the platform caps a message at ${MAX_TEXT_CHARS}`,
        'invalid',
      );
    }

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      type: 'text',
      text: options.previewUrl ? { body, preview_url: true } : { body },
    };
    // Omitted deliberately: the platform knows the single recipient. Passing an
    // id we did not learn from traffic is how a send goes to the wrong place.
    if (options.replyTo) payload.context = { message_id: options.replyTo };

    const outcome = await this.call('/messages', { method: 'POST', body: payload });
    const parsed = WhatsAppClient.parseJson(outcome.text);

    if (outcome.status < 200 || outcome.status >= 300) {
      const code = parseErrorCode(parsed);
      throw new WhatsAppError(
        parseErrorMessage(parsed, `send failed with HTTP ${outcome.status}`),
        classify(outcome.status, code, outcome.text),
        outcome.status,
        code,
        retryAfterMs(outcome.headers),
      );
    }

    const messages = (parsed as { messages?: Array<{ id?: unknown }> } | null)?.messages;
    const waId = (parsed as { contacts?: Array<{ wa_id?: unknown }> } | null)?.contacts?.[0]?.wa_id;
    return {
      messageId: typeof messages?.[0]?.id === 'string' ? messages[0].id : null,
      waId: typeof waId === 'string' ? waId : null,
    };
  }

  /**
   * Mark a message read — optionally raising the typing indicator in the same
   * call, which is what makes the phone show "typing…" while the agent works.
   *
   * This *removes* the message from the platform's replay buffer, so the caller
   * must have persisted it first.
   */
  async markRead(messageId: string, options: { typing?: boolean } = {}): Promise<void> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };
    if (options.typing) payload.typing_indicator = { type: 'text' };

    const outcome = await this.call('/statuses', { method: 'POST', body: payload });
    if (outcome.status < 200 || outcome.status >= 300) {
      const parsed = WhatsAppClient.parseJson(outcome.text);
      const code = parseErrorCode(parsed);
      throw new WhatsAppError(
        parseErrorMessage(parsed, `status update failed with HTTP ${outcome.status}`),
        classify(outcome.status, code, outcome.text),
        outcome.status,
        code,
        retryAfterMs(outcome.headers),
      );
    }
  }
}

/**
 * The platform delivers a webhook-shaped envelope even through the poll:
 *
 *   { object, entry: [{ id, changes: [{ field, value: { messages, statuses,
 *     contacts } }] }], next_offset }
 *
 * Several changes can ride in one poll, so messages are flattened — and parsed
 * defensively, because a malformed entry must not take the whole loop down.
 */
export function parseUpdates(body: unknown): Updates {
  const root = (body ?? {}) as {
    entry?: unknown;
    next_offset?: unknown;
  };

  const messages: InboundMessage[] = [];
  const statuses: InboundStatus[] = [];
  const contacts: Array<{ waId: string; name: string | null }> = [];
  let agentId: string | null = null;

  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const entryObj = entry as { id?: unknown; changes?: unknown };
    if (agentId === null && typeof entryObj.id === 'string') agentId = entryObj.id;

    const changes = Array.isArray(entryObj.changes) ? entryObj.changes : [];
    for (const change of changes) {
      const value = (change as { value?: unknown }).value as {
        messages?: unknown;
        statuses?: unknown;
        contacts?: unknown;
      } | null;
      if (!value) continue;

      for (const raw of Array.isArray(value.contacts) ? value.contacts : []) {
        const contact = raw as { wa_id?: unknown; profile?: { name?: unknown } };
        if (typeof contact.wa_id !== 'string') continue;
        contacts.push({
          waId: contact.wa_id,
          name: typeof contact.profile?.name === 'string' ? contact.profile.name : null,
        });
      }

      for (const raw of Array.isArray(value.messages) ? value.messages : []) {
        const message = raw as {
          id?: unknown;
          from?: unknown;
          timestamp?: unknown;
          type?: unknown;
          text?: { body?: unknown };
          context?: { id?: unknown };
          from_profile_name?: unknown;
        };
        if (typeof message.id !== 'string') continue;
        const ts = Number(message.timestamp);
        const profile = contacts.find((c) => c.waId === message.from)?.name ?? null;
        messages.push({
          id: message.id,
          from: typeof message.from === 'string' ? message.from : '',
          timestamp: Number.isFinite(ts) ? ts : null,
          type: typeof message.type === 'string' ? message.type : 'unknown',
          text: typeof message.text?.body === 'string' ? message.text.body : '',
          contextId: typeof message.context?.id === 'string' ? message.context.id : null,
          profileName:
            typeof message.from_profile_name === 'string' ? message.from_profile_name : profile,
        });
      }

      for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = raw as {
          id?: unknown;
          status?: unknown;
          recipient_id?: unknown;
          recipient?: unknown;
          timestamp?: unknown;
        };
        if (typeof status.id !== 'string') continue;
        const ts = Number(status.timestamp);
        const recipient = status.recipient_id ?? status.recipient;
        statuses.push({
          id: status.id,
          status: typeof status.status === 'string' ? status.status : 'unknown',
          recipient: typeof recipient === 'string' ? recipient : null,
          timestamp: Number.isFinite(ts) ? ts : null,
        });
      }
    }
  }

  const nextOffset = Number(root.next_offset);
  return {
    messages,
    statuses,
    contacts,
    nextOffset: Number.isFinite(nextOffset) ? nextOffset : 0,
    agentId,
    raw: body,
  };
}
