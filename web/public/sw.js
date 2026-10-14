/* Sakura PWA service worker.
 *
 * It:
 *   1. precaches ONE build's shell at install — the document, its
 *      content-hashed bundle and every lazy chunk it can load, and the fonts,
 *      icon fonts and small assets it needs — so the app can boot offline, and
 *      open the reader, the player and Downloads, from the very first visit
 *   2. serves navigations network-first, falling back to that shell when the
 *      network fails, returns a 5xx, or takes longer than NAV_TIMEOUT_MS
 *   3. serves content-hashed build assets cache-first
 *   4. serves downloads from the offline library, cache-only
 *   5. passes everything else straight through
 *
 * It used to precache nothing: the shell was stored only when a navigation
 * passed through the worker, and the first page load never does (the worker is
 * not controlling it yet). So someone who downloaded chapters on their first
 * visit and reopened the app offline got a bare "Offline" page on every route,
 * Downloads included: the downloads were in the cache, and unreachable.
 *
 * Precaching is safe here in a way it usually is not. Everything precached is
 * content-hashed except the document; the document is network-first; and the
 * cached document is only ever replaced together with the bundle it loads. So
 * an online user always gets the newest build, and an offline one always gets
 * a document whose bundle is actually in the cache.
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
 * RULE 1: only caches named `sakura-shell-*` may be deleted here, and nothing
 * in this file deletes an entry from the library.
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
 * Same-origin URL prefix for downloads.
 *
 * Pages are stored under synthetic URLs rather than as blobs so the reader can
 * keep rendering `<Image source={{ uri }}>` with no idea the page is local —
 * that is the whole reason this uses Cache Storage rather than OPFS, which
 * would force blob: URL minting and revocation bookkeeping into the reader.
 *
 * Must sit inside the worker's registration scope (/app/) or these requests
 * never reach this handler. Mirrors OFFLINE_PREFIX in
 * sakura-mobile/lib/offline-cache-keys.ts; everything under it (pages, HLS
 * playlists and segments, title snapshots, covers) is served the same way.
 */
const OFFLINE_PREFIX = '/app/__offline/';

/**
 * This build's precache list, written in by web/scripts/write-precache-manifest.mjs:
 *   { build: '<bundle hash>', urls: ['/app/_expo/static/js/web/index-<hash>.js', '/app/assets/…', …] }
 * Every URL in it is content-hashed. The document is not listed: it is always
 * SHELL, and it is fetched fresh at install.
 *
 * Inlined rather than fetched from a separate file so that sw.js changes byte
 * for byte on every deploy. That is the only thing that makes a browser install
 * a new worker: an identical sw.js never runs install again, so a list fetched
 * at install would have been read once, on the first visit, and never again.
 *
 * null in web/public/sw.js itself. An unbuilt copy has no export to precache,
 * so install caches nothing up front and activate prunes nothing.
 */
const PRECACHE = /* @sakura-precache */ null;

/**
 * How long a navigation waits on the network before the cached shell is served
 * instead. With no limit, a captive portal or a connection that is technically
 * up but useless never reached the fallback: the fetch neither succeeds nor
 * fails, and the user stares at a white screen. The slow response still lands
 * in the background and refreshes the shell for next time.
 */
const NAV_TIMEOUT_MS = 4000;

/** Parallel fetches while precaching. Install runs while the page is loading. */
const PRECACHE_CONCURRENCY = 4;
// A stalled CDN response must not leave the first worker installing forever.
// Applies to each of install's two phases separately (see precacheShell).
const PRECACHE_TIMEOUT_MS = 60_000;

/**
 * How long install holds back the lazy chunks and optional assets, unless a
 * page says sooner that it has finished loading (any `sakura:warm-shell`
 * message; router-context.js sends one once the first screen is up and the
 * browser is idle).
 *
 * The worker registers while the page is still parsing, so install runs
 * during the very first load. Everything the page itself loads costs nothing
 * extra to precache (the HTTP cache shares the download), but the lazy chunks
 * are megabytes the page did not ask for, and on a phone connection fetching
 * them right then delays the bundle, the catalogue calls and the covers the
 * visitor is waiting on.
 */
const LAZY_PRECACHE_DELAY_MS = 10_000;

/**
 * How long a freshly fetched document may wait for its bundle to reach the
 * cache (the page is loading it) before giving up on adopting it as the shell.
 */
const ADOPT_POLLS = 30;
const ADOPT_POLL_MS = 2000;

const TIMED_OUT = {};

const sameOrigin = (u) => new URL(u, self.location.origin).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const contentType = (res) => (res.headers.get('Content-Type') || '').toLowerCase();

/**
 * RULE 2: only ever cache-first on paths whose filenames contain a content
 * hash. These cannot change under a fixed URL, so a stale hit is impossible;
 * anything else must stay network-first or the app can pin itself to an old
 * build with no way out.
 */
function isHashedPath(pathname) {
  return (pathname.startsWith('/app/_expo/') || pathname.startsWith('/app/assets/')) &&
    /[.-][a-f0-9]{16,}\.[^/]+$/i.test(pathname);
}

/**
 * The hashed scripts and stylesheets a shell document loads or may load, as
 * absolute URLs: what it fetches at boot, plus the lazy chunks it names in
 * non-fetching <link rel="sakura-chunk"> / <link data-sakura-common> tags
 * (web/scripts/defer-common-chunk.mjs). Screens such as the reader, the
 * player and Downloads live in those chunks, so a shell is only complete —
 * and only adopted, and only protected from pruning — together with them.
 */
function shellEntries(html) {
  const out = new Set();
  const re = /(?:src|href)="(\/app\/_expo\/static\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.add(sameOrigin(m[1]));
  return [...out];
}

/** The subset of shellEntries the document does not fetch while it boots. */
function lazyEntries(html) {
  const out = new Set();
  const re = /<link rel="sakura-(?:chunk|common)"[^>]*?\shref="(\/app\/_expo\/static\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.add(sameOrigin(m[1]));
  return out;
}

/**
 * Whether a response may be stored under a content-hashed URL. Never HTML: if a
 * rewrite ever answered a missing bundle with index.html, caching that would
 * serve the document as JavaScript for good, because these entries are never
 * revalidated.
 */
function isCacheableAsset(res) {
  return !!res && res.status === 200 && !contentType(res).includes('text/html');
}

async function hasAll(cache, urls) {
  const hits = await Promise.all(urls.map((u) => cache.match(u)));
  return hits.every(Boolean);
}

async function cacheHashed(cache, url, signal) {
  // A hit cannot be stale, so this skips everything an earlier build already
  // stored: on most deploys only the new bundle is downloaded.
  if (await cache.match(url)) return;
  signal.throwIfAborted();
  const res = await fetch(url, { signal });
  if (!isCacheableAsset(res)) throw new Error(`precache ${url}: ${res && res.status}`);
  signal.throwIfAborted();
  await cache.put(url, res);
}

/** Promise.allSettled semantics with a concurrency cap: failures are skipped, never thrown. */
async function settleAll(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        // Best effort. One missing icon font must not cost the user the shell.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Run `work(signal)`, aborting it after PRECACHE_TIMEOUT_MS. Never rejects. */
function withDeadline(work) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, PRECACHE_TIMEOUT_MS);
  });
  return Promise.race([work(controller.signal).catch(() => {}), deadline])
    .finally(() => clearTimeout(timer));
}

/** A page has said it finished loading (it may say so before install gets to the gate). */
let pageSettled = false;
let releaseLazyPhase = null;
/** Resolves after LAZY_PRECACHE_DELAY_MS, or as soon as a page says it is done loading. */
function lazyPhaseGate() {
  if (pageSettled) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(open, LAZY_PRECACHE_DELAY_MS);
    function open() {
      clearTimeout(timer);
      releaseLazyPhase = null;
      resolve();
    }
    releaseLazyPhase = open;
  });
}

/**
 * Fetch this build's document and everything on the precache list into the
 * shell cache, in two phases:
 *   1. the document and what it fetches at boot (the page is downloading the
 *      same files right now, so this adds nothing to the first load);
 *   2. after `gate`, the lazy chunks it names, then the optional assets.
 * The document is stored only once every chunk it names made it in: a shell
 * that boots but cannot open the reader offline is worse than keeping the
 * previous, complete one.
 */
async function precacheShell(gate) {
  if (!PRECACHE || !Array.isArray(PRECACHE.urls)) return;
  const cache = await caches.open(SHELL_CACHE);

  let doc = null;
  await withDeadline(async (signal) => {
    try {
      const res = await fetch(SHELL, { cache: 'no-cache', signal });
      if (res.status === 200 && contentType(res).includes('text/html')) {
        const html = await res.clone().text();
        const entries = shellEntries(html);
        if (entries.length) doc = { res, entries, lazy: lazyEntries(html) };
      }
    } catch {
      // Offline or flaky: whatever shell is already cached stays.
    }
    if (!doc) return;
    const boot = doc.entries.filter((u) => !doc.lazy.has(u));
    await settleAll(boot, PRECACHE_CONCURRENCY, (u) => cacheHashed(cache, u, signal));
  });

  await gate();

  await withDeadline(async (signal) => {
    // The document's own entries as well as the list's: if a newer deploy
    // landed between this worker being fetched and now, the document loads a
    // bundle the list has never heard of.
    const wanted = new Set(PRECACHE.urls.map(sameOrigin));
    if (doc) {
      // Commit a usable shell before optional icons/assets: one hung font must
      // not prevent a successfully fetched document and its chunks working
      // offline.
      await settleAll(doc.entries, PRECACHE_CONCURRENCY, (u) => cacheHashed(cache, u, signal));
      signal.throwIfAborted();
      if (await hasAll(cache, doc.entries)) await cache.put(SHELL, doc.res);
      for (const u of doc.entries) wanted.delete(u);
    }
    await settleAll([...wanted], PRECACHE_CONCURRENCY, (u) => cacheHashed(cache, u, signal));
  });
}

let warming = null;
/**
 * `gated`: install's run, which waits for lazyPhaseGate before phase 2. A run
 * a page asks for is not gated: the page asking is the signal.
 */
function warmShell({ gated = false } = {}) {
  if (!warming) {
    const gate = gated ? lazyPhaseGate : () => Promise.resolve();
    warming = precacheShell(gate)
      .catch(() => {})
      .finally(() => {
        warming = null;
      });
  }
  return warming;
}

/**
 * Delete bundles from earlier builds. Every deploy adds a ~7.5MB bundle, and
 * this cache shares the origin's storage quota with the user's downloads, so
 * letting them pile up raises the odds that the browser evicts the whole
 * origin, downloads included.
 *
 * Keeps this build's list AND whatever the cached document loads, so the
 * offline shell is never left pointing at a deleted bundle (the document lags
 * the list when install could not fetch it). Only /app/_expo/ is pruned:
 * /app/assets/ also holds large images that are cached on first use rather
 * than precached, and pruning those would only mean downloading them again.
 */
async function pruneStaleBundles() {
  if (!PRECACHE || !Array.isArray(PRECACHE.urls)) return;
  const cache = await caches.open(SHELL_CACHE);
  const keep = new Set(PRECACHE.urls.map(sameOrigin));
  const shell = await cache.match(SHELL);
  if (shell) for (const u of shellEntries(await shell.text())) keep.add(u);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((r) => new URL(r.url).pathname.startsWith('/app/_expo/') && !keep.has(r.url))
      .map((r) => cache.delete(r)),
  );
}

/**
 * Store a navigation response as the shell once the bundle it loads is in the
 * cache. The page is loading that bundle right now through the hashed-asset
 * route below, so this waits for it rather than downloading it a second time.
 *
 * Anything that is not the app's document (an image or a JSON file opened
 * directly in a tab) is never adopted. The old handler stored every OK
 * navigation as the shell, so opening /app/version.json once would have made
 * the offline app a JSON file.
 */
async function adoptShell(res) {
  if (!res || res.status !== 200 || !contentType(res).includes('text/html')) return;
  const entries = shellEntries(await res.clone().text());
  if (!entries.length) return;
  const cache = await caches.open(SHELL_CACHE);
  for (let i = 0; i < ADOPT_POLLS; i++) {
    if (await hasAll(cache, entries)) {
      await cache.put(SHELL, res);
      return;
    }
    await sleep(ADOPT_POLL_MS);
  }
}

async function cachedShell() {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match(SHELL)) || null;
}

async function navigate(event) {
  const network = fetch(event.request);
  // A late rejection, after the timeout won, must not surface as unhandled.
  network.catch(() => {});

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), NAV_TIMEOUT_MS);
  });
  let res;
  try {
    res = await Promise.race([network, timeout]);
  } catch {
    res = null; // offline, DNS failure, connection reset
  } finally {
    clearTimeout(timer);
  }

  if (res === TIMED_OUT) {
    const cached = await cachedShell();
    if (cached) {
      event.waitUntil(network.then((late) => adoptShell(late)).catch(() => {}));
      return cached;
    }
    // No shell yet (a first visit): waiting is the only way in.
    try {
      res = await network;
    } catch {
      res = null;
    }
  }

  // Every route under /app/ is the same document, so a server error is never
  // the "real" page and the cached shell is strictly better than an error page.
  if (res && res.status < 500) {
    if (res.ok) event.waitUntil(adoptShell(res.clone()).catch(() => {}));
    return res;
  }
  const cached = await cachedShell();
  if (cached) return cached;
  return res || new Response('Offline', { status: 503, statusText: 'Offline' });
}

/**
 * Range support, for downloaded video and for audio.
 *
 * Images never send a Range header, so they take the early return below and
 * get the stored response untouched. Media elements are different: a <video>
 * asks for byte ranges to seek, and returning the stored 200 verbatim meant the
 * browser could play from the start but could not seek at all — measured on a
 * 43s clip, seeking to 34.74s left currentTime at 0.00 and buffered stuck at
 * [0, 14.195]. Safari is stricter still and may refuse a media response that
 * ignores Range outright, which is why precached tap sounds come through here
 * too.
 */
async function withRange(req, hit) {
  const range = req.headers.get('range');
  if (!range || hit.status !== 200) return hit;

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  // Ignore unsupported/malformed ranges before consuming the cached body.
  // Returning `hit` after blob() makes respondWith reject a used response.
  if (!m) return hit;
  const blob = await hit.blob();
  const size = blob.size;

  const unsatisfiable = () =>
    new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    });

  let start;
  let end;
  if (m[1] === '') {
    // Suffix form: the last N bytes.
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n <= 0) return unsatisfiable();
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (!Number.isFinite(start) || start > end || start >= size) return unsatisfiable();

  const type = hit.headers.get('Content-Type') || 'application/octet-stream';
  const slice = blob.slice(start, end + 1, type);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': type,
      'Content-Length': String(slice.size),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('install', (event) => {
  // Activate immediately so a new deploy replaces the old worker.
  self.skipWaiting();
  // Never rejects. Failing install over one missing asset would leave a
  // first-time visitor with no worker at all, and so no way to open anything
  // they download; on an update the previous complete shell stays put anyway,
  // because precacheShell only ever replaces the document together with its
  // bundle.
  event.waitUntil(warmShell({ gated: true }));
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
      try {
        await pruneStaleBundles();
      } catch {
        // A failed prune costs disk space, never the shell.
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * `{ type: 'sakura:warm-shell' }` from a page re-runs the precache. Download
 * code can send it as a download starts, so that if install's precache was cut
 * short, the shell is whole again before the user takes the app offline. Cheap
 * to repeat: everything already cached is skipped. It also tells a worker that
 * is still installing that the page has finished loading, so install's second
 * phase (the lazy chunks) can start now rather than after its delay.
 */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'sakura:warm-shell') return;
  pageSettled = true;
  if (releaseLazyPhase) releaseLazyPhase();
  event.waitUntil(warmShell());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Downloads. Cache-only by design: a synthetic URL has no server to fall back
  // to, so a miss is a genuine miss and must not become a network request that
  // 404s against the deployment.
  if (url.origin === self.location.origin && url.pathname.startsWith(OFFLINE_PREFIX)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(LIBRARY_CACHE);
        // Match on the URL STRING, not the Request. cache.match(req) would take
        // the Range header into account and miss every time.
        const hit = await cache.match(req.url);
        if (!hit) {
          // 404 rather than a network attempt, so the reader's own fallback
          // runs and the user gets the online page instead of a broken image.
          return new Response('Not downloaded', { status: 404, statusText: 'Not downloaded' });
        }
        return withRange(req, hit);
      })(),
    );
    return;
  }

  /**
   * Content-hashed build assets, cache-first (RULE 2, see isHashedPath).
   *
   * Without this the cached shell loads a <script> whose bundle was never
   * stored, so "offline" meant a blank page — the PWA could not actually boot
   * offline at all, which made an offline library pointless.
   */
  if (url.origin === self.location.origin && isHashedPath(url.pathname)) {
    let finishCache;
    // cache.put consumes the response body after fetch has resolved. Keep the
    // worker alive until it finishes, even if the browser closes the page.
    event.waitUntil(new Promise((resolve) => { finishCache = resolve; }));
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(SHELL_CACHE);
          // By URL string, for the same Range reason as the library above.
          const hit = await cache.match(req.url);
          if (hit) return withRange(req, hit);
          const res = await fetch(req);
          if (isCacheableAsset(res)) {
            const done = finishCache;
            finishCache = () => {};
            cache.put(req.url, res.clone()).catch(() => {}).finally(done);
          }
          return res;
        } finally {
          finishCache();
        }
      })(),
    );
    return;
  }

  // Only app documents fall back to the shell. A missing static file must
  // never become a successful HTML response (including when opened in a tab).
  if (req.mode === 'navigate' && url.origin === self.location.origin &&
      url.pathname.startsWith('/app/') &&
      !/^\/app\/(?:_expo\/|assets\/|icons\/|share\/|(?:sw\.js|version\.json|manifest\.json|metadata\.json|favicon\.ico)$)/.test(url.pathname)) {
    event.respondWith(navigate(event));
    return;
  }

  // Everything else falls through to the network untouched.
});
