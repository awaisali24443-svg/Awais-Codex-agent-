/**
 * Single-operator access control.
 *
 * There is no login screen and no password prompt. You open one link that
 * carries a key - `https://app/?k=...` - and the server hands back a long-lived
 * signed cookie and strips the key out of the address bar. Every visit after
 * that is a plain URL with no typing at all.
 *
 * Why a key at all, given this is for one person: the service is on the public
 * internet and one mission spends one of ~100 daily runs. An open endpoint is
 * not a privacy problem, it is a "someone else used up my day" problem. The key
 * costs nothing after the first visit.
 *
 * `AUTH_MODE=open` disables the check completely if that trade is ever wanted.
 * It logs a warning at boot and says so in /api/status, so it can never be on
 * by accident and forgotten.
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from './config.js';

const COOKIE_NAME = 'ac_session';

/**
 * Set when this very request presented a correct access key.
 *
 * Without it, `?k=` only worked for a browser (which is redirected and comes
 * back carrying the cookie). A script asking with `?k=` and no cookie jar was
 * still rejected, which is precisely the case the key exists to serve.
 */
export interface KeyClaimedRequest extends Request {
  accessKeyClaimed?: boolean;
}
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365; // a year: bookmark once, never think again

/** Routes reachable without a session. Everything else under /api is denied. */
export const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/readyz' },
  // The sign-in screen posts here. It is public for the obvious reason that it
  // is how you get a session in the first place.
  { method: 'POST', path: '/api/auth/login' },
];

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(value: string, secret: string): string {
  return base64url(crypto.createHmac('sha256', secret).update(value).digest());
}

/** Issue a session cookie value: `<payload>.<hmac>`. */
export function createSession(secret: string, now = Date.now()): string {
  const payload = base64url(JSON.stringify({ exp: now + SESSION_TTL_MS }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(payload, secret);

  // Timing-safe compare requires equal lengths.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number;
    };
    return typeof parsed.exp === 'number' && parsed.exp > now;
  } catch {
    return false;
  }
}

/** Minimal cookie header parser — avoids the cookie-parser dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isPublicRoute(method: string, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return PUBLIC_ROUTES.some(
    (r) => r.method === method.toUpperCase() && r.path === normalized,
  );
}

/**
 * Turn `?k=<access key>` into a session.
 *
 * Runs on every request, before the guard. A browser navigation is redirected
 * to the same URL without the key, so the secret does not sit in the address
 * bar, in history, or in a screenshot. Anything else (curl, fetch) is left
 * alone and simply carries on with the cookie now set.
 */
export function claimAccessKey(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (config.authMode === 'open') return next();

    const raw = req.query?.k;
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== 'string' || provided === '') return next();

    if (!checkAccessKey(provided, config.accessKey)) {
      console.warn('[auth] a request presented the wrong access key');
      res.status(401).json({
        error: 'invalid_key',
        message: 'That access key is not right. Use the link you saved, or set AUTH_MODE=open.',
      });
      return;
    }

    res.setHeader('Set-Cookie', sessionCookie(createSession(config.sessionSecret), config.isProduction));
    (req as KeyClaimedRequest).accessKeyClaimed = true;

    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    if (req.method === 'GET' && wantsHtml) {
      const withoutKey = (req.originalUrl || '/').replace(/([?&])k=[^&]*&?/, '$1').replace(/[?&]$/, '');
      res.redirect(302, withoutKey || '/');
      return;
    }
    next();
  };
}

/**
 * Deny by default. Anything under /api that is not explicitly public needs a
 * valid session cookie, an `x-access-key` header, or a bearer token equal to
 * the session secret.
 */
export function requireSession(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // No check at all in open mode. The boot log and /api/status both say so.
    if (config.authMode === 'open') return next();

    // IMPORTANT: inside a middleware mounted with `app.use('/api', ...)`,
    // `req.path` is relative to the mount point ("/status", not "/api/status").
    // Using it here silently disables the entire check — which is exactly how
    // v1's auth ended up decorative. Always resolve the full path.
    const fullPath = (req.originalUrl || req.url).split('?')[0];

    if (isPublicRoute(req.method, fullPath)) return next();
    if (!fullPath.startsWith('/api')) return next();

    if ((req as KeyClaimedRequest).accessKeyClaimed) return next();

    const cookie = readCookie(req, COOKIE_NAME);
    if (verifySession(cookie, config.sessionSecret)) return next();

    const headerKey = req.headers['x-access-key'];
    if (typeof headerKey === 'string' && checkAccessKey(headerKey, config.accessKey)) return next();

    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) {
      if (checkAccessKey(header.slice(7).trim(), config.sessionSecret)) return next();
    }

    res.status(401).json({
      error: 'unauthorized',
      message: 'Open your saved link (it carries ?k=...) once, and this browser stays signed in for a year.',
    });
  };
}

/** Constant-time comparison, for access keys and bearer tokens alike. */
export function checkAccessKey(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
