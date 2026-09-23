import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { selfPingTarget, startSelfPing, SELF_PING_INTERVAL_MS } from './selfping.js';

describe('selfPingTarget', () => {
  const OLD = process.env.RENDER_EXTERNAL_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = OLD;
  });

  it('builds the /healthz URL from APP_URL and strips trailing slashes', () => {
    assert.equal(selfPingTarget('https://svc.onrender.com/'), 'https://svc.onrender.com/healthz');
  });

  it('falls back to RENDER_EXTERNAL_URL when APP_URL is empty', () => {
    process.env.RENDER_EXTERNAL_URL = 'https://render-gave-me.onrender.com';
    assert.equal(
      selfPingTarget(''),
      'https://render-gave-me.onrender.com/healthz',
    );
  });

  it('returns null when no public URL is known', () => {
    delete process.env.RENDER_EXTERNAL_URL;
    assert.equal(selfPingTarget(''), null);
  });
});

describe('startSelfPing', () => {
  it('pings every 14 minutes and never throws on fetch failure', async () => {
    let seenUrl: string | null = null;
    let seenMs = 0;
    let runs = 0;
    const calls: Array<() => void> = [];
    const stop = startSelfPing(
      'https://svc.onrender.com/healthz',
      () => {},
      {
        fetchImpl: (async (u: string) => {
          seenUrl = u;
          return { ok: false, status: 500 };
        }) as unknown as typeof fetch,
        setIntervalImpl: (fn: () => void, ms: number) => {
          seenMs = ms;
          calls.push(fn);
          return {} as unknown;
        },
      },
    );
    assert.equal(seenMs, SELF_PING_INTERVAL_MS);
    assert.equal(seenMs, 14 * 60_000);
    calls[0]();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seenUrl, 'https://svc.onrender.com/healthz');
    runs = calls.length;
    assert.equal(runs, 1);
    assert.doesNotThrow(() => stop());
  });

  it('logs fetch errors instead of crashing the loop', async () => {
    const logged: string[] = [];
    const calls: Array<() => void> = [];
    startSelfPing('https://down.example/healthz', (m) => logged.push(m), {
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
      setIntervalImpl: (fn: () => void) => {
        calls.push(fn);
        return {} as unknown;
      },
    });
    calls[0]();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logged.some((m) => m.includes('boom')));
  });
});
