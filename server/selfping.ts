/**
 * Self-ping: keep the free tier awake.
 *
 * Render's free plan sleeps the service after ~15 minutes without inbound
 * HTTP traffic, which would stop the scheduler and the WhatsApp poller. A
 * timer inside the process cannot wake a sleeping process — but it can stop
 * it from ever falling asleep: one GET to our own /healthz every 14 minutes
 * counts as inbound traffic and resets the idle clock. /healthz hits are
 * already excluded from request logging, so the logs stay quiet.
 *
 * The public URL comes from APP_URL, falling back to Render's own
 * RENDER_EXTERNAL_URL. With neither set there is nothing to ping, and the
 * loop stays off with a warning instead of guessing.
 */
export const SELF_PING_INTERVAL_MS = 14 * 60_000;
export const SELF_PING_PATH = '/healthz';

export function selfPingTarget(appUrl: string): string | null {
  const base = (
    appUrl ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  return base ? `${base}${SELF_PING_PATH}` : null;
}

export interface SelfPingHooks {
  fetchImpl?: typeof fetch;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
}

/** Start the loop. Returns a stop function for shutdown and tests. */
export function startSelfPing(
  url: string,
  log: (message: string) => void = () => {},
  hooks: SelfPingHooks = {},
): () => void {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  const setIntervalImpl = hooks.setIntervalImpl ?? setInterval;

  const ping = (): void => {
    void (async () => {
      try {
        const res = await fetchImpl(url);
        // A non-200 here is Render's problem to report, not ours to crash on.
        if (!res.ok) log(`[selfping] ${url} -> ${res.status}`);
      } catch (err) {
        log(`[selfping] failed: ${(err as Error).message}`);
      }
    })();
  };

  const timer = setIntervalImpl(ping, SELF_PING_INTERVAL_MS) as NodeJS.Timeout & {
    unref?: () => void;
  };
  timer.unref?.();
  log(`[selfping] on — ${url} every 14 minutes`);
  return () => clearInterval(timer);
}
