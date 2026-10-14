import { readStore, writeStore, removeStore } from '@/lib/kv-store';

/**
 * Persisted API cache, shared by every catalogue loader (manga, manhwa,
 * comics, 18+, novels) and a few small app values.
 *
 * Freshness and retention are separate. An entry is fresh until its TTL; after
 * that it is still kept, and still served, for STALE_GRACE_MS. This used to
 * drop an entry the moment its TTL passed — at load and on every lookup — so a
 * revisit more than five minutes after the last one waited the full ~1 s of
 * network for a home screen whose data was sitting on disk. Now getOrSetCached
 * answers from the stale copy at once and refreshes it behind the screen.
 *
 * The contract every loader relies on is unchanged: only a value the loader
 * RETURNS is stored. A loader that throws stores nothing, so a failure (or an
 * empty answer a loader chose to throw) is never cached; the caller gets the
 * last good value (stale, or via staleIfError) or the error.
 */

type CacheRecord = {
  exp: number;
  value: unknown;
};

const CACHE_FILE = 'sakura_api_cache.json';

/**
 * How long past its TTL an entry is still served while it refreshes. A day
 * covers "came back this evening"; older catalogue data is not worth showing
 * even for the moment a refresh takes.
 */
export const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Chapter lists are never answered from a stale copy. They are the one value
 * a stale copy gets visibly wrong: a series is usually reopened FOR its newest
 * chapter (a new-chapter push opens the reader straight on it), and a list
 * from yesterday hides that chapter on the title page and leaves the reader
 * without next / previous, because the chapter it is on is not in the list —
 * until the screen is opened again, since nothing re-renders on
 * onCacheRefresh. Past their TTL they wait for the network exactly as before,
 * and the kept copy is used only when that fails (staleIfError), which it now
 * also covers across a reload. Every loader names its list
 * `<source>:chapters:…` (manga, manhwa, comics, hentai, novel).
 */
const REVALIDATE_FIRST = /^[a-z]+:chapters:/;

/**
 * Writes are coalesced: the whole cache is one stored blob, and a navigation
 * that misses several keys used to re-serialise and rewrite all of it once
 * per key on the main thread. At most one write a second now, plus a flush
 * when the page is hidden or unloads so nothing is lost on the way out.
 */
export const PERSIST_DEBOUNCE_MS = 1000;

/**
 * Upper bound on the stored blob, in UTF-16 code units (what localStorage
 * counts against its ~5M quota, shared with reading progress, the library
 * and the offline index). A single 1,000-chapter list is ~100K, so this holds
 * a long browsing session; past it the entries closest to useless go first.
 */
export const MAX_PERSIST_CHARS = 1_500_000;
/** One entry larger than this stays in memory only, rather than evicting everything else. */
const MAX_ENTRY_CHARS = MAX_PERSIST_CHARS / 4;

const mem = new Map<string, CacheRecord>();
/**
 * Each entry's `"key":{…}` JSON, kept until the entry changes, so a write
 * re-serialises only what changed instead of the whole cache.
 */
const fragments = new Map<string, string>();
/** One load per key at a time: concurrent callers (prefetch + screen, two shelves) share it. */
const inflight = new Map<string, Promise<unknown>>();
const refreshListeners = new Set<(key: string) => void>();
/** Bumped by clearApiCache, so a load that started before a clear cannot write back into it. */
let generation = 0;
let loaded = false;
let loadingPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let flushHooksInstalled = false;

function isFresh(rec: CacheRecord | undefined, now = Date.now()): boolean {
  return !!rec && now < rec.exp;
}

function isRetained(rec: CacheRecord | undefined, now = Date.now()): boolean {
  return !!rec && now < rec.exp + STALE_GRACE_MS;
}

async function ensureLoaded() {
  if (loaded) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const raw = await readStore(CACHE_FILE);
      if (!raw) {
        loaded = true;
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, CacheRecord>;
      const now = Date.now();
      Object.entries(parsed || {}).forEach(([key, rec]) => {
        if (rec && typeof rec.exp === 'number' && isRetained(rec, now) && !mem.has(key)) {
          mem.set(key, rec);
        }
      });
    } catch {
      // Ignore cache read issues to keep app resilient.
    } finally {
      loaded = true;
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

/**
 * The blob to store: every entry still within its grace period, minus, when
 * over `budget`, the ones that expire soonest. Sorting by expiry evicts stale
 * catalogue data first and long-lived values last — price alerts and pass
 * receipts are written with TTLs of months — which plain "oldest write first"
 * would not. Evicted entries leave memory too, so memory stays bounded.
 */
function serialize(now: number, budget: number): string {
  const parts: { key: string; exp: number; text: string }[] = [];
  let total = 2;
  mem.forEach((rec, key) => {
    // Too old to serve; kept in memory only for staleIfError this session.
    if (!isRetained(rec, now)) return;
    let text = fragments.get(key);
    if (text === undefined) {
      try {
        text = `${JSON.stringify(key)}:${JSON.stringify(rec)}`;
      } catch {
        return; // Not serialisable (cyclic): memory-only, as before.
      }
      fragments.set(key, text);
    }
    if (text.length > MAX_ENTRY_CHARS) return;
    parts.push({ key, exp: rec.exp, text });
    total += text.length + 1;
  });
  if (total > budget) {
    parts.sort((a, b) => a.exp - b.exp);
    let dropped = 0;
    while (total > budget && dropped < parts.length) {
      const { key, text } = parts[dropped++];
      total -= text.length + 1;
      mem.delete(key);
      fragments.delete(key);
    }
    parts.splice(0, dropped);
  }
  return `{${parts.map((part) => part.text).join(',')}}`;
}

/**
 * Write now. Synchronous up to the store call on purpose: on web
 * writeStore reaches localStorage.setItem before its first await, so a
 * pagehide / visibilitychange handler that calls this really does persist.
 */
function persistNow(): Promise<boolean> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  // Writing before the stored blob was read would replace it with a partial one.
  if (!loaded) return Promise.resolve(false);
  try {
    const payload = serialize(Date.now(), MAX_PERSIST_CHARS);
    return writeStore(CACHE_FILE, payload)
      .then((ok) => ok || writeStore(CACHE_FILE, serialize(Date.now(), MAX_PERSIST_CHARS / 2)))
      .catch(() => false);
  } catch {
    // Ignore cache write issues to avoid blocking request flow.
    return Promise.resolve(false);
  }
}

function installFlushHooks() {
  if (flushHooksInstalled) return;
  flushHooksInstalled = true;
  // React Native defines `window` without addEventListener; native relies on
  // the debounce alone, which loses at most the last second of cache.
  const win = typeof window !== 'undefined' ? window : undefined;
  if (!win || typeof win.addEventListener !== 'function') return;
  const flush = () => {
    if (persistTimer !== null) void persistNow();
  };
  win.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

function schedulePersist() {
  installFlushHooks();
  if (persistTimer !== null) return;
  // A bare JS context with no timers (the unit tests' vm sandboxes) writes
  // through, which is what every write did before the debounce existed.
  if (typeof setTimeout !== 'function') {
    void persistNow();
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

function store(key: string, value: unknown, ttlMs: number) {
  mem.set(key, { value, exp: Date.now() + ttlMs });
  fragments.delete(key);
}

/** Run `fetcher` for `key`, or join the run already in flight; stores only a resolved value. */
function load<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const startedIn = generation;
  const promise = (async () => {
    const fresh = await fetcher();
    if (startedIn === generation) {
      store(key, fresh, ttlMs);
      schedulePersist();
    }
    return fresh;
  })();
  inflight.set(key, promise);
  const settle = () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  promise.then(settle, settle);
  return promise;
}

function notifyRefreshed(key: string) {
  refreshListeners.forEach((listener) => {
    try {
      listener(key);
    } catch {
      // A broken listener must not stop the others.
    }
  });
}

/**
 * Called with the key after a background refresh stored a newer value than
 * the stale one a screen was just given. Screens that care about the very
 * latest (a chapter list) can re-read on it; returns an unsubscribe.
 */
export function onCacheRefresh(listener: (key: string) => void): () => void {
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}

/** Fresh values only; a stale entry reads as missing, exactly as before. */
export async function getCachedValue<T>(key: string): Promise<T | null> {
  await ensureLoaded();
  const hit = mem.get(key);
  if (!isFresh(hit)) return null;
  return hit!.value as T;
}

/**
 * Store and persist straight away. Unlike loader results this path carries
 * user state (pass receipts, price alerts), and its callers expect it on disk
 * when the promise resolves; with one serialised fragment per entry the write
 * no longer re-serialises the rest of the cache.
 */
export async function setCachedValue<T>(key: string, value: T, ttlMs: number): Promise<void> {
  await ensureLoaded();
  store(key, value, ttlMs);
  await persistNow();
}

/**
 * The cached value for `key`, loading it with `fetcher` when needed:
 * - fresh: returned as is;
 * - stale but within STALE_GRACE_MS: returned at once, and refreshed in the
 *   background (failures there are ignored and cache nothing) — except a
 *   chapter list (REVALIDATE_FIRST), which waits like a missing one;
 * - missing or older: waits for `fetcher`; if that throws and
 *   `staleIfError` is set, the old value is returned instead of the error.
 * Concurrent calls for one key share a single fetch.
 */
export async function getOrSetCached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts?: { staleIfError?: boolean },
): Promise<T> {
  await ensureLoaded();
  const now = Date.now();
  const hit = mem.get(key);
  if (isFresh(hit, now)) return hit!.value as T;
  if (isRetained(hit, now) && !REVALIDATE_FIRST.test(key)) {
    if (!inflight.has(key)) {
      load(key, ttlMs, fetcher).then(() => notifyRefreshed(key), () => {});
    }
    return hit!.value as T;
  }

  try {
    return await load(key, ttlMs, fetcher);
  } catch (error) {
    if (opts?.staleIfError && hit) return hit.value as T;
    throw error;
  }
}

export async function getApiCacheSizeBytes(): Promise<number> {
  try {
    if (persistTimer !== null) await persistNow();
    const raw = await readStore(CACHE_FILE);
    // Byte length of the stored payload — equivalent to the old file size, and
    // the only measure available on web where there is no file to stat.
    return raw ? new Blob([raw]).size : 0;
  } catch {
    return 0;
  }
}

export async function clearApiCache(): Promise<void> {
  try {
    generation += 1;
    mem.clear();
    fragments.clear();
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await removeStore(CACHE_FILE);
  } catch {
    // Ignore cache clear failures.
  }
}
