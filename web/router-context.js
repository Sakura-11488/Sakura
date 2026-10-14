// Metro resolves junctioned ./app files to canonical sakura-mobile paths in
// require.context keys (e.g. "../../sakura-mobile/app/index.tsx"). Expo Router
// expects keys like "./index.tsx" — normalize them here.
//
// Route-level code splitting (web only; native builds use their own context).
// Every route is a 'lazy' context entry, which Metro emits as its own chunk and
// expo-router loads on first visit (app.config.ts sets extra.router.asyncRoutes
// for web). Before this, one 8.9MB bundle carried all 50 screens, so a phone
// downloaded and parsed the trading screen, the video player and the creator
// tools before it could paint Home.
//
// A few files stay in the main bundle, through the eager context below:
//   - every _layout, including any added later: expo-router loads layouts
//     synchronously while it builds the route tree, to read unstable_settings
//     (app/_layout.tsx sets initialRouteName). A lazy layout would not fail,
//     its settings would just be silently ignored, so the pattern matches all
//     of them rather than naming today's two
//   - index.web and (tabs)/home: the screens almost every visit starts on.
//     Splitting them off would only add a round trip before first paint.
const rawCtx = require.context(
  './app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+middleware)|(?:\+(html|native-intent))))\.[tj]sx?$).*(?:\.android|\.ios|\.native)?\.[tj]sx?$/,
  'lazy',
);
const eagerCtx = require.context(
  './app',
  true,
  /^\.\/(?:(?:.*\/)?_layout|index\.web|\(tabs\)\/home)\.tsx$/,
);

function toRouterKey(rawKey) {
  const normalized = rawKey.replace(/\\/g, '/');
  const appSuffix = normalized.match(/\/app\/(.+)$/);
  if (appSuffix) return './' + appSuffix[1];
  if (normalized.startsWith('./')) return normalized;
  return './' + normalized.replace(/^(\.\.\/)+/, '');
}

const routerToRaw = new Map();
for (const rawKey of rawCtx.keys()) {
  const routerKey = toRouterKey(rawKey);
  if (!routerToRaw.has(routerKey)) {
    routerToRaw.set(routerKey, rawKey);
  }
}

const eagerRaw = new Map();
for (const rawKey of eagerCtx.keys()) {
  eagerRaw.set(toRouterKey(rawKey), rawKey);
}

function contextRequire(routerKey) {
  // A module, not a promise: expo-router reads it synchronously (see above).
  if (eagerRaw.has(routerKey)) return eagerCtx(eagerRaw.get(routerKey));
  const rawKey = routerToRaw.get(routerKey);
  if (!rawKey) return rawCtx(routerKey);
  return rawCtx(rawKey);
}

contextRequire.keys = () => [...routerToRaw.keys()];
contextRequire.resolve = (routerKey) => {
  const rawKey = routerToRaw.get(routerKey) ?? routerKey;
  return rawCtx.resolve ? rawCtx.resolve(rawKey) : rawKey;
};
contextRequire.id = rawCtx.id;

export const ctx = contextRequire;

/**
 * Screens worth having in memory before anyone taps them, most likely first:
 * the manga detail -> reader path most sessions take, then the tab bar and
 * sidebar destinations, then the first-run welcome screen. Each is a 5-50KB
 * chunk, so warming them while the browser is idle turns the first tap from
 * a network round trip into an instant switch. The service worker precaches
 * all of them as well, but that only helps later visits: on a first visit it
 * is still installing.
 */
const PREFETCH_ROUTES = [
  './manga/[id].tsx',
  './chapter/[id].tsx',
  './(tabs)/anime.tsx',
  './(tabs)/search.tsx',
  './(tabs)/novel.tsx',
  './(tabs)/library.tsx',
  './(tabs)/profile.tsx',
  './browse.tsx',
  './(tabs)/messages.tsx',
  './(tabs)/settings.tsx',
  './welcome.tsx',
];

/** Long enough that a first visit's own requests (covers, API calls) go first. */
const PREFETCH_AFTER_LOAD_MS = 2000;

function prefetchRoutes() {
  const connection = typeof navigator !== 'undefined' ? navigator.connection : undefined;
  // Respect Data Saver and very slow links: these are speculative downloads.
  if (connection && (connection.saveData || /(^|-)2g$/.test(connection.effectiveType || ''))) return;
  // A short timeout: on a busy page (covers decoding, a carousel running)
  // true idle periods can be rare, and eleven waits of several seconds each
  // would leave the last screens unwarmed for most of a session.
  const idle = typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 0);
  const queue = PREFETCH_ROUTES.filter((key) => routerToRaw.has(key) && !eagerRaw.has(key));
  // One at a time, each in its own idle slot: evaluating a chunk runs its
  // module code, and a burst of eleven would be a long task of its own.
  const next = () => {
    const key = queue.shift();
    if (!key) return;
    idle(() => {
      let loading;
      try {
        loading = Promise.resolve(rawCtx(routerToRaw.get(key)));
      } catch (error) {
        loading = Promise.reject(error);
      }
      // A failure only means the screen loads when it is opened, as it would
      // have anyway (offline, or a deploy replaced the chunk). Never surface it.
      loading.catch(() => {}).then(next);
    });
  };
  next();
}

/**
 * Tell a service worker that is still installing that this page has finished
 * loading. Install precaches the lazy chunks in a second phase that waits for
 * this (or for a timeout), so that on a first visit they do not compete with
 * the bundle, the catalogue calls and the covers (public/sw.js,
 * LAZY_PRECACHE_DELAY_MS). An active worker is left alone: its precache is
 * done, and the message would only make it re-check the document.
 */
function signalServiceWorker() {
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw) return;
    sw.getRegistration('/app/').then((reg) => {
      const worker = reg && (reg.installing || reg.waiting);
      if (worker) worker.postMessage({ type: 'sakura:warm-shell' });
    }).catch(() => {});
  } catch {
    // No worker support, or storage blocked: nothing to tell.
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && process.env.NODE_ENV === 'production') {
  const start = () => setTimeout(() => {
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 0);
    idle(signalServiceWorker, { timeout: 5000 });
    prefetchRoutes();
  }, PREFETCH_AFTER_LOAD_MS);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
