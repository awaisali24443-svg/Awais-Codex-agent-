/**
 * The "done" ping: a web-started run (PWA) can ask for one WhatsApp message
 * when it finishes, so the operator can put the phone down and still know the
 * moment a long mission lands.
 *
 * The anti-spam rules, all in this file:
 *
 *   - Opt-in per run. `runs.notify_whatsapp` is set at creation; there is no
 *     global "always ping" switch, so nothing the operator did not ask for
 *     ever makes a sound.
 *   - Web runs and scheduled tasks only. A WhatsApp-started run already gets
 *     its answer through the relay; pinging that too would double every reply.
 *   - Completed or failed only. A cancellation was the operator's own doing,
 *     in the app, seconds ago — pinging it would be noise.
 *   - Silent without a token. No WhatsApp key means no ping, no error, no
 *     log line worth waking up for.
 *
 * This does not need the poller: outbound sends go straight to the platform.
 * The ping needs an explicit `to` — the platform requires it on this route —
 * so the poller learns the agent creator's platform id (`user:<id>`) from
 * inbound traffic and the ping goes there and nowhere else. A manual
 * `whatsapp_to` secret can override it, but it must also be a `user:<id>`:
 * the platform rejects a phone number. With no learned id and no valid
 * override the ping is skipped silently, the same as without a token.
 *
 * It never throws. A ping failure must not touch the run that just finished.
 */
import type { Db } from '../db.js';
import type { SecretsStore } from '../settings.js';
import { finalTextOf } from './relay.js';
import { WhatsAppClient } from './api.js';
import { WhatsAppSender } from './sender.js';
import { loadCreatorId } from './store.js';
import { toWhatsAppText } from './format.js';
import type { Run, TerminalStatus } from '../runs.js';

export interface DonePingDeps {
  db: Db;
  /** The secrets store; `whatsapp_token` and `whatsapp_to` are read. */
  secrets: Pick<SecretsStore, 'get'>;
  /** Test seam: replaces the HTTP layer. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

type PingOutcome = 'completed' | 'failed';

/** How much of the final answer rides along in the ping. */
const SUMMARY_CHARS = 1200;

/**
 * Who the ping goes to. The platform only accepts the `user:<id>` it assigned
 * the agent's creator — learned from inbound traffic — so a phone number here
 * is rejected by the platform. A manual `whatsapp_to` override must therefore
 * also be a `user:<id>`; anything else is ignored with a warning and the
 * learned id is used instead.
 */
export async function resolveRecipient(
  deps: DonePingDeps,
  log: (message: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<string | null> {
  const override = deps.secrets.get('whatsapp_to').trim();
  if (override) {
    if (override.startsWith('user:')) return override;
    log(
      `[doneping] ignoring whatsapp_to override — the platform needs the user:<id> learned from your WhatsApp messages, not a phone number`,
      'warn',
    );
  }
  const learned = await loadCreatorId(deps.db).catch(() => null);
  return learned;
}

function titleOf(run: Run): string {
  const title = run.prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
  return title || 'Untitled task';
}

/**
 * Compose the ping body, pure and testable.
 *
 * The header names the mission; the body is the answer, converted the same way
 * every other outbound WhatsApp text is (`format.ts`), so Markdown never
 * leaks onto the phone.
 */
export function composeDonePing(
  run: Pick<Run, 'prompt'>,
  outcome: PingOutcome,
  text: string,
  errorMessage: string | null,
): string {
  const title = titleOf(run as Run);
  const body = toWhatsAppText(text).trim().slice(0, SUMMARY_CHARS);

  if (outcome === 'completed') {
    return body
      ? `✅ Done — ${title}\n\n${body}`
      : `✅ Done — ${title}\n\nThe agent finished without a written answer.`;
  }
  const reason = errorMessage ? `: ${errorMessage}` : '';
  return body
    ? `❌ Failed${reason} — ${title}\n\nPartial answer:\n\n${body}`
    : `❌ Failed${reason} — ${title}`;
}

/**
 * Send the ping if every condition holds. Resolves true only when a message
 * was actually accepted by the platform.
 */
export async function sendDonePing(
  deps: DonePingDeps,
  run: Run,
  outcome: TerminalStatus,
): Promise<boolean> {
  const log = deps.log ?? ((m: string) => console.log(m));

  // The opt-in checks, cheapest first. 'chat' covers web runs; 'api' covers
  // scheduled tasks the operator explicitly marked "deliver to WhatsApp" —
  // the same shape of opt-in, so the same ping. WhatsApp-started runs are
  // still excluded: they already get their answer through the relay.
  if (run.kind !== 'chat' && run.kind !== 'api') return false;
  if (!run.notifyWhatsapp) return false;
  if (outcome !== 'completed' && outcome !== 'failed') return false;

  const token = deps.secrets.get('whatsapp_token');
  if (!token) return false;
  const to = await resolveRecipient(deps, log);
  if (!to) return false;

  try {
    const client = new WhatsAppClient({
      token,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
    });
    const sender = new WhatsAppSender(client, (message, level) =>
      level === 'error' ? console.error(`[doneping] ${message}`) : console.log(`[doneping] ${message}`),
    );

    const text = await finalTextOf(deps.db, run.id);
    const message = composeDonePing(run, outcome, text, run.errorMessage);
    const ok = await sender.send(message, { to });
    if (ok) log(`[doneping] ping sent for ${run.id} (${outcome})`);
    else log(`[doneping] ping failed for ${run.id}: ${sender.error ?? 'unknown'}`, 'warn');
    return ok;
  } catch (err) {
    // The run is already finished and recorded; a ping is decoration.
    log(`[doneping] ping failed for ${run.id}: ${(err as Error).message}`, 'warn');
    return false;
  }
}
