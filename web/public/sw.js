/* Sakura PWA service worker.
 *
 * Deliberately conservative: the app ships hashed JS bundles that change every
 * deploy, so this does NOT aggressively pre-cache them (that's how PWAs get
 * stuck on a stale build). It only:
 *   1. serves navigations network-first, falling back to a cached shell offline
 *   2. passes everything else straight through
 * That's enough to satisfy Chrome's installability requirement (a fetch
 * handler) while guaranteeing users always get the newest build when online.
 */
const CACHE = 'sakura-shell-v1';
const SHELL = '/app/';

self.addEventListener('install', () => {
  // Activate immediately so a new deploy replaces the old worker.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigations: always try the network first so the app self-updates; fall
  // back to the last good shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          }
          return res;
        } catch {
          const cached = await caches.match(SHELL);
          return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })(),
    );
  }
  // Everything else falls through to the network untouched.
});
