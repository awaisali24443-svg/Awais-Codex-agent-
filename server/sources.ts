/**
 * Source URL extraction and verification for run reports.
 *
 * A research report is only as trustworthy as its citations. extractUrls pulls
 * every http(s) URL out of the final text; checkSources fetches each one and
 * reports which are alive. The executor records the verdict as a
 * `sources.checked` event before the run closes, so the UI can annotate dead
 * links instead of shipping them silently.
 *
 * Both functions are total: they never throw, so a weird report or a dead
 * network can delay the verdict but never fail the mission.
 */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
/** More URLs than this in one report is noise; the check would take too long. */
const MAX_URLS = 15;
/** A hung server must not hold the run's completion hostage. */
const PER_REQUEST_MS = 8_000;
/** Gentle on other people's servers and on our own event loop. */
const CONCURRENCY = 5;

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    // Trailing punctuation is sentence punctuation, not part of the URL.
    let candidate = match[0].replace(/[.,;:!?]+$/, '');
    let normalized: string;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      normalized = parsed.toString();
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

export interface SourceCheck {
  url: string;
  ok: boolean;
  status?: number;
}

async function checkOne(url: string): Promise<SourceCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_MS);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status === 405 || res.status === 501) {
      // Some servers refuse HEAD; a ranged GET proves the same thing without
      // downloading the body.
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Range: 'bytes=0-0' },
      });
      await res.body?.cancel().catch(() => {});
    }
    return { url, ok: res.ok, status: res.status };
  } catch {
    return { url, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check every URL, a few at a time. Never rejects: an unreachable URL is a
 * failed check, not an exception.
 */
export async function checkSources(urls: string[]): Promise<SourceCheck[]> {
  const results: SourceCheck[] = new Array(urls.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const i = next++;
      results[i] = await checkOne(urls[i]);
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
