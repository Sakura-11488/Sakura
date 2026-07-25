import type { MangaChapter } from '@/lib/manga';
import { fetchMangaChapters, fetchMangaChapterPages } from '@/lib/manga';
import { getOfflineMapForManga, getOfflineMangaPageUris } from '@/lib/manga-offline';
import { getScrapedOfflineMap, getScrapedOfflinePageUris } from '@/lib/scraped-offline';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { normalizeChaptersForReading } from '@/lib/chapter-order';

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

  const urls = adapter
    ? await adapter.pages(contentId, chapterId)
    : await fetchMangaChapterPages(contentId, chapterId);

  return { urls: (urls || []).filter(Boolean), origin: 'network' };
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
 */
export async function fetchReaderChapterList(
  source: string | null | undefined,
  contentId: string,
  currentChapterId?: string,
): Promise<MangaChapter[]> {
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
