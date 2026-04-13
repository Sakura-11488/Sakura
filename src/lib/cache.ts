/**
 * Two-tier cache: L1 = in-memory Map (fast), L2 = localStorage (persists across reloads).
 * Both layers use TTL. L2 is populated on every write and checked on L1 miss.
 */

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

const L1 = new Map<string, CacheEntry<any>>();
const L2_PREFIX = 'skr_cache_';
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

function l2Get<T>(key: string): CacheEntry<T> | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(L2_PREFIX + key);
        if (!raw) return null;
        return JSON.parse(raw) as CacheEntry<T>;
    } catch {
        return null;
    }
}

function l2Set<T>(key: string, entry: CacheEntry<T>): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(L2_PREFIX + key, JSON.stringify(entry));
    } catch {
        // localStorage full — evict oldest cache entries
        try {
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k?.startsWith(L2_PREFIX)) keys.push(k);
            }
            keys.slice(0, Math.max(1, Math.floor(keys.length / 4))).forEach(k => localStorage.removeItem(k));
            localStorage.setItem(L2_PREFIX + key, JSON.stringify(entry));
        } catch { /* give up silently */ }
    }
}

export function cacheGet<T>(key: string): T | null {
    const l1 = L1.get(key);
    if (l1) {
        if (Date.now() > l1.expiresAt) { L1.delete(key); }
        else return l1.data as T;
    }

    const l2 = l2Get<T>(key);
    if (l2) {
        if (Date.now() > l2.expiresAt) {
            try { localStorage.removeItem(L2_PREFIX + key); } catch {}
            return null;
        }
        L1.set(key, l2);
        return l2.data;
    }

    return null;
}

export function cacheSet<T>(key: string, data: T, ttl = DEFAULT_TTL): void {
    const entry: CacheEntry<T> = { data, expiresAt: Date.now() + ttl };
    L1.set(key, entry);
    l2Set(key, entry);
}

/**
 * Wraps an async fetch function with caching.
 * If cached data exists and isn't expired, returns it immediately.
 * Otherwise calls fetchFn, caches the result, and returns it.
 */
export async function cacheWrap<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl = DEFAULT_TTL
): Promise<T> {
    const cached = cacheGet<T>(key);
    if (cached !== null) return cached;

    const data = await fetchFn();
    const isEmpty = Array.isArray(data) && data.length === 0;
    if (!isEmpty) {
        cacheSet(key, data, ttl);
    }
    return data;
}
