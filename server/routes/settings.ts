/**
 * Settings routes — the operator's control panel, in JSON.
 *
 * Three rules shape this surface:
 *
 *   1. **A secret is write-only.** `PUT` stores it, `DELETE` forgets it, and no
 *      response body ever contains the value. The read-side returns a short
 *      fingerprint and where the value came from (encrypted store vs
 *      environment), which is what "did my key take?" actually needs.
 *   2. **Errors are explained.** Every failure carries a machine-readable
 *      `error` plus a sentence a human can act on, because the caller here is
 *      often a phone at 1am, not a test suite.
 *   3. **Express 4 does not catch async throws** — it predates promise-aware
 *      routing, so an unhandled rejection inside a handler would leave the
 *      request hanging until it times out. Every handler is wrapped.
 *
 * Mounted behind `requireSession` in app.ts, like the rest of `/api`.
 */
import { Router, type Request, type Response } from 'express';

import {
  SECRET_NAMES,
  SETTINGS,
  SettingValueError,
  SecretsUnavailableError,
  SecretValueError,
  isSecretName,
  isSettingKey,
  type SecretsStore,
  type SettingsStore,
} from '../settings.js';

export interface SettingsRouteDeps {
  settings: SettingsStore;
  secrets: SecretsStore;
}

/** Wrap an async handler so a rejection becomes a 500 instead of a hung socket. */
function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: Error) => {
      console.error('[settings] request failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'settings_failed', message: err.message });
      }
    });
  };
}

export function createSettingsRoutes({ settings, secrets }: SettingsRouteDeps): Router {
  const router = Router();

  /** Everything the UI needs to render the panel, and nothing secret. */
  router.get(
    '/settings',
    handle(async (_req, res) => {
      res.json({
        settings: settings.list(),
        secrets: secrets.list(),
        // So the UI can explain *why* saving a key is refused instead of
        // showing a disabled button with no reason.
        encryption: {
          available: secrets.encryptionAvailable,
          envVar: 'MASTER_KEY',
          hint: secrets.encryptionAvailable
            ? null
            : 'Set MASTER_KEY in the environment (64 hex characters) to store secrets. ' +
              'Until then, credentials must come from environment variables.',
        },
      });
    }),
  );

  // ---- settings -----------------------------------------------------------

  router.put(
    '/settings/:key',
    handle(async (req, res) => {
      const key = req.params.key;
      if (!isSettingKey(key)) {
        res.status(404).json({
          error: 'unknown_setting',
          message: `"${key}" is not a setting. Valid keys: ${Object.keys(SETTINGS).join(', ')}`,
        });
        return;
      }

      const raw = (req.body as { value?: unknown } | undefined)?.value;
      if (raw === undefined) {
        res.status(400).json({ error: 'value_required', message: 'body must be {"value": ...}' });
        return;
      }

      try {
        const value = await settings.set(key, raw);
        res.json({ ok: true, key, value, source: settings.source(key) });
      } catch (err) {
        if (err instanceof SettingValueError) {
          res.status(400).json({ error: 'invalid_value', message: `${key} ${err.message}` });
          return;
        }
        throw err;
      }
    }),
  );

  /** Drop the override — the environment default applies again at once. */
  router.delete(
    '/settings/:key',
    handle(async (req, res) => {
      const key = req.params.key;
      if (!isSettingKey(key)) {
        res.status(404).json({
          error: 'unknown_setting',
          message: `"${key}" is not a setting. Valid keys: ${Object.keys(SETTINGS).join(', ')}`,
        });
        return;
      }
      const value = await settings.clear(key);
      res.json({ ok: true, key, value, source: settings.source(key) });
    }),
  );

  // ---- secrets ------------------------------------------------------------

  router.get(
    '/settings/secrets',
    handle(async (_req, res) => {
      res.json({ secrets: secrets.list(), encryption: { available: secrets.encryptionAvailable } });
    }),
  );

  router.put(
    '/settings/secrets/:name',
    handle(async (req, res) => {
      const name = req.params.name;
      if (!isSecretName(name)) {
        res.status(404).json({
          error: 'unknown_secret',
          message: `"${name}" is not a stored credential. Valid names: ${SECRET_NAMES.join(', ')}`,
        });
        return;
      }

      const raw = (req.body as { value?: unknown } | undefined)?.value;
      if (typeof raw !== 'string') {
        res.status(400).json({
          error: 'value_required',
          message: `body must be {"value": "<the credential>"} — ${name} is a string`,
        });
        return;
      }

      try {
        // The response is the metadata, never the value that was just stored.
        const secret = await secrets.set(name, raw);
        res.json({ ok: true, secret });
      } catch (err) {
        if (err instanceof SecretsUnavailableError) {
          res.status(503).json({ error: 'encryption_unavailable', message: err.message });
          return;
        }
        if (err instanceof SecretValueError) {
          res.status(400).json({ error: 'invalid_value', message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  router.delete(
    '/settings/secrets/:name',
    handle(async (req, res) => {
      const name = req.params.name;
      if (!isSecretName(name)) {
        res.status(404).json({
          error: 'unknown_secret',
          message: `"${name}" is not a stored credential. Valid names: ${SECRET_NAMES.join(', ')}`,
        });
        return;
      }

      const { removed, source } = await secrets.remove(name);
      res.json({ ok: true, removed, secret: secrets.describe(name), source });
    }),
  );

  return router;
}
