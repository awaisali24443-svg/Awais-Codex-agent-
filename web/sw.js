/* ==========================================================================
   WAIS — service worker.

   Deliberately tiny and deliberately dull, because the failure mode of a
   clever service worker is a user staring at a stale app that never updates.

   Rules:
     * /api/* is never touched. Streams, runs and budgets must always be live;
       a cached API response would be a lie.
     * Everything else is NETWORK FIRST, cache second. Online, you always get
       the deployed version. Offline (a phone with no data), you get the shell
       and the last answer instead of a browser error page.
     * One cache name, versioned. Bumping VERSION is the whole update story:
       `activate` deletes every cache that is not the current one.

   This is what makes the app installable on Android/iOS and usable from a
   home-screen icon with no network — a real gap in v2 until now (the PWA was
   a manifest with no worker behind it).
   ========================================================================== */

/* The service-worker globals (`ExtendableEvent`, `FetchEvent`,
   `ServiceWorkerGlobalScope`) live in TypeScript's WebWorker lib, which cannot
   be loaded alongside DOM — the two declare `self` and `caches` differently. So
   the small surface this file uses is named here instead, which keeps the file
   under `npm run lint:web` and therefore keeps typos in it from shipping. */
/**
 * @typedef {object} WorkerEvent
 * @property {(promise: Promise<unknown>) => void} waitUntil
 * @property {Request} [request]
 * @property {(response: Promise<Response> | Response) => void} [respondWith]
 */

/* Bumped whenever the shell changes: `activate` deletes every other cache, so
   an installed phone cannot keep serving the previous UI from the offline copy.
   The fetch handler is network-first regardless; this is the belt to its
   braces. */
const VERSION = 'wais-v4';

/* How long a navigation waits for the network before the cached shell is shown.
   The service sleeps when idle on the free tier and a cold start takes the
   better part of a minute; network-first with no ceiling means the phone shows a
   blank page for that whole time. The request is not aborted — it carries on and
   updates the cache — this only decides when the operator stops looking at
   nothing. */
const NAVIGATION_TIMEOUT_MS = 6_000;

/** The promise, or null if it has not settled within `ms`. Never rejects. */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}
const SHELL = [
  '/',
  '/index.html',
  '/theme.css',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
];

/** @param {WorkerEvent} event */
function onInstall(event) {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Individually, so one missing asset cannot fail the whole install.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)),
      );
      await /** @type {any} */ (self).skipWaiting();
    })(),
  );
}

self.addEventListener('install', /** @type {any} */ (onInstall));

/** @param {WorkerEvent} event */
function onActivate(event) {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
      await /** @type {any} */ (self).clients.claim();
    })(),
  );
}

self.addEventListener('activate', /** @type {any} */ (onActivate));

/** Nothing under /api, and nothing cross-origin, is ever cached here. */
function cacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api')) return false;
  return true;
}

/** @param {WorkerEvent} event */
function onFetch(event) {
  const url = new URL(event.request.url);
  if (!cacheable(event.request, url)) return;

  event.respondWith(
    (async () => {
      const network = fetch(event.request).then(async (response) => {
        // Only successful, non-partial responses are worth keeping.
        if (response && response.ok && response.type === 'basic') {
          const cache = await caches.open(VERSION);
          await cache.put(event.request, response.clone()).catch(() => undefined);
        }
        return response;
      });

      // A navigation is the one request the operator is *waiting* on, so it is
      // the one that gets a ceiling: the cached shell after
      // NAVIGATION_TIMEOUT_MS, and the real page whenever it arrives.
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) {
          const raced = await settleWithin(network, NAVIGATION_TIMEOUT_MS);
          return raced ?? shell;
        }
      }

      try {
        return await network;
      } catch (err) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // A navigation with nothing cached for that path still gets the shell,
        // so an offline reload lands on the app rather than the dinosaur.
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('/index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })(),
  );
}

self.addEventListener('fetch', /** @type {any} */ (onFetch));
