/**
 * Google routes: connect (OAuth), status, disconnect.
 *
 * Same shape as the LinkedIn routes: the callback is a browser GET behind the
 * session, so the operator who clicked Connect is the one completing it. The
 * tokens are sealed with MASTER_KEY before they touch the database (see
 * google.ts) and are never returned by any endpoint — status only says whether
 * a connection exists and whose account it is. Google's refresh tokens keep
 * the connection alive indefinitely, so there is no expiry countdown here.
 */
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { SecretsStore } from '../settings.js';
import {
  buildGoogleAuthorizeUrl,
  clearGoogleToken,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  loadGoogleToken,
  saveGoogleToken,
} from '../google.js';

export interface GoogleRouteDeps {
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
  return `${base}/api/google/callback`;
}

export function createGoogleRoutes(deps: GoogleRouteDeps): Router {
  const { db, secrets, config } = deps;
  const router = Router();

  const clientId = () => secrets.get('google_client_id');
  const clientSecret = () => secrets.get('google_client_secret');

  router.get('/google/status', async (_req: Request, res: Response) => {
    const configured = Boolean(clientId() && clientSecret());
    let token = null;
    try {
      token = await loadGoogleToken(db, config.masterKey);
    } catch {
      token = null;
    }
    res.json({
      clientConfigured: configured,
      connected: Boolean(token),
      memberEmail: token?.email ?? null,
      memberName: token?.name ?? null,
      callbackUrl: redirectUri(config),
    });
  });

  router.get('/google/authorize', async (_req: Request, res: Response) => {
    if (!clientId() || !clientSecret()) {
      res.status(400).json({
        error: 'not_configured',
        message: 'Add your Google Client ID and Client Secret in Settings first.',
      });
      return;
    }
    const state = issueState();
    res.json({ url: buildGoogleAuthorizeUrl(clientId(), redirectUri(config), state) });
  });

  // Google redirects here after the operator grants access.
  router.get('/google/callback', async (req: Request, res: Response) => {
    const done = (ok: boolean) => res.redirect(`/?google=${ok ? 'connected' : 'error'}`);
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (error || !code || !consumeState(state)) {
      done(false);
      return;
    }
    try {
      const exchanged = await exchangeGoogleCode({
        clientId: clientId(),
        clientSecret: clientSecret(),
        code,
        redirectUri: redirectUri(config),
      });
      if (!exchanged.refreshToken) {
        // Without a refresh token the connection dies with the 1-hour access
        // token. prompt=consent should always produce one; if it did not,
        // fail loudly instead of storing a dead connection.
        throw new Error('Google did not return a refresh token — try connecting again.');
      }
      const user = await fetchGoogleUserInfo(exchanged.accessToken);
      await saveGoogleToken(db, config.masterKey, {
        refreshToken: exchanged.refreshToken,
        accessToken: exchanged.accessToken,
        expiresIn: exchanged.expiresIn,
        email: user.email,
        name: user.name,
      });
      console.log(`[google] connected as ${user.email}`);
      done(true);
    } catch (err) {
      console.warn('[google] oauth callback failed:', (err as Error).message);
      done(false);
    }
  });

  router.post('/google/disconnect', async (_req: Request, res: Response) => {
    await clearGoogleToken(db);
    console.log('[google] disconnected');
    res.json({ ok: true });
  });

  return router;
}
