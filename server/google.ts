/**
 * Google connectors (Gmail + Calendar, read-only) — pure API helpers.
 *
 * Mirrors the LinkedIn module's shape: OAuth authorize URL, code exchange,
 * API calls, and a sealed-token store. Two deliberate differences from
 * LinkedIn:
 *
 * - Google issues refresh tokens (with access_type=offline + prompt=consent),
 *   so the connection survives indefinitely — the access token is refreshed
 *   on demand and the operator only reconnects if they revoke access.
 * - Scope is read-only by design (gmail.readonly, calendar.readonly).
 *   Sending mail or creating events needs an approval UX that does not exist
 *   yet, so this module has no write calls at all.
 *
 * The agent reaches these reads through fenced blocks in its answer
 * (```gmail-search / ```gmail-read / ```calendar-list); the executor runs
 * them between engine passes and logs every access as a `google.read` event,
 * so the UI shows exactly what the agent looked at.
 */
import type { Db } from './db.js';
import { openSecret, sealSecret } from './crypto.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
/** One Google call must never hang a request. */
export const GOOGLE_CALL_TIMEOUT_MS = 15_000;
/** Read-only: mail + calendar. Sending needs an approval UX first. */
export const GOOGLE_SCOPES =
  'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly';

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS);
}

/** The URL the operator opens to grant access. `state` must be validated back. */
export function buildGoogleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPES,
    // offline + prompt=consent: Google returns a refresh token every time,
    // so the connection does not die with the 1-hour access token.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleCodeExchange {
  accessToken: string;
  /** Present on first grant and whenever prompt=consent is sent. */
  refreshToken: string | null;
  expiresIn: number;
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

export async function exchangeGoogleCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleCodeExchange> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: timeoutSignal(),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (${res.status}): ${await readError(res)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error('Google token exchange returned no access token');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in ?? 3600,
  };
}

export async function refreshGoogleAccessToken(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number; refreshToken: string | null }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: timeoutSignal(),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status}): ${await readError(res)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!json.access_token) throw new Error('Google token refresh returned no access token');
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in ?? 3600,
    refreshToken: json.refresh_token ?? null,
  };
}

export interface GoogleUserInfo {
  email: string;
  name: string;
}

export async function fetchGoogleUserInfo(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleUserInfo> {
  const res = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Google userinfo failed (${res.status}): ${await readError(res)}`);
  const json = (await res.json()) as { email?: string; name?: string };
  if (!json.email) throw new Error('Google userinfo returned no email');
  return { email: json.email, name: json.name ?? '' };
}

// ---------------------------------------------------------------------------
// storage: one sealed token row. The blob holds the refresh token and the
// current access token, so a restart never loses the connection.
// ---------------------------------------------------------------------------

const TOKEN_AAD_NAME = 'google_token';

interface TokenBlob {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms when the access token stops being valid. */
  accessExpiresAt: number;
}

export interface StoredGoogleToken {
  email: string;
  name: string;
  blob: TokenBlob;
}

export async function saveGoogleToken(
  db: Db,
  masterKey: string,
  input: {
    refreshToken: string;
    accessToken: string;
    expiresIn: number;
    email: string;
    name: string;
  },
): Promise<void> {
  const blob: TokenBlob = {
    refreshToken: input.refreshToken,
    accessToken: input.accessToken,
    accessExpiresAt: Date.now() + input.expiresIn * 1000,
  };
  const sealed = sealSecret(masterKey, TOKEN_AAD_NAME, JSON.stringify(blob));
  await db.query(
    `INSERT INTO google_tokens (id, ciphertext, iv, tag, member_email, member_name, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
       member_email = EXCLUDED.member_email, member_name = EXCLUDED.member_name,
       updated_at = now()`,
    [sealed.ciphertext, sealed.iv, sealed.tag, input.email, input.name],
  );
}

export async function loadGoogleToken(db: Db, masterKey: string): Promise<StoredGoogleToken | null> {
  const rows = await db.query<{
    ciphertext: string;
    iv: string;
    tag: string;
    member_email: string;
    member_name: string;
  }>(`SELECT ciphertext, iv, tag, member_email, member_name FROM google_tokens WHERE id = 'default'`);
  const row = rows[0];
  if (!row) return null;
  const raw = openSecret(masterKey, TOKEN_AAD_NAME, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    tag: row.tag,
  });
  const blob = JSON.parse(raw) as TokenBlob;
  if (!blob.refreshToken || !blob.accessToken) return null;
  return { email: row.member_email, name: row.member_name, blob };
}

export async function clearGoogleToken(db: Db): Promise<void> {
  await db.query(`DELETE FROM google_tokens WHERE id = 'default'`);
}

/**
 * A usable access token, refreshing it first when it is expired or nearly
 * so. Null when there is no connection or the refresh fails (revoked).
 * Never throws for the ordinary "not connected" case.
 */
export async function getValidAccessToken(
  db: Db,
  masterKey: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let stored: StoredGoogleToken | null;
  try {
    stored = await loadGoogleToken(db, masterKey);
  } catch {
    return null;
  }
  if (!stored) return null;
  if (stored.blob.accessExpiresAt - Date.now() > 60_000) return stored.blob.accessToken;
  try {
    const refreshed = await refreshGoogleAccessToken(
      { clientId, clientSecret, refreshToken: stored.blob.refreshToken },
      fetchImpl,
    );
    await saveGoogleToken(db, masterKey, {
      refreshToken: refreshed.refreshToken ?? stored.blob.refreshToken,
      accessToken: refreshed.accessToken,
      expiresIn: refreshed.expiresIn,
      email: stored.email,
      name: stored.name,
    });
    return refreshed.accessToken;
  } catch (err) {
    console.warn('[google] access token refresh failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// read API: Gmail search/read, Calendar list. Read-only, always.
// ---------------------------------------------------------------------------

export interface GmailMessageSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
}

export async function searchGmail(
  accessToken: string,
  query: string,
  maxResults = 5,
  fetchImpl: typeof fetch = fetch,
): Promise<GmailMessageSummary[]> {
  const max = Math.min(10, Math.max(1, maxResults));
  const url = `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Gmail search failed (${res.status}): ${await readError(res)}`);
  const json = (await res.json()) as { messages?: Array<{ id?: string }> };
  const ids = (json.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  const out: GmailMessageSummary[] = [];
  for (const id of ids) {
    out.push(await getGmailMetadata(accessToken, id, fetchImpl));
  }
  return out;
}

async function getGmailMetadata(
  accessToken: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GmailMessageSummary> {
  const url =
    `${GMAIL_API}/messages/${encodeURIComponent(id)}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Gmail read failed (${res.status}): ${await readError(res)}`);
  const json = (await res.json()) as {
    payload?: { headers?: Array<{ name?: string; value?: string }> };
  };
  const headers = new Map<string, string>();
  for (const h of json.payload?.headers ?? []) {
    if (h.name) headers.set(h.name.toLowerCase(), h.value ?? '');
  }
  return {
    id,
    from: headers.get('from') ?? '',
    subject: headers.get('subject') ?? '(no subject)',
    date: headers.get('date') ?? '',
  };
}

export interface GmailMessage extends GmailMessageSummary {
  snippet: string;
  bodyText: string;
}

function base64UrlDecode(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

interface GmailPayload {
  mimeType?: string;
  body?: { data?: string };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: GmailPayload[];
}

function findTextPlain(payload: GmailPayload | undefined): string | null {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) return payload.body.data;
  for (const part of payload.parts ?? []) {
    const found = findTextPlain(part);
    if (found) return found;
  }
  return null;
}

export async function readGmailMessage(
  accessToken: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GmailMessage> {
  const url = `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Gmail read failed (${res.status}): ${await readError(res)}`);
  const json = (await res.json()) as {
    snippet?: string;
    payload?: GmailPayload;
  };
  const meta = await getGmailMetadata(accessToken, id, fetchImpl);
  let bodyText = '';
  try {
    const encoded = findTextPlain(json.payload);
    if (encoded) bodyText = base64UrlDecode(encoded);
  } catch {
    bodyText = '';
  }
  return { ...meta, snippet: json.snippet ?? '', bodyText: bodyText.slice(0, 4000) };
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
}

export async function listCalendarEvents(
  accessToken: string,
  timeMin: string,
  timeMax: string,
  maxResults = 10,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  const max = Math.min(25, Math.max(1, maxResults));
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(max),
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  const res = await fetchImpl(`${CALENDAR_API}/calendars/primary/events?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`Calendar list failed (${res.status}): ${await readError(res)}`);
  const json = (await res.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      location?: string;
    }>;
  };
  return (json.items ?? []).map((item) => ({
    id: item.id ?? '',
    summary: item.summary ?? '(no title)',
    start: item.start?.dateTime ?? item.start?.date ?? '',
    end: item.end?.dateTime ?? item.end?.date ?? '',
    location: item.location ?? '',
  }));
}

// ---------------------------------------------------------------------------
// read requests: fenced blocks the engine emits; the executor runs them.
// ---------------------------------------------------------------------------

export type GoogleReadRequest =
  | { kind: 'gmail-search'; query: string; max: number }
  | { kind: 'gmail-read'; id: string }
  | { kind: 'calendar-list'; days: number };

const READ_FENCES = ['gmail-search', 'gmail-read', 'calendar-list'] as const;

function normalizeRequest(kind: (typeof READ_FENCES)[number], obj: unknown): GoogleReadRequest | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (kind === 'gmail-search') {
    const query = typeof o.query === 'string' ? o.query.trim().slice(0, 200) : '';
    if (!query) return null;
    const max = typeof o.max === 'number' ? Math.min(10, Math.max(1, Math.floor(o.max))) : 5;
    return { kind, query, max };
  }
  if (kind === 'gmail-read') {
    const id = typeof o.id === 'string' ? o.id.trim().slice(0, 100) : '';
    if (!id) return null;
    return { kind, id };
  }
  const days = typeof o.days === 'number' ? Math.min(30, Math.max(1, Math.floor(o.days))) : 7;
  return { kind, days };
}

/** Pull every well-formed read request out of engine text. Never throws. */
export function extractGoogleReadRequests(text: string): GoogleReadRequest[] {
  const out: GoogleReadRequest[] = [];
  for (const kind of READ_FENCES) {
    const re = new RegExp('```' + kind + '\\s*\\n([\\s\\S]*?)```', 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      try {
        const req = normalizeRequest(kind, JSON.parse(match[1]));
        if (req) out.push(req);
      } catch {
        // Not JSON — ignore the block.
      }
    }
  }
  return out;
}

export interface GoogleReadResult {
  request: GoogleReadRequest;
  ok: boolean;
  /** One line for the UI access log. */
  summary: string;
  /** The data fed back to the engine. Capped so a big inbox cannot blow the prompt. */
  detail: string;
}

const DETAIL_CAP = 6000;

function cap(text: string): string {
  return text.length > DETAIL_CAP ? text.slice(0, DETAIL_CAP) + '\n…(truncated)' : text;
}

/**
 * Run one read request against Google. Best-effort: failures become
 * ok:false results, never throws, so a flaky API cannot take the mission down.
 */
export async function executeGoogleRead(
  input: {
    db: Db;
    masterKey: string;
    clientId: string;
    clientSecret: string;
    request: GoogleReadRequest;
    fetchImpl?: typeof fetch;
  },
): Promise<GoogleReadResult> {
  const { db, masterKey, clientId, clientSecret, request } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const fail = (summary: string, detail: string): GoogleReadResult => ({ request, ok: false, summary, detail });
  const token = await getValidAccessToken(db, masterKey, clientId, clientSecret, fetchImpl).catch(
    () => null,
  );
  if (!token) {
    return fail('Google account not connected', 'Connect Gmail/Calendar in Settings first.');
  }
  try {
    if (request.kind === 'gmail-search') {
      const messages = await searchGmail(token, request.query, request.max, fetchImpl);
      const summary = `${messages.length} message(s) for "${request.query}"`;
      const detail =
        messages.length === 0
          ? 'No messages matched.'
          : messages
              .map((m) => `[${m.id}] ${m.from} — ${m.subject}${m.date ? ` (${m.date})` : ''}`)
              .join('\n');
      return { request, ok: true, summary, detail: cap(detail) };
    }
    if (request.kind === 'gmail-read') {
      const message = await readGmailMessage(token, request.id, fetchImpl);
      const summary = `read: ${message.subject}`;
      const detail = `From: ${message.from}\nSubject: ${message.subject}\nDate: ${message.date}\n\n${message.bodyText || message.snippet}`;
      return { request, ok: true, summary, detail: cap(detail) };
    }
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + request.days * 86_400_000).toISOString();
    const events = await listCalendarEvents(token, timeMin, timeMax, 10, fetchImpl);
    const summary = `${events.length} event(s) in the next ${request.days} day(s)`;
    const detail =
      events.length === 0
        ? 'No events in that window.'
        : events
            .map(
              (e) =>
                `${e.summary} — ${e.start}${e.end ? ` → ${e.end}` : ''}${e.location ? ` @ ${e.location}` : ''}`,
            )
            .join('\n');
    return { request, ok: true, summary, detail: cap(detail) };
  } catch (err) {
    return fail('Google read failed', (err as Error).message);
  }
}
