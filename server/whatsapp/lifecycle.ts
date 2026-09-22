/**
 * The WhatsApp connection's lifetime, kept in step with its credential.
 *
 * Before this existed, the poller was built once during boot and only if a
 * token happened to be in the environment at that moment. Everything else was a
 * restart: storing the agent's API key in Settings did nothing until the next
 * deploy, and removing a compromised one kept the old poll alive. For a feature
 * whose entire setup is "paste the API key WhatsApp generated", that is a setup
 * step that exists only in our implementation.
 *
 * So the rule lives here instead:
 *
 *   poll  ⇔  POLLER_ENABLED is not 'off'  AND  a token exists somewhere
 *
 * `sync()` is called at boot, after every credential change, and can be called
 * again safely — it is the only place that starts or stops the loop, so there is
 * no second code path that can disagree about whether it is running.
 *
 * Two details worth knowing:
 *
 *  - **Stopping really stops.** The platform allows one poller per agent and
 *    answers a second one with 409. A stale loop is therefore not a harmless
 *    leak; it is a connection that the next process cannot take over.
 *  - **A failed start does not throw.** A wrong or expired key makes the first
 *    poll fail with an auth error, which the poller already reports through its
 *    own health (`state: 'error'`, `lastError`). Turning that into an exception
 *    would fail the request that saved the key and hide the useful message.
 */
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { EventBus } from '../events.js';
import type { RunExecutor } from '../executor.js';
import type { SecretsStore } from '../settings.js';
import type { AcceptInput, AcceptResult } from '../accept.js';
import { WhatsAppClient } from './api.js';
import { WhatsAppSender } from './sender.js';
import {
  DISABLED_HEALTH,
  WhatsAppPoller,
  type PollerHealth,
} from './poller.js';

export interface WhatsAppServiceDeps {
  db: Db;
  bus: EventBus;
  executor: RunExecutor;
  config: AppConfig;
  secrets: SecretsStore;
  /** The same acceptance path the web UI uses — one set of rules, two channels. */
  accept: (input: AcceptInput) => Promise<AcceptResult>;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Test seam: replaces the poller factory. */
  createPoller?: (deps: ConstructorParameters<typeof WhatsAppPoller>[0]) => WhatsAppPoller;
}

export type SyncOutcome = 'started' | 'stopped' | 'unchanged' | 'deferred';

export class WhatsAppService {
  private poller: WhatsAppPoller | null = null;
  private syncing: Promise<SyncOutcome> | null = null;
  private detail: string | null = null;

  constructor(private readonly deps: WhatsAppServiceDeps) {}

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(message, level);
  }

  /** The token currently in force: the encrypted store first, environment second. */
  private token(): string {
    return this.deps.secrets.get('whatsapp_token');
  }

  /**
   * Whether polling *should* be happening, and why not if it should not.
   * `config.pollerEnabled` is kept in step so the rest of the server (status
   * reports, logs) never disagrees with reality.
   */
  private shouldPoll(): { yes: boolean; detail: string | null } {
    const { config } = this.deps;
    if (config.pollerMode === 'off') {
      return { yes: false, detail: 'POLLER_ENABLED=false — another process owns the poller' };
    }
    if (!this.token()) {
      return {
        yes: false,
        detail: config.pollerMode === 'on'
          ? 'waiting for the agent API key — add it in Settings'
          : 'not connected — add the agent API key in Settings to connect',
      };
    }
    return { yes: true, detail: null };
  }

  get running(): boolean {
    return this.poller !== null;
  }

  get isPolling(): boolean {
    return this.poller?.isRunning ?? false;
  }

  /**
   * Health for `/readyz` and `/api/status`, including *why* nothing is running.
   * A bare `disabled` cannot distinguish "switched off on purpose" from
   * "someone deleted the key", which are different problems.
   */
  health(): PollerHealth {
    if (this.poller) return this.poller.health();
    return { ...DISABLED_HEALTH, detail: this.detail };
  }

  /**
   * Bring the loop in line with the current token and flag.
   *
   * Serialised: two credential changes in quick succession must not race into
   * two pollers, which the platform would answer with a 409.
   */
  async sync(reason: string): Promise<SyncOutcome> {
    const run = (): Promise<SyncOutcome> => this.applySync(reason);
    const previous = this.syncing;
    const next = previous ? previous.then(run, run) : run();
    this.syncing = next.catch(() => 'unchanged' as SyncOutcome);
    return next;
  }

  private async applySync(reason: string): Promise<SyncOutcome> {
    const { yes, detail } = this.shouldPoll();
    this.detail = detail;
    this.deps.config.pollerEnabled = yes;

    if (yes && !this.poller) return this.start(reason);
    if (!yes && this.poller) return this.stop(reason, detail);
    return 'unchanged';
  }

  private async start(reason: string): Promise<SyncOutcome> {
    const { db, bus, executor, config, secrets } = this.deps;

    const client = new WhatsAppClient({
      // Resolved per request: replacing the key takes effect on the next poll,
      // and a revoked one fails there rather than being cached for the process's
      // lifetime.
      token: () => secrets.get('whatsapp_token'),
      baseUrl: config.whatsappApiBase || undefined,
    });

    const deps = {
      db,
      bus,
      client,
      executor,
      config,
      sender: new WhatsAppSender(client, (message, level) =>
        level === 'error' ? console.error(`[wa] ${message}`) : console.log(`[wa] ${message}`),
      ),
      accept: this.deps.accept,
      log: (message: string, level?: 'info' | 'warn' | 'error') =>
        level === 'error' ? console.error(message) : console.log(message),
    };
    const poller = this.deps.createPoller ? this.deps.createPoller(deps) : new WhatsAppPoller(deps);
    this.poller = poller;

    try {
      // A message that arrived while we were not polling is still in the
      // database as unprocessed; finish it before accepting new work.
      const resumed = await poller.reconcile();
      if (resumed > 0) this.log(`[boot] whatsapp: resumed ${resumed} unfinished message(s)`);
    } catch (err) {
      // The loop is fine to start regardless: the rows stay queued for the next
      // attempt, and the web app is unaffected.
      this.log(`[wa] reconcile failed: ${(err as Error).message}`, 'error');
    }

    poller.start();
    this.log(`[wa] poller started (${reason})`);
    return 'started';
  }

  private async stop(reason: string, detail: string | null): Promise<SyncOutcome> {
    const poller = this.poller;
    this.poller = null;
    if (poller) await poller.stop();
    this.log(`[wa] poller stopped (${reason}${detail ? `: ${detail}` : ''})`);
    return 'stopped';
  }

  /** Shutdown path: one place, so a half-stopped loop cannot outlive the process. */
  async shutdown(): Promise<void> {
    if (!this.poller) return;
    const poller = this.poller;
    this.poller = null;
    await poller.stop();
  }
}
