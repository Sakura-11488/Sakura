/* Sakura PWA service worker.
 *
 * Deliberately conservative: the app ships hashed JS bundles that change every
 * deploy, so this does NOT aggressively pre-cache them (that's how PWAs get
 * stuck on a stale build). It:
 *   1. serves navigations network-first, falling back to a cached shell offline
 *   2. serves downloaded chapter pages from the offline library
 *   3. passes everything else straight through
 * That's enough to satisfy Chrome's installability requirement (a fetch
 * handler) while guaranteeing users always get the newest build when online.
 *
 * This file can brick an installed PWA for every user at once, which is why it
 * stays small and why the two rules below are absolute.
 */

// Shell cache. Versioned, and swept on activate.
const SHELL_CACHE = 'sakura-shell-v2';
const SHELL = '/app/';

/**
 * The offline library. NEVER swept.
 *
 * RULE 1: only caches named `sakura-shell-*` may be deleted here.
 *
 * The previous version deleted every key that was not the current shell cache,
 * and because install() calls skipWaiting(), that ran on EVERY deploy. Any
 * downloaded chapter would have been destroyed by the next release — silently,
 * and for everyone at once. The library is deliberately not versioned: its
 * contents are user data, not build output, and nothing here may assume it can
 * be regenerated.
 */
const LIBRARY_CACHE = 'sakura-offline-v1';

/**
 * Same-origin URL prefix for downloaded pages.
 *
 * Pages are stored under synthetic URLs rather than as blobs so the reader can
 * keep rendering `<Image source={{ uri }}>` with no idea the page is local —
 * that is the whole reason this uses Cache Storage rather than OPFS, which
 * would force blob: URL minting and revocation bookkeeping into the reader.
 *
 * Must sit inside the worker's registration scope (/app/) or these requests
 * never reach this handler.
 */
const OFFLINE_PREFIX = '/app/__offline/';

self.addEventListener('install', () => {
  // Activate immediately so a new deploy replaces the old worker.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          // RULE 1, enforced. An unrecognised cache is left alone: deleting
          // something we did not create is how user data disappears.
          .filter((k) => k.startsWith('sakura-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Downloaded pages. Cache-only by design: a synthetic URL has no server to
  // fall back to, so a miss is a genuine miss and must not become a network
  // request that 404s against the deployment.
  if (url.origin === self.location.origin && url.pathname.startsWith(OFFLINE_PREFIX)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(LIBRARY_CACHE);
        const hit = await cache.match(req.url);
        if (hit) return hit;
        // 404 rather than a network attempt, so the reader's own fallback runs
        // and the user gets the online page instead of a broken image.
        return new Response('Not downloaded', { status: 404, statusText: 'Not downloaded' });
      })(),
    );
    return;
  }

  // Navigations: always try the network first so the app self-updates; fall
  // back to the last good shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          }
          return res;
        } catch {
          const cached = await caches.match(SHELL);
          return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })(),
    );
    return;
  }

  /**
   * Content-hashed build assets, cache-first.
   *
   * RULE 2: only ever cache-first on paths whose filenames contain a content
   * hash. These cannot change under a fixed URL, so a stale hit is impossible;
   * anything else must stay network-first or the app can pin itself to an old
   * build with no way out.
   *
   * Without this the cached shell loads a <script> whose bundle was never
   * stored, so "offline" meant a blank page — the PWA could not actually boot
   * offline at all, which made an offline library pointless.
   */
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/app/_expo/') || url.pathname.startsWith('/app/assets/'))
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })(),
    );
    return;
  }

  // Everything else falls through to the network untouched.
});
