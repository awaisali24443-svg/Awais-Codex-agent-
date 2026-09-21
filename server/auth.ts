/**
 * Single-operator session auth.
 *
 * No dependency: an HMAC-signed cookie carrying an expiry, verified with a
 * timing-safe comparison. Deny-by-default middleware; the public allow-list is
 * declared in one place (`PUBLIC_ROUTES`) so it can be read at a glance.
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from './config.js';

const COOKIE_NAME = 'ac_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/** Routes reachable without a session. Everything else under /api is denied. */
export const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/healthz' },
  { method: 'GET', path: '/readyz' },
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
 * Deny by default. Anything under /api that is not explicitly public needs a
 * valid session cookie or a bearer token equal to the session secret.
 */
export function requireSession(config: AppConfig) {
  const bearerToken = config.sessionSecret;

  return (req: Request, res: Response, next: NextFunction): void => {
    // IMPORTANT: inside a middleware mounted with `app.use('/api', ...)`,
    // `req.path` is relative to the mount point ("/status", not "/api/status").
    // Using it here silently disables the entire check — which is exactly how
    // v1's auth ended up decorative. Always resolve the full path.
    const fullPath = (req.originalUrl || req.url).split('?')[0];

    if (isPublicRoute(req.method, fullPath)) return next();
    if (!fullPath.startsWith('/api')) return next();

    const cookie = readCookie(req, COOKIE_NAME);
    if (verifySession(cookie, config.sessionSecret)) return next();

    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) {
      const provided = Buffer.from(header.slice(7).trim());
      const expected = Buffer.from(bearerToken);
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        return next();
      }
    }

    res.status(401).json({
      error: 'unauthorized',
      message: 'Sign in first: POST /api/auth/login',
    });
  };
}

/** Constant-time password check for the login route. */
export function checkPassword(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
