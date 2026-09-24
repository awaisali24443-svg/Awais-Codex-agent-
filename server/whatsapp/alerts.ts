/**
 * Breakage alerts: a WhatsApp message the moment something important breaks.
 *
 * Three incidents, all detected from signals that already exist:
 *
 *   - `poller_down` — the WhatsApp poller should be running (a token exists,
 *     POLLER_ENABLED is not 'off') but is not, or its health has sat in
 *     'error' without a successful poll for 5+ minutes. The loop already
 *     backs off and retries forever, so "error" alone is a transient blip —
 *     the stale-poll test is what makes it real breakage.
 *   - `engine_auth` — a run finished in the last hour with error_type
 *     'auth_failed', the code the engine layer returns for a 401/403 on the
 *     engine API key.
 *   - `budget_spent` — the day's task counter (budgets, the shared atomic
 *     gate from the durable-missions work) has hit the daily cap.
 *
 * The anti-spam rules, all in this file:
 *
 *   - Silent without a token. No `whatsapp_token` means no alerts, no error,
 *     no log line worth waking up for.
 *   - One alert per incident per day. The (alert_type, alert_day) row is
 *     claimed in `breakage_alert_log` *before* sending; a restart, a
 *     redeploy, or a slow send can never double it, and a failed send does
 *     not turn into a 60-second retry loop.
 *   - One WhatsApp message even for several incidents at once — the incidents
 *     are composed into a single text.
 *   - Never throws. The alert is decoration — a failure must not touch
 *     anything else in the process.
 *   - Never a run. This is a direct send, like the done ping and the morning
 *     digest — it costs zero of the daily task budget.
 *
 * The recipient is the same learned creator id the done ping uses
 * (`whatsapp_to` override or the id learned from inbound traffic).
 */
import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { SecretsStore } from '../settings.js';
import type { PollerHealth } from './poller.js';
import { WhatsAppClient } from './api.js';
import { WhatsAppSender } from './sender.js';
import { resolveRecipient } from './doneping.js';
import { karachiDateString } from './morningdigest.js';
import { peekDayTotal } from '../budget.js';

export type AlertType = 'poller_down' | 'engine_auth' | 'budget_spent';

export interface AlertIncident {
  type: AlertType;
  detail: string;
}

export interface AlertDeps {
  db: Db;
  config: Pick<AppConfig, 'breakageAlertsEnabled' | 'dailyRunBudget' | 'pollerMode'>;
  /** The secrets store; `whatsapp_token` and `whatsapp_to` are read. */
  secrets: Pick<SecretsStore, 'get'>;
  /** The in-process WhatsApp connection. Structural so tests can fake it. */
  whatsapp: { running: boolean; health(): PollerHealth };
  /** Test seam: replaces the HTTP layer. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Test seam: the "now" the alert reasons about. */
  now?: () => Date;
}

/**
 * How long the poller may go without a successful poll while in 'error'
 * before it counts as down. The loop backs off up to 5 minutes on auth
 * failures, so anything shorter would alert on a single bad-key attempt.
 */
export const POLLER_STALE_MS = 5 * 60_000;
/**
 * How far back the engine-auth signal reaches. A rejected key fails every
 * run, so an hour is plenty to notice without crying over yesterday's key
 * the owner already replaced.
 */
export const AUTH_FAILURE_WINDOW_MS = 60 * 60_000;

function nowOf(deps: AlertDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/**
 * The poller is down when polling *should* be happening but is not: the
 * loop is gone entirely, or its health has been 'error' with no successful
 * poll for longer than the backoff can explain. Disabled-on-purpose
 * (POLLER_ENABLED=off) or no token yet is not breakage — it is a choice.
 */
export async function detectPollerDown(deps: AlertDeps): Promise<AlertIncident | null> {
  const token = deps.secrets.get('whatsapp_token');
  const shouldPoll = deps.config.pollerMode !== 'off' && token.trim() !== '';
  if (!shouldPoll) return null;

  if (!deps.whatsapp.running) {
    return {
      type: 'poller_down',
      detail: 'the poller stopped unexpectedly — it should be running and is not',
    };
  }
  const health = deps.whatsapp.health();
  if (health.state !== 'error') return null;
  const lastPollMs = health.lastPollAt ? new Date(health.lastPollAt).getTime() : 0;
  if (nowOf(deps).getTime() - lastPollMs < POLLER_STALE_MS) return null; // a blip, not breakage
  return {
    type: 'poller_down',
    detail: `polling has been failing: ${health.lastError ?? 'unknown error'}`,
  };
}

/**
 * A run that finished in the last hour with the engine's auth-failure code.
 * 401/403 on the engine API key becomes error_type 'auth_failed' in the
 * engine layer, and the executor stores it on the run — that is the real
 * failure signal, not a guess.
 */
export async function detectEngineAuthFailure(deps: AlertDeps): Promise<AlertIncident | null> {
  const since = new Date(nowOf(deps).getTime() - AUTH_FAILURE_WINDOW_MS).toISOString();
  const rows = await deps.db.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE error_type = 'auth_failed'
        AND finished_at >= $1
      LIMIT 1`,
    [since],
  );
  if (rows.length === 0) return null;
  return {
    type: 'engine_auth',
    detail: 'the engine API key was rejected — runs are failing with auth errors',
  };
}

/**
 * The day's shared task counter has hit the cap. The budgets table is the
 * atomic gate every channel spends through, so the sum is the truth — no
 * need to wait for a refused run to find out.
 */
export async function detectBudgetSpent(deps: AlertDeps): Promise<AlertIncident | null> {
  const used = await peekDayTotal(deps.db);
  const limit = deps.config.dailyRunBudget;
  if (used < limit) return null;
  return {
    type: 'budget_spent',
    detail: `today's task budget is used up (${used}/${limit}) — new tasks wait until it resets at midnight UTC`,
  };
}

/**
 * The message itself. Plain text, no markdown tables — this is read on a
 * phone, at a moment when something is already wrong. Short enough to arrive
 * as one message.
 */
export function composeAlertMessage(incidents: AlertIncident[]): string {
  const lines = ['⚠️ WAIS needs you', ''];
  for (const incident of incidents) {
    if (incident.type === 'poller_down') {
      lines.push(
        `📵 WhatsApp poller down — ${incident.detail}. New WhatsApp messages aren't being read.`,
      );
    } else if (incident.type === 'engine_auth') {
      lines.push(
        `🔑 Engine API key rejected — ${incident.detail}. Check the key in Settings.`,
      );
    } else {
      lines.push(`🪙 Daily budget spent — ${incident.detail}.`);
    }
  }
  return lines.join('\n');
}

/**
 * Check every incident, claim each fresh one's day in the alert log, then
 * send one combined message. Claims happen first: a second tick, a restart,
 * or a slow send can never double the message, and a failed send does not
 * turn into a 60-second retry loop.
 *
 * Resolves the list of alert types actually sent. Never throws — an alert
 * failure must not affect anything else in the process.
 */
export async function maybeSendBreakageAlerts(deps: AlertDeps): Promise<AlertType[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const alertLog = (message: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
    log(`[alerts] ${message}`, level);
  };
  try {
    if (!deps.config.breakageAlertsEnabled) return [];

    const token = deps.secrets.get('whatsapp_token');
    if (!token) return [];

    const incidents: AlertIncident[] = [];
    const poller = await detectPollerDown(deps);
    if (poller) incidents.push(poller);
    const auth = await detectEngineAuthFailure(deps);
    if (auth) incidents.push(auth);
    const budget = await detectBudgetSpent(deps);
    if (budget) incidents.push(budget);
    if (incidents.length === 0) return [];

    const to = await resolveRecipient({ db: deps.db, secrets: deps.secrets }, alertLog);
    if (!to) return [];

    const dayKey = karachiDateString(nowOf(deps));
    const fresh: AlertIncident[] = [];
    for (const incident of incidents) {
      const claimed = await deps.db.query<{ alert_type: string }>(
        `INSERT INTO breakage_alert_log (alert_type, alert_day, detail)
         VALUES ($1, $2, $3)
         ON CONFLICT (alert_type, alert_day) DO NOTHING
         RETURNING alert_type`,
        [incident.type, dayKey, incident.detail],
      );
      if (claimed.length > 0) fresh.push(incident);
    }
    if (fresh.length === 0) return []; // already alerted for these today

    const client = new WhatsAppClient({
      token,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
    });
    const sender = new WhatsAppSender(client, alertLog);
    const ok = await sender.send(composeAlertMessage(fresh), { to });
    if (ok) {
      log(`[alerts] sent: ${fresh.map((i) => i.type).join(', ')}`, 'info');
      return fresh.map((i) => i.type);
    }
    log(`[alerts] send failed: ${sender.error ?? 'unknown'}`, 'warn');
    return [];
  } catch (err) {
    log(`[alerts] failed: ${(err as Error).message}`, 'warn');
    return [];
  }
}
