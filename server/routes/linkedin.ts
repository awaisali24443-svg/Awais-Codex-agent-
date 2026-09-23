/**
 * LinkedIn routes: connect (OAuth), status, drafts, publish, disconnect.
 *
 * The OAuth callback is a browser GET behind the session, so the operator who
 * clicked Connect is the one completing it. The access token is sealed with
 * MASTER_KEY before it touches the database (see linkedin.ts) and is never
 * returned by any endpoint — status only says whether one exists, whose it is,
 * and when it expires.
 */
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { SecretsStore } from '../settings.js';
import {
  buildAuthorizeUrl,
  clearLinkedInToken,
  exchangeCode,
  fetchMemberInfo,
  listPendingDrafts,
  loadLinkedInToken,
  markDraftFailed,
  markDraftPublished,
  publishTextPost,
  saveLinkedInToken,
} from '../linkedin.js';

export interface LinkedInRouteDeps {
  db: Db;
  secrets: SecretsStore;
  config: AppConfig;
}

/** One-time OAuth states: 10 minutes, then the operator starts over. */
const oauthStates = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 10 * 60_000;

function issueState(): string {
  const state = randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  return state;
}

function consumeState(state: string): boolean {
  const expiry = oauthStates.get(state);
  oauthStates.delete(state);
  return expiry !== undefined && expiry > Date.now();
}

function redirectUri(config: AppConfig): string {
  const base = (config.appUrl || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  return `${base}/api/linkedin/callback`;
}

export function createLinkedInRoutes(deps: LinkedInRouteDeps): Router {
  const { db, secrets, config } = deps;
  const router = Router();

  const clientId = () => secrets.get('linkedin_client_id');
  const clientSecret = () => secrets.get('linkedin_client_secret');

  router.get('/linkedin/status', async (_req: Request, res: Response) => {
    const configured = Boolean(clientId() && clientSecret());
    let token = null;
    try {
      token = await loadLinkedInToken(db, config.masterKey);
    } catch {
      token = null;
    }
    res.json({
      clientConfigured: configured,
      connected: Boolean(token),
      memberName: token?.memberName ?? null,
      expiresAt: token ? token.expiresAt.toISOString() : null,
      expired: token ? token.expiresAt.getTime() <= Date.now() : false,
      callbackUrl: redirectUri(config),
    });
  });

  router.get('/linkedin/authorize', async (_req: Request, res: Response) => {
    if (!clientId() || !clientSecret()) {
      res.status(400).json({
        error: 'not_configured',
        message: 'Add your LinkedIn Client ID and Client Secret in Settings first.',
      });
      return;
    }
    const state = issueState();
    res.json({ url: buildAuthorizeUrl(clientId(), redirectUri(config), state) });
  });

  // LinkedIn redirects here after the operator grants access.
  router.get('/linkedin/callback', async (req: Request, res: Response) => {
    const done = (ok: boolean) => res.redirect(`/?linkedin=${ok ? 'connected' : 'error'}`);
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (error || !code || !consumeState(state)) {
      done(false);
      return;
    }
    try {
      const { accessToken, expiresIn } = await exchangeCode({
        clientId: clientId(),
        clientSecret: clientSecret(),
        code,
        redirectUri: redirectUri(config),
      });
      const member = await fetchMemberInfo(accessToken);
      await saveLinkedInToken(db, config.masterKey, {
        accessToken,
        expiresIn,
        memberUrn: member.urn,
        memberName: member.name,
      });
      console.log(`[linkedin] connected as ${member.name || member.urn}`);
      done(true);
    } catch (err) {
      console.warn('[linkedin] oauth callback failed:', (err as Error).message);
      done(false);
    }
  });

  router.get('/linkedin/drafts', async (req: Request, res: Response) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
    if (!conversationId) {
      res.status(400).json({ error: 'conversation_required' });
      return;
    }
    res.json({ drafts: await listPendingDrafts(db, conversationId) });
  });

  router.post('/linkedin/drafts/:id/publish', async (req: Request, res: Response) => {
    const rows = await db.query<{ id: string; text: string; status: string }>(
      `SELECT id, text, status FROM linkedin_drafts WHERE id = $1`,
      [req.params.id],
    );
    const draft = rows[0];
    if (!draft) {
      res.status(404).json({ error: 'draft_not_found' });
      return;
    }
    if (draft.status !== 'pending') {
      res.status(400).json({ error: 'draft_not_pending', message: 'This draft was already published.' });
      return;
    }
    let token = null;
    try {
      token = await loadLinkedInToken(db, config.masterKey);
    } catch {
      token = null;
    }
    if (!token) {
      res.status(400).json({ error: 'not_connected', message: 'Connect LinkedIn in Settings first.' });
      return;
    }
    if (token.expiresAt.getTime() <= Date.now()) {
      res.status(400).json({
        error: 'token_expired',
        message: 'The LinkedIn connection expired (tokens last ~60 days). Reconnect in Settings.',
      });
      return;
    }
    try {
      const urn = await publishTextPost(token.accessToken, token.memberUrn, draft.text);
      await markDraftPublished(db, draft.id, urn);
      console.log(`[linkedin] published draft ${draft.id} as ${urn}`);
      res.json({ urn });
    } catch (err) {
      const message = (err as Error).message;
      await markDraftFailed(db, draft.id, message);
      res.status(502).json({ error: 'publish_failed', message });
    }
  });

  router.post('/linkedin/disconnect', async (_req: Request, res: Response) => {
    await clearLinkedInToken(db);
    console.log('[linkedin] disconnected');
    res.json({ ok: true });
  });

  return router;
}
