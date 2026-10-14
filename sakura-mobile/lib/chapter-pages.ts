import type { MangaChapter } from '@/lib/manga';
import { fetchMangaChapters, fetchMangaChapterPages, toPageUrl } from '@/lib/manga';
import { atsuFetch } from '@/lib/atsu-fetch';
import { getWebMangaPageProxyUrl } from '@/lib/content-proxy-client';
import { readStore, writeStore } from '@/lib/kv-store';
import { getOfflineMapForManga, getOfflineMangaPageUris } from '@/lib/manga-offline';
import { getScrapedOfflineMap, getScrapedOfflinePageUris } from '@/lib/scraped-offline';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { normalizeChaptersForReading } from '@/lib/chapter-order';
import { isOnline } from '@/lib/use-online';

/**
 * One way to load a chapter, whatever backs it.
 *
 * The reader used to inline a four-branch ternary over
 * (offline? × external? × hentai?) at its single load site. Continuous reading
 * needs to load *neighbouring* chapters too, so that logic has to be callable
 * rather than inlined — and once it is callable, the branch on the route's
 * `offline` param stops making sense.
 */

export interface LoadedChapterPages {
  urls: string[];
  origin: 'offline' | 'network';
  /**
   * Natural page sizes, index-aligned with urls, when the source states them
   * (atsu's read/chapter does, per page). Lets the reader lay out every row at
   * its real height before a single image has loaded — which is what makes a
   * resume land exactly on page 60 instead of crawling there.
   */
  sizes?: Array<PageSizeHint | null>;
}

export type PageSizeHint = { width: number; height: number };

type NetworkPageList = { urls: string[]; sizes?: Array<PageSizeHint | null> };

function sizeHint(width: unknown, height: unknown): PageSizeHint | null {
  const w = Number(width);
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * atsu's page list with each page's size. The same request
 * fetchMangaChapterPages makes (and the same URL mapping), but that function
 * keeps only the URLs and lib/manga.ts is not this module's to change. Any
 * miss falls back to it, which also covers its MangaDex route on native.
 */
async function fetchAtsuPageList(mangaId: string, chapterId: string): Promise<NetworkPageList> {
  try {
    const res = await atsuFetch(
      `/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
    );
    if (res.ok) {
      const json = await res.json();
      const raw: unknown = json?.readChapter?.pages;
      if (Array.isArray(raw)) {
        const urls: string[] = [];
        const sizes: Array<PageSizeHint | null> = [];
        for (const page of raw) {
          const row = page as { image?: unknown; width?: unknown; height?: unknown } | string | null;
          const path = typeof row === 'string' ? row : typeof row?.image === 'string' ? row.image : '';
          if (!path) continue;
          urls.push(getWebMangaPageProxyUrl(toPageUrl(path)));
          sizes.push(typeof row === 'object' && row ? sizeHint(row.width, row.height) : null);
        }
        if (urls.length) return { urls, ...(sizes.some(Boolean) ? { sizes } : {}) };
      }
    }
  } catch {
    // Fall through: the shared fetcher retries atsu and then its fallbacks.
  }
  return { urls: await fetchMangaChapterPages(mangaId, chapterId) };
}

/**
 * Network page lists, kept in memory for a short while.
 *
 * Opening a chapter cost a page-list request every time (POST read/chapter,
 * ~600 ms plus a ~220 ms CORS preflight on the live site) before the first
 * image could even be requested, and atsu's list was never cached at all. With
 * this, the title page can fetch the Start/Continue chapter's list ahead of the
 * tap, the reader can fetch the next chapter's near the end of this one, and
 * the reader's own load finds the answer here.
 *
 * Memory only, and short: MangaDex's at-home base URLs (the native fallback)
 * expire after about 15 minutes, so a list older than PAGE_LIST_TTL_MS is
 * fetched again rather than trusted.
 */
const PAGE_LIST_TTL_MS = 10 * 60 * 1000;
/** A chapter list is a few dozen URLs; this many covers any reading session. */
const MAX_PAGE_LISTS = 24;
/**
 * A request still out after this long is not joined: the proxy call has no
 * timeout, and a hung one shared indefinitely kept the chapter loading on
 * every reopen, where before each open asked again.
 */
const INFLIGHT_MAX_AGE_MS = 15_000;
const pageLists = new Map<string, NetworkPageList & { at: number }>();
const pageListsInflight = new Map<string, { request: Promise<NetworkPageList>; at: number }>();

function pageListKey(source: string | null | undefined, contentId: string, chapterId: string): string {
  return `${getScrapedAdapter(source)?.key ?? 'atsu'}:${contentId}:${chapterId}`;
}

/**
 * A chapter's page URLs from the network, through the memory cache above.
 * `fresh` skips the cache (and any request already out) and stores the new
 * answer; empty answers are never stored, so a failure is retried next time.
 */
function networkPageList(
  source: string | null | undefined,
  contentId: string,
  chapterId: string,
  fresh: boolean,
): Promise<NetworkPageList> {
  const key = pageListKey(source, contentId, chapterId);
  if (!fresh) {
    const hit = pageLists.get(key);
    if (hit && Date.now() - hit.at < PAGE_LIST_TTL_MS) return Promise.resolve(hit);
    const pending = pageListsInflight.get(key);
    if (pending && Date.now() - pending.at < INFLIGHT_MAX_AGE_MS) return pending.request;
  }
  const adapter = getScrapedAdapter(source);
  const request = (async (): Promise<NetworkPageList> => {
    const list: NetworkPageList = adapter
      ? { urls: (await adapter.pages(contentId, chapterId)) || [] }
      : await fetchAtsuPageList(contentId, chapterId);
    // Drop empty URLs, keeping sizes aligned with the URLs that remain.
    const urls: string[] = [];
    const sizes: Array<PageSizeHint | null> = [];
    (list.urls || []).forEach((url, i) => {
      if (!url) return;
      urls.push(url);
      sizes.push(list.sizes?.[i] ?? null);
    });
    const answer: NetworkPageList = { urls, ...(sizes.some(Boolean) ? { sizes } : {}) };
    if (urls.length) {
      pageLists.delete(key);
      pageLists.set(key, { ...answer, at: Date.now() });
      if (pageLists.size > MAX_PAGE_LISTS) {
        const oldest = pageLists.keys().next().value;
        if (oldest !== undefined) pageLists.delete(oldest);
      }
    }
    return answer;
  })();
  pageListsInflight.set(key, { request, at: Date.now() });
  const clear = () => {
    if (pageListsInflight.get(key)?.request === request) pageListsInflight.delete(key);
  };
  request.then(clear, clear);
  return request;
}

const prefetched = new Map<string, { at: number; settled: boolean; result: Promise<string[] | null> }>();

/**
 * Fetch a chapter's page list ahead of opening it, so the reader's load is
 * answered from memory. Resolves the URLs, or null when the chapter is
 * downloaded (the reader reads it from disk, so there is nothing to warm) or
 * the list could not be loaded. Repeated calls within PAGE_LIST_TTL_MS share
 * one result, so callers can ask on every page turn.
 *
 * Callers decide what else to warm: the first page image is platform
 * specific (components/reader/warm-reader-image).
 */
export function prefetchChapterPages(args: {
  contentId: string;
  chapterId: string;
  source?: string | null;
}): Promise<string[] | null> {
  const { contentId, chapterId, source } = args;
  if (!contentId || !chapterId) return Promise.resolve(null);
  const key = pageListKey(source, contentId, chapterId);
  const memo = prefetched.get(key);
  // A settled answer is reused for the list's lifetime; one still out only
  // while it is young enough to be worth waiting on (INFLIGHT_MAX_AGE_MS).
  if (memo && Date.now() - memo.at < (memo.settled ? PAGE_LIST_TTL_MS : INFLIGHT_MAX_AGE_MS)) return memo.result;
  const adapter = getScrapedAdapter(source);
  const result = (async () => {
    const local = adapter
      ? await getScrapedOfflinePageUris(adapter.key, contentId, chapterId).catch(() => null)
      : await getOfflineMangaPageUris(contentId, chapterId).catch(() => null);
    if (local?.length) return null;
    const { urls } = await networkPageList(source, contentId, chapterId, false).catch(
      (): NetworkPageList => ({ urls: [] }),
    );
    return urls.length ? urls : null;
  })();
  const entry = { at: Date.now(), settled: false, result };
  prefetched.set(key, entry);
  // A failure is not remembered: the next page turn may ask again.
  void result.then((urls) => {
    entry.settled = true;
    if (!urls && prefetched.get(key) === entry) prefetched.delete(key);
  });
  if (prefetched.size > MAX_PAGE_LISTS * 2) {
    const oldest = prefetched.keys().next().value;
    if (oldest !== undefined) prefetched.delete(oldest);
  }
  return result;
}

/**
 * Resolve a chapter's page URLs, preferring a local download when one exists.
 *
 * Offline is decided PER CHAPTER by asking the store, not by reading the
 * route's `offline=1` param. Two things fall out of that:
 *
 *  - A session can mix freely. Chapter 12 downloaded and 13 not is normal once
 *    reading flows across boundaries, and the param — fixed at navigation time —
 *    cannot describe it.
 *  - Reopening from Continue Reading stops re-downloading what you already have.
 *    Those entry points push without `offline`, so a downloaded chapter was
 *    silently refetched over the network every time.
 */
export async function loadChapterPages(args: {
  contentId: string;
  chapterId: string;
  source?: string | null;
  /** Set false only to force a fresh network read. */
  preferOffline?: boolean;
}): Promise<LoadedChapterPages> {
  const { contentId, chapterId, source, preferOffline = true } = args;
  const adapter = getScrapedAdapter(source);

  if (preferOffline) {
    const local = adapter
      ? await getScrapedOfflinePageUris(adapter.key, contentId, chapterId).catch(() => null)
      : await getOfflineMangaPageUris(contentId, chapterId).catch(() => null);
    if (local?.length) return { urls: local, origin: 'offline' };
  }

  // A forced read (preferOffline false) also bypasses the memory cache: it is
  // how Retry replaces a list that loaded but pointed at broken pages.
  const { urls, sizes } = await networkPageList(source, contentId, chapterId, !preferOffline);

  return { urls, origin: 'network', ...(sizes ? { sizes } : {}) };
}

// ── Remembered page sizes ────────────────────────────────────────────────
//
// Only atsu states page sizes up front. For manhwa and comics the reader
// measures each image as it loads; remembering those measurements per chapter
// means reopening a chapter (Continue Reading, a refresh, the next session)
// lays every row out at its real height at once, so the resume lands on the
// saved page without rows before it having to load and re-measure.
//
// Rebuildable, so the store name contains "cache": under localStorage quota
// pressure kv-store drops these first, never reading progress.

const SIZE_STORE = 'sakura_page_size_cache.json';
/** Chapters remembered; least recently written dropped first. */
const MAX_SIZE_CHAPTERS = 150;
/** Longest chapter kept (a few manhwa chapters run past 300 slices). */
const MAX_SIZE_PAGES = 500;
const SIZE_WRITE_DELAY_MS = 1500;

/** Flattened [w0, h0, w1, h1, ...]; 0,0 for a page not measured. */
type SizeRow = { at: number; s: number[] };
let sizeStore: Record<string, SizeRow> | null = null;
let sizeStoreLoading: Promise<Record<string, SizeRow>> | null = null;
let sizeWriteTimer: ReturnType<typeof setTimeout> | null = null;

function sizeKeyFor(source: string | null | undefined, contentId: string, chapterId: string): string | null {
  // An adult chapter must leave no trace on the device beyond what the user
  // downloads on purpose.
  if (!contentId || !chapterId || getScrapedAdapter(source)?.adult) return null;
  return pageListKey(source, contentId, chapterId);
}

function loadSizeStore(): Promise<Record<string, SizeRow>> {
  if (sizeStore) return Promise.resolve(sizeStore);
  if (sizeStoreLoading) return sizeStoreLoading;
  sizeStoreLoading = (async () => {
    const out: Record<string, SizeRow> = {};
    try {
      const raw = await readStore(SIZE_STORE);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        for (const [key, row] of Object.entries(parsed as Record<string, SizeRow>)) {
          if (row && typeof row.at === 'number' && Array.isArray(row.s)) out[key] = row;
        }
      }
    } catch {
      // Corrupt or blocked storage: start empty, it is only an optimisation.
    }
    // Measurements taken while the read was out are kept over what was read.
    sizeStore = { ...out, ...(sizeStore ?? {}) };
    sizeStoreLoading = null;
    return sizeStore;
  })();
  return sizeStoreLoading;
}

/** Remembered sizes for a chapter's pages, index-aligned; null when none. */
export async function getRememberedPageSizes(
  source: string | null | undefined,
  contentId: string,
  chapterId: string,
): Promise<Array<PageSizeHint | null> | null> {
  const key = sizeKeyFor(source, contentId, chapterId);
  if (!key) return null;
  const row = (await loadSizeStore())[key];
  if (!row) return null;
  const out: Array<PageSizeHint | null> = [];
  for (let i = 0; i + 1 < row.s.length; i += 2) out.push(sizeHint(row.s[i], row.s[i + 1]));
  return out.some(Boolean) ? out : null;
}

/**
 * Record measured sizes for a chapter (index-aligned; gaps allowed). Merged
 * with what is already known and written after a short quiet period, so a
 * page turn that measures a new image costs nothing on the spot.
 */
export function rememberPageSizes(
  source: string | null | undefined,
  contentId: string,
  chapterId: string,
  sizes: ReadonlyArray<PageSizeHint | null | undefined>,
): void {
  const key = sizeKeyFor(source, contentId, chapterId);
  if (!key || sizes.length === 0) return;
  void loadSizeStore().then((store) => {
    const prev = store[key]?.s ?? [];
    const length = Math.min(MAX_SIZE_PAGES, Math.max(sizes.length, prev.length >> 1));
    const flat = new Array<number>(length * 2).fill(0);
    let changed = !store[key];
    for (let i = 0; i < length; i += 1) {
      const hint = sizes[i] ? sizeHint(sizes[i]!.width, sizes[i]!.height) : null;
      const w = hint ? Math.round(hint.width) : prev[i * 2] || 0;
      const h = hint ? Math.round(hint.height) : prev[i * 2 + 1] || 0;
      if (w !== (prev[i * 2] || 0) || h !== (prev[i * 2 + 1] || 0)) changed = true;
      flat[i * 2] = w;
      flat[i * 2 + 1] = h;
    }
    if (!changed || !flat.some((v) => v > 0)) return;
    delete store[key];
    store[key] = { at: Date.now(), s: flat };
    const keys = Object.keys(store);
    if (keys.length > MAX_SIZE_CHAPTERS) {
      keys
        .sort((a, b) => store[a].at - store[b].at)
        .slice(0, keys.length - MAX_SIZE_CHAPTERS)
        .forEach((k) => delete store[k]);
    }
    if (sizeWriteTimer) clearTimeout(sizeWriteTimer);
    sizeWriteTimer = setTimeout(() => {
      sizeWriteTimer = null;
      void writeStore(SIZE_STORE, JSON.stringify(store)).catch(() => undefined);
    }, SIZE_WRITE_DELAY_MS);
  });
}

/** The series' chapter list from whichever backend owns it, in reading order. */
export async function fetchChapterListForSource(
  source: string | null | undefined,
  contentId: string,
  currentChapterId?: string,
): Promise<MangaChapter[]> {
  const adapter = getScrapedAdapter(source);
  const raw = adapter ? await adapter.chapters(contentId) : await fetchMangaChapters(contentId);
  return normalizeChaptersForReading(raw || [], currentChapterId);
}

/**
 * Chapter list rebuilt from the offline manifest.
 *
 * This is what makes continuous reading work with no network at all — the
 * literal ask was that downloaded chapters flow into each other without the
 * reader noticing a boundary, and it can't flow anywhere if the only source of
 * "what comes next" is an API call that just failed. Only completed downloads
 * count; a half-finished one would present as a readable chapter and then open
 * empty.
 */
export async function fetchOfflineChapterList(
  source: string | null | undefined,
  contentId: string,
  currentChapterId?: string,
): Promise<MangaChapter[]> {
  const adapter = getScrapedAdapter(source);
  const map = adapter
    ? await getScrapedOfflineMap(adapter.key, contentId).catch(() => ({}))
    : await getOfflineMapForManga(contentId).catch(() => ({}));

  const rows = Object.values(map as Record<string, {
    chapterId: string;
    chapterNumber: number;
    chapterTitle?: string;
    status: string;
    pageCount?: number;
  }>);

  const chapters: MangaChapter[] = rows
    .filter((r) => r.status === 'ready')
    .map((r) => ({
      id: r.chapterId,
      number: r.chapterNumber,
      title: r.chapterTitle || `Chapter ${r.chapterNumber}`,
      pageCount: r.pageCount || 0,
      createdAt: '',
    }));

  return normalizeChaptersForReading(chapters, currentChapterId);
}

/**
 * Chapter list for reader navigation: network when reachable, otherwise
 * whatever is on disk. Returns [] when neither yields anything, which the
 * caller should treat as "continuous reading unavailable" rather than an error.
 *
 * When the browser knows it is offline, the downloads are the whole answer:
 * asking the network first only delays the reader behind a request that cannot
 * succeed, and "next chapter" must only offer chapters that will open.
 */
export async function fetchReaderChapterList(
  source: string | null | undefined,
  contentId: string,
  currentChapterId?: string,
): Promise<MangaChapter[]> {
  if (!isOnline()) {
    return fetchOfflineChapterList(source, contentId, currentChapterId).catch(() => [] as MangaChapter[]);
  }

  const online = await fetchChapterListForSource(source, contentId, currentChapterId).catch(
    () => [] as MangaChapter[],
  );
  if (online.length > 1) return online;

  const offline = await fetchOfflineChapterList(source, contentId, currentChapterId).catch(
    () => [] as MangaChapter[],
  );
  // Prefer whichever actually describes a series rather than a single chapter.
  return offline.length > online.length ? offline : online;
}
