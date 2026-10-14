import { readStore, writeStore } from '@/lib/kv-store';

/**
 * Recent searches, kept on this device only (never synced: what someone
 * searched for is nobody else's business).
 *
 * The web search kept five in its own localStorage key and native kept none
 * (the old stack search screen showed four hard-coded titles), so recents
 * vanished between platforms and on every native launch. Both now share this
 * list through lib/kv-store. A query is remembered when it was clearly meant:
 * submitted, or a result / "See all" was opened from it — not per keystroke.
 */

const STORE = 'sakura_recent_searches.json';
/** The web catalogue's previous key; imported once so nobody loses their list. */
const LEGACY_WEB_KEY = 'sakura-searches-v1';
export const MAX_RECENT_SEARCHES = 8;
const MAX_CHARS = 80;

let cache: string[] | null = null;
let loading: Promise<string[]> | null = null;
const listeners = new Set<(list: string[]) => void>();

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) : '';
}

/** Pure: put `query` first, drop case-insensitive repeats, cap the list. */
export function withRecentSearch(list: readonly string[], query: string, max = MAX_RECENT_SEARCHES): string[] {
  const value = clean(query);
  if (value.length < 2) return list.slice(0, max);
  const lower = value.toLowerCase();
  return [value, ...list.filter((item) => item.toLowerCase() !== lower)].slice(0, max);
}

export function sanitizeRecentSearches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  let out: string[] = [];
  // Oldest last, so fold from the end to keep the original order on dedupe.
  for (let i = value.length - 1; i >= 0; i--) out = withRecentSearch(out, clean(value[i]));
  return out;
}

function legacyWebList(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(LEGACY_WEB_KEY);
    return raw ? sanitizeRecentSearches(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function dropLegacyWebList(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_WEB_KEY);
  } catch {
    // Storage blocked: nothing was migrated either, so nothing is lost.
  }
}

function emit(list: string[]) {
  cache = list;
  listeners.forEach((fn) => {
    try {
      fn(list);
    } catch {
      // A broken listener must not stop the others.
    }
  });
}

async function persist(list: string[]) {
  emit(list);
  await writeStore(STORE, JSON.stringify(list));
}

export function loadRecentSearches(): Promise<string[]> {
  if (cache) return Promise.resolve(cache);
  if (loading) return loading;
  loading = (async () => {
    let list: string[] = [];
    try {
      const raw = await readStore(STORE);
      list = raw ? sanitizeRecentSearches(JSON.parse(raw)) : [];
    } catch {
      list = [];
    }
    if (!list.length) {
      const legacy = legacyWebList();
      if (legacy.length) {
        list = legacy;
        // Retire the old key only once the list is safely in its new home; a
        // failed write (quota) leaves it to migrate on the next launch.
        if (await writeStore(STORE, JSON.stringify(list))) dropLegacyWebList();
      } else {
        dropLegacyWebList();
      }
    }
    // A write that raced this first read wins (it already includes newer state).
    if (!cache) emit(list);
    loading = null;
    return cache || list;
  })();
  return loading;
}

/** What is known right now, for a first render without a flash; null before the first load. */
export function peekRecentSearches(): string[] | null {
  return cache;
}

/**
 * Applies `change` to the current list and stores the result. The list is
 * read from memory in the same synchronous step that replaces it (persist →
 * emit), so two calls in one tick — Enter, then a result tap — build on each
 * other instead of both starting from the same snapshot and dropping one.
 */
async function update(change: (list: string[]) => string[]): Promise<void> {
  const loaded = await loadRecentSearches();
  const list = cache ?? loaded;
  const next = change(list);
  if (next.length === list.length && next.every((item, i) => item === list[i])) return;
  await persist(next);
}

export function rememberSearch(query: string): Promise<void> {
  return update((list) => withRecentSearch(list, query));
}

export function removeRecentSearch(query: string): Promise<void> {
  const lower = clean(query).toLowerCase();
  return update((list) => list.filter((item) => item.toLowerCase() !== lower));
}

export function clearRecentSearches(): Promise<void> {
  return update(() => []);
}

export function subscribeRecentSearches(fn: (list: string[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
