/**
 * LinkedIn "post as me" — pure API helpers. No express, no database, no server.
 *
 * What LinkedIn's API actually allows (self-serve, free):
 * - post / edit / delete text posts as the authenticated member (w_member_social)
 * - comment and like as the member
 * - read the member's own name/photo via Sign In (openid profile)
 *
 * What it does NOT allow: editing the profile itself (headline, experience,
 * about). LinkedIn closed profile-write years ago — no agent, ours or Manus's,
 * can do that part through the API.
 *
 * Member access tokens last ~60 days and cannot be refreshed programmatically;
 * when one expires the member reconnects. The storage layer (below) tracks
 * expiry so callers can tell "reconnect" apart from "broken".
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { openSecret, sealSecret } from './crypto.js';

export const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_API = 'https://api.linkedin.com';
/** What the REST API currently expects on every call. */
export const LINKEDIN_VERSION = '202605';
/** One LinkedIn call must never hang a request. */
export const LINKEDIN_CALL_TIMEOUT_MS = 15_000;
/** The two self-serve products: Sign In + Share on LinkedIn. */
export const LINKEDIN_SCOPES = 'openid profile w_member_social';
/** The fenced block the agent ends a post-draft answer with. Never auto-published. */
export const LINKEDIN_DRAFT_FENCE = 'linkedin-post';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(LINKEDIN_CALL_TIMEOUT_MS);
}

/** The URL the operator opens to grant access. `state` must be validated back. */
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: LINKEDIN_SCOPES,
    state,
  });
  return `${LINKEDIN_AUTH_URL}?${params.toString()}`;
}

export interface TokenResult {
  accessToken: string;
  /** Seconds LinkedIn says the token lives (about 60 days). */
  expiresIn: number;
}

export async function exchangeCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
  const res = await fetchImpl(LINKEDIN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: timeoutSignal(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('LinkedIn token exchange returned no access token');
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 5184000 };
}

export interface MemberInfo {
  urn: string;
  name: string;
}

/** Who the token belongs to, via OpenID userinfo. */
export async function fetchMemberInfo(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MemberInfo> {
  const res = await fetchImpl(`${LINKEDIN_API}/v2/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
    },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`LinkedIn userinfo failed (${res.status})`);
  const json = (await res.json()) as { sub?: string; name?: string };
  if (!json.sub) throw new Error('LinkedIn userinfo returned no member id');
  return { urn: `urn:li:person:${json.sub}`, name: json.name ?? '' };
}

/**
 * Publish a plain-text post as the member. Returns the post URN (from the
 * `x-restli-id` header — without r_member_social this is the only chance to
 * learn it, so callers must keep it).
 */
export async function publishTextPost(
  accessToken: string,
  authorUrn: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('post text must not be empty');
  if (trimmed.length > 3000) throw new Error('post text is over LinkedIn\u2019s 3000-character limit');
  const res = await fetchImpl(`${LINKEDIN_API}/rest/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      author: authorUrn,
      commentary: trimmed,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
    signal: timeoutSignal(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LinkedIn publish failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const urn = res.headers.get('x-restli-id');
  if (!urn) throw new Error('LinkedIn publish succeeded but returned no post URN');
  return urn;
}

/**
 * The agent ends a "post this on LinkedIn" answer with a fenced block; this
 * pulls the exact draft text out. Null when the answer has no draft — the
 * common case, and the reason this never publishes on its own.
 */
export function extractLinkedInDraft(text: string): string | null {
  const match = /```linkedin-post\s*\n([\s\S]*?)```/.exec(text);
  if (!match) return null;
  const draft = match[1].trim();
  return draft ? draft : null;
}

// ---------------------------------------------------------------------------
// storage: one token row, many drafts
// ---------------------------------------------------------------------------

export interface StoredLinkedInToken {
  accessToken: string;
  memberUrn: string;
  memberName: string;
  expiresAt: Date;
}

const TOKEN_AAD_NAME = 'linkedin_access_token';

export async function saveLinkedInToken(
  db: Db,
  masterKey: string,
  input: { accessToken: string; expiresIn: number; memberUrn: string; memberName: string },
): Promise<void> {
  const sealed = sealSecret(masterKey, TOKEN_AAD_NAME, input.accessToken);
  const expiresAt = new Date(Date.now() + input.expiresIn * 1000);
  await db.query(
    `INSERT INTO linkedin_tokens (id, ciphertext, iv, tag, member_urn, member_name, expires_at, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
       member_urn = EXCLUDED.member_urn, member_name = EXCLUDED.member_name,
       expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [sealed.ciphertext, sealed.iv, sealed.tag, input.memberUrn, input.memberName, expiresAt.toISOString()],
  );
}

export async function loadLinkedInToken(db: Db, masterKey: string): Promise<StoredLinkedInToken | null> {
  const rows = await db.query<{
    ciphertext: string;
    iv: string;
    tag: string;
    member_urn: string;
    member_name: string;
    expires_at: Date | string;
  }>(`SELECT ciphertext, iv, tag, member_urn, member_name, expires_at
      FROM linkedin_tokens WHERE id = 'default'`);
  const row = rows[0];
  if (!row) return null;
  const accessToken = openSecret(masterKey, TOKEN_AAD_NAME, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    tag: row.tag,
  });
  return {
    accessToken,
    memberUrn: row.member_urn,
    memberName: row.member_name,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

export async function clearLinkedInToken(db: Db): Promise<void> {
  await db.query(`DELETE FROM linkedin_tokens WHERE id = 'default'`);
}

export interface LinkedInDraft {
  id: string;
  runId: string;
  text: string;
  status: 'pending' | 'published' | 'failed';
  postUrn: string | null;
}

/**
 * Best-effort: pull a ```linkedin-post block out of a finished answer and
 * file it as a pending draft. Publishing always needs the operator's tap.
 * Returns the draft id, or null when the answer had no draft.
 */
export async function recordLinkedInDraft(db: Db, runId: string, finalText: string): Promise<string | null> {
  const text = extractLinkedInDraft(finalText);
  if (!text) return null;
  const id = newId('lid');
  await db.query(
    `INSERT INTO linkedin_drafts (id, run_id, text) VALUES ($1, $2, $3)`,
    [id, runId, text],
  );
  return id;
}

export async function listPendingDrafts(db: Db, conversationId: string): Promise<LinkedInDraft[]> {
  const rows = await db.query<{
    id: string;
    run_id: string;
    text: string;
    status: string;
    post_urn: string | null;
  }>(
    `SELECT d.id, d.run_id, d.text, d.status, d.post_urn
       FROM linkedin_drafts d
       JOIN runs r ON r.id = d.run_id
      WHERE r.conversation_id = $1 AND d.status = 'pending'
      ORDER BY d.created_at ASC`,
    [conversationId],
  );
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    text: r.text,
    status: r.status as LinkedInDraft['status'],
    postUrn: r.post_urn,
  }));
}

export async function markDraftPublished(db: Db, draftId: string, postUrn: string): Promise<void> {
  await db.query(`UPDATE linkedin_drafts SET status = 'published', post_urn = $2 WHERE id = $1`, [
    draftId,
    postUrn,
  ]);
}

export async function markDraftFailed(db: Db, draftId: string, error: string): Promise<void> {
  await db.query(`UPDATE linkedin_drafts SET status = 'failed', error = $2 WHERE id = $1`, [
    draftId,
    error.slice(0, 500),
  ]);
}

export type PublishDraftResult =
  | { status: 'published'; urn: string }
  | { status: 'already' }
  | { status: 'not_found' }
  | { status: 'not_connected' | 'token_expired' | 'failed'; message: string };

/**
 * Publish a pending draft — the shared core behind the web Publish button
 * and the WhatsApp "yes" reply. Only a 'pending' draft can move: a second
 * call (a replayed message, a double-tap) lands on 'already' instead of
 * posting twice. A failed publish marks the draft failed, exactly as the
 * web route always did.
 */
export async function publishLinkedInDraft(
  db: Db,
  masterKey: string,
  draftId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishDraftResult> {
  const rows = await db.query<{ id: string; text: string; status: string }>(
    `SELECT id, text, status FROM linkedin_drafts WHERE id = $1`,
    [draftId],
  );
  const draft = rows[0];
  if (!draft) return { status: 'not_found' };
  if (draft.status !== 'pending') return { status: 'already' };

  let token = null;
  try {
    token = await loadLinkedInToken(db, masterKey);
  } catch {
    token = null;
  }
  if (!token) {
    return { status: 'not_connected', message: 'Connect LinkedIn in Settings first.' };
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    return {
      status: 'token_expired',
      message: 'The LinkedIn connection expired (tokens last ~60 days). Reconnect in Settings.',
    };
  }
  try {
    const urn = await publishTextPost(token.accessToken, token.memberUrn, draft.text, fetchImpl);
    await markDraftPublished(db, draft.id, urn);
    return { status: 'published', urn };
  } catch (err) {
    const message = (err as Error).message;
    await markDraftFailed(db, draft.id, message);
    return { status: 'failed', message };
  }
}
