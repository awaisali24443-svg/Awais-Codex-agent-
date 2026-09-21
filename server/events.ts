/**
 * In-process pub/sub, one channel per run.
 *
 * Every event is *persisted first* and only then published, so a client that
 * reconnects can rebuild the full stream from Postgres. The bus is therefore a
 * latency optimisation, never the source of truth: if it drops something, the
 * client re-reads the database and is whole again.
 *
 * Transient events are the one exception. They carry no `seq`, are never
 * stored, and exist so tokens can reach the screen the instant they arrive.
 * A client that misses them loses no information — the next durable snapshot
 * carries the complete text.
 */

export interface StreamEvent {
  /** Absent on transient events. Present => replayable, and sets Last-Event-ID. */
  seq?: number;
  type: string;
  payload: Record<string, unknown>;
}

type Listener = (event: StreamEvent) => void;

export class EventBus {
  private readonly channels = new Map<string, Set<Listener>>();

  /** Returns an unsubscribe function. Safe to call more than once. */
  subscribe(runId: string, listener: Listener): () => void {
    let set = this.channels.get(runId);
    if (!set) {
      set = new Set();
      this.channels.set(runId, set);
    }
    set.add(listener);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.channels.get(runId);
      if (!current) return;
      current.delete(listener);
      // Deleting the key matters: runs are unbounded, so an empty Set left
      // behind would leak one entry per mission for the process lifetime.
      if (current.size === 0) this.channels.delete(runId);
    };
  }

  publish(runId: string, event: StreamEvent): void {
    const set = this.channels.get(runId);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        // One dead consumer must never break the run or the other consumers.
        console.error(`[bus] listener threw on ${runId}:`, (err as Error).message);
      }
    }
  }

  /** Fire-and-forget, not stored, no sequence number. */
  publishTransient(runId: string, type: string, payload: Record<string, unknown>): void {
    this.publish(runId, { type, payload });
  }

  /** Diagnostics for /api/status. */
  subscriberCount(runId: string): number {
    return this.channels.get(runId)?.size ?? 0;
  }

  get channelCount(): number {
    return this.channels.size;
  }
}
