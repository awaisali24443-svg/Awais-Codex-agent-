/* ==========================================================================
   Codex — service worker.

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

const VERSION = 'codex-v2';
const SHELL = [
  '/',
  '/index.html',
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
      try {
        const response = await fetch(event.request);
        // Only successful, non-partial responses are worth keeping.
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          const cache = await caches.open(VERSION);
          await cache.put(event.request, copy).catch(() => undefined);
        }
        return response;
      } catch (err) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // A navigation with nothing cached for that path still gets the shell,
        // so an offline reload lands on the app rather than the dinosaur.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })(),
  );
}

self.addEventListener('fetch', /** @type {any} */ (onFetch));
