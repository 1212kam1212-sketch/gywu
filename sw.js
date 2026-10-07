// sw.js — service worker for FORGED.
//
// Strategy: network-first for everything in ASSETS, falling back to the
// cache when offline. This means content freshness does NOT depend on
// remembering to bump CACHE_NAME on every push - as long as the phone is
// online, it always fetches the latest deployed files and refreshes the
// cache in the background; offline, it falls back to whatever was cached
// last. CACHE_NAME only needs bumping if the *set* of cached files changes
// (e.g. adding a new icon) so activate can clean up old cache stores.
//
// The app (see js/app.js) listens for 'updatefound' and shows a "New
// version available" toast when the service worker SCRIPT itself changes;
// tapping it posts SKIP_WAITING here, which activates the new worker and
// triggers a reload via 'controllerchange'. That covers the case where sw.js
// logic itself changes. Everyday content updates (html/css/js edits) are
// already picked up on next load via the network-first fetch strategy above,
// with no version bump or explicit update prompt needed.

// gywu-v2: bumped so the update clears out any half-updated copies of the app
// files left in the old cache.
const CACHE_NAME = 'gywu-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/app.js',
  './js/db.js',
  './js/lib.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // cache: 'reload' skips the browser's HTTP cache (GitHub Pages lets it keep
    // files for 10 minutes), so the cache is filled with the real latest files.
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  // Intentionally no self.skipWaiting() here - the new worker waits until
  // the page asks it to take over (see the SKIP_WAITING message handler),
  // so the "update available" toast has something meaningful to trigger.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Same-origin files are revalidated with the server on every load
  // (cache: 'no-cache'), so the browser's 10-minute HTTP cache can never serve
  // an old copy of one file next to new copies of the others - that mix of
  // versions is what can crash the app right after an update.
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;
  const network = sameOrigin
    ? fetch(event.request.url, { cache: 'no-cache' })
    : fetch(event.request);

  event.respondWith(
    network
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
