/**
 * Outbound WhatsApp, serialised.
 *
 * The platform does not guarantee the order of concurrent sends to the same
 * recipient, so nothing is ever sent in parallel: every send goes through one
 * promise chain. That also makes the 12-sends-per-minute cap easy to reason
 * about, and lets a long answer reach the phone in the order it was written.
 *
 * A failed send is logged, counted, and swallowed. Losing an answer is bad;
 * taking the poll loop down with it is worse — the run is still in Postgres and
 * the web UI still shows it.
 */
import { MAX_TEXT_CHARS, WhatsAppError, splitText, type WhatsAppClient } from './api.js';

export class WhatsAppSender {
  private chain: Promise<void> = Promise.resolve();
  private sentCount = 0;
  private failed = 0;
  private lastError: string | null = null;

  constructor(
    private readonly client: WhatsAppClient,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  get sent(): number {
    return this.sentCount;
  }

  get failures(): number {
    return this.failed;
  }

  get error(): string | null {
    return this.lastError;
  }

  /**
   * Queue a text, split into platform-legal chunks, in order.
   *
   * Resolves true only when every chunk was accepted by the platform — the
   * caller uses that to decide whether the message still needs delivering on
   * the next boot.
   */
  async send(
    text: string,
    options: { replyTo?: string | null; previewUrl?: boolean } = {},
  ): Promise<boolean> {
    const chunks = splitText(text, MAX_TEXT_CHARS);
    if (chunks.length === 0) return true;

    // Only the first chunk quotes the inbound message; quoting every chunk
    // would stack the same reply bubble in the chat.
    const [first, ...rest] = chunks;
    let ok = await this.enqueue(() => this.client.sendText(first, options));
    for (const chunk of rest) {
      if (!(await this.enqueue(() => this.client.sendText(chunk)))) ok = false;
    }
    return ok;
  }

  /**
   * Mark a message read, optionally showing the typing indicator.
   *
   * Queued like a send so it cannot overtake a reply that was already handed
   * to the chain — and, more importantly, so the caller can be sure it happens
   * *after* the message is durably recorded. Marking read deletes the message
   * from the platform's replay buffer; doing that before it is stored is how a
   * task disappears.
   */
  async markRead(messageId: string, options: { typing?: boolean } = {}): Promise<boolean> {
    return await this.enqueue(() => this.client.markRead(messageId, options));
  }

  private async enqueue(operation: () => Promise<unknown>): Promise<boolean> {
    let succeeded = false;
    const next = this.chain.then(async () => {
      try {
        await operation();
        this.sentCount += 1;
        succeeded = true;
      } catch (err) {
        this.failed += 1;
        const error = err as Error;
        this.lastError = error.message;
        const kind = err instanceof WhatsAppError ? ` (${err.kind})` : '';
        this.log(`send failed${kind}: ${error.message}`, 'error');
      }
    });
    // Keep the chain alive for the next caller even if this one failed.
    this.chain = next.catch(() => undefined);
    await next;
    return succeeded;
  }
}
