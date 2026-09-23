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

import type { PollerHealth } from '../whatsapp/poller.js';
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
import { checkAgent, checkGeminiKey } from '../verify.js';

export interface SettingsRouteDeps {
  settings: SettingsStore;
  secrets: SecretsStore;
  /** Live WhatsApp connection state, so the panel can say whether it is connected. */
  pollerHealth?: () => PollerHealth;
  /** Lets the owner of a credential react to it changing. Never throws. */
  onCredentialChanged?: (name: string) => Promise<void> | void;
  /** The configured Antigravity agent id, so the test hits the real target. */
  agent?: string;
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

export function createSettingsRoutes({
  settings,
  secrets,
  pollerHealth,
  onCredentialChanged,
  agent,
}: SettingsRouteDeps): Router {
  const router = Router();

  /**
   * Tell the owner of a credential that it changed. Deliberately not fatal: the
   * value is already stored, and a connection that fails to start reports its
   * own error through `pollerHealth` — failing the request would hide both.
   */
  /**
   * The connection, in one shape, for every response that reports it.
   *
   * A write and a read must agree: the first version returned the poller's raw
   * health after saving and a shaped block on the panel, so the same field meant
   * two things depending on which call you made.
   */
  const whatsappState = (): {
    mode: 'connected' | 'disconnected' | 'error' | 'unknown';
    state: string;
    detail: string | null;
    agentId: string | null;
    lastPollAt: string | null;
    lastError: string | null;
  } => {
    const poller = pollerHealth?.();
    if (!poller) {
      return { mode: 'unknown', state: 'disabled', detail: null, agentId: null, lastPollAt: null, lastError: null };
    }
    return {
      // 'connected' has to mean *polling*, not "a poller object exists" — the
      // first version said connected while the state beside it said disabled.
      mode:
        poller.state === 'running' ? 'connected' : poller.state === 'error' ? 'error' : 'disconnected',
      state: poller.state,
      detail: poller.detail ?? null,
      agentId: poller.agentId,
      lastPollAt: poller.lastPollAt,
      lastError: poller.lastError,
    };
  };

  const notify = async (name: string): Promise<void> => {
    if (!onCredentialChanged) return;
    try {
      await onCredentialChanged(name);
    } catch (err) {
      console.error(`[settings] reacting to ${name} failed:`, (err as Error).message);
    }
  };

  /** Everything the UI needs to render the panel, and nothing secret. */
  router.get(
    '/settings',
    handle(async (_req, res) => {
      res.json({
        settings: settings.list(),
        secrets: secrets.list(),
        /**
         * Whether the phone channel is actually connected. "Paste the API key"
         * is the whole setup, so the panel has to show the result of that — and
         * when it is not working, why.
         */
        whatsapp: whatsappState(),
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
        await notify(name);
        res.json({ ok: true, secret, whatsapp: whatsappState() });
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
      await notify(name);
      res.json({
        ok: true,
        removed,
        secret: secrets.describe(name),
        source,
        whatsapp: whatsappState(),
      });
    }),
  );

  /**
   * Test the *stored* Gemini key against the provider.
   *
   * The key is resolved here, at request time, from the secrets store (which
   * is store-first with the environment as fallback) — and it never enters
   * the response. What comes back is verify.ts's differential diagnosis only:
   * key rejected, agent id gone, quota, rate limit or network. The agent leg
   * runs a real mission through the real engine, so it costs one interaction;
   * it only runs when the key itself is accepted.
   */
  router.post(
    '/settings/verify/gemini-key',
    handle(async (_req, res) => {
      const key = secrets.get('gemini_api_key');
      const keyCheck = await checkGeminiKey({ apiKey: key });
      if (keyCheck.verdict !== 'ok') {
        res.json({ ok: false, key: keyCheck, agent: null });
        return;
      }
      const agentCheck = await checkAgent({
        apiKey: key,
        agent,
        timeoutMs: 90_000,
      });
      res.json({ ok: agentCheck.verdict === 'ok', key: keyCheck, agent: agentCheck });
    }),
  );

  return router;
}
