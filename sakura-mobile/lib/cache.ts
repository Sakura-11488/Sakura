import { readStore, writeStore, removeStore } from '@/lib/kv-store';

type CacheRecord = {
  exp: number;
  value: unknown;
};

const CACHE_FILE = 'sakura_api_cache.json';
const mem = new Map<string, CacheRecord>();
let loaded = false;
let loadingPromise: Promise<void> | null = null;

function isFresh(rec: CacheRecord | undefined): rec is CacheRecord {
  return !!rec && Date.now() < rec.exp;
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
        if (rec && typeof rec.exp === 'number' && rec.exp > now) {
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

async function persistAll() {
  try {
    const payload: Record<string, CacheRecord> = {};
    mem.forEach((value, key) => {
      if (isFresh(value)) payload[key] = value;
    });
    await writeStore(CACHE_FILE, JSON.stringify(payload));
  } catch {
    // Ignore cache write issues to avoid blocking request flow.
  }
}

export async function getCachedValue<T>(key: string): Promise<T | null> {
  await ensureLoaded();
  const hit = mem.get(key);
  if (!isFresh(hit)) {
    if (hit) mem.delete(key);
    return null;
  }
  return hit.value as T;
}

export async function setCachedValue<T>(key: string, value: T, ttlMs: number): Promise<void> {
  await ensureLoaded();
  mem.set(key, { value, exp: Date.now() + ttlMs });
  await persistAll();
}

export async function getOrSetCached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts?: { staleIfError?: boolean },
): Promise<T> {
  await ensureLoaded();
  const hit = mem.get(key);
  if (isFresh(hit)) return hit.value as T;

  try {
    const fresh = await fetcher();
    mem.set(key, { value: fresh, exp: Date.now() + ttlMs });
    await persistAll();
    return fresh;
  } catch (error) {
    if (opts?.staleIfError && hit) return hit.value as T;
    throw error;
  }
}

export async function getApiCacheSizeBytes(): Promise<number> {
  try {
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
    mem.clear();
    await removeStore(CACHE_FILE);
  } catch {
    // Ignore cache clear failures.
  }
}
