import type { AllNovelDetail, AllNovelChapter } from '@/lib/allnovel';
import { supabase } from '@/lib/supabase';

/**
 * Sakura's own novels, resolved from the database.
 *
 * This file used to be a hardcoded object literal containing exactly one novel
 * — title, author, rating, genres, summary and cover URL all typed in by hand —
 * behind `new Set(['humour-me'])`. That is why only one novel was ever readable
 * and why nothing else "uploaded that way": the working example was not an
 * upload, it was a constant. Adding a second novel meant editing this file and
 * shipping a build.
 *
 * Novels now come from the `novels` table, keyed by a `slug` column. HUMOR ME
 * kept the slug `humour-me` on purpose: /app/novel/ext?path=humour-me is a live
 * URL and breaking it to tidy a spelling would be a poor trade.
 *
 * The index is cached because it sits on the hot path: every novel open asks
 * "is this one of ours, or does it belong to the external scraper?", and that
 * question should not cost a round trip per chapter.
 */

const INDEX_TTL_MS = 5 * 60 * 1000;

export interface SakuraNovelRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  cover_url: string;
  genres: string[];
  status: string;
  creator_wallet: string;
}

let indexCache: Map<string, SakuraNovelRow> | null = null;
let indexFetchedAt = 0;
let inflight: Promise<Map<string, SakuraNovelRow>> | null = null;

async function loadIndex(force = false): Promise<Map<string, SakuraNovelRow>> {
  const fresh = indexCache && Date.now() - indexFetchedAt < INDEX_TTL_MS;
  if (!force && fresh) return indexCache!;
  if (inflight) return inflight;

  inflight = (async () => {
    const { data, error } = await supabase
      .from('novels')
      .select('id, slug, title, description, cover_url, genres, status, creator_wallet')
      .eq('published', true);

    if (error) {
      // Serve a stale index rather than pretending our own novels are external
      // — falling through to the scraper would 404 and look like the novel had
      // been deleted.
      if (indexCache) return indexCache;
      throw error;
    }

    const map = new Map<string, SakuraNovelRow>();
    for (const row of data ?? []) {
      const slug = String((row as SakuraNovelRow).slug ?? '').toLowerCase();
      if (slug) map.set(slug, row as SakuraNovelRow);
    }
    indexCache = map;
    indexFetchedAt = Date.now();
    return map;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Warm the index — call when a novel list renders, so opening one is instant. */
export async function primeSakuraNovelIndex(): Promise<void> {
  await loadIndex().catch(() => undefined);
}

/** Drop the cache, e.g. right after a creator publishes. */
export function invalidateSakuraNovelIndex(): void {
  indexCache = null;
  indexFetchedAt = 0;
}

/**
 * Synchronous best-effort check against the warm cache.
 *
 * Only safe for cosmetic decisions — hiding an "external source" badge, say.
 * Anything load-bearing must use the async fetchers, which consult the database
 * and cannot answer wrongly just because the cache is cold.
 */
export function isSakuraNovelPath(path: string): boolean {
  return !!indexCache?.has(String(path ?? '').toLowerCase());
}

export function isSakuraChapterPath(chapterPath: string): boolean {
  const parsed = parseSakuraChapterPath(chapterPath);
  return !!parsed && isSakuraNovelPath(parsed.novelPath);
}

export function parseSakuraChapterPath(
  chapterPath: string,
): { novelPath: string; chapterId: string } | null {
  const match = String(chapterPath ?? '').match(/^([^/]+)\/chapter\/([^/]+)$/);
  if (!match) return null;
  return { novelPath: match[1], chapterId: match[2] };
}

export function sakuraChapterPath(novelPath: string, chapterId: string): string {
  return `${novelPath}/chapter/${chapterId}`;
}

async function authorName(wallet: string): Promise<string> {
  if (!wallet) return 'Sakura Original';
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('display_name')
      .eq('wallet_address', wallet)
      .maybeSingle();
    const name = (data?.display_name as string | undefined)?.trim();
    return name || 'Sakura Original';
  } catch {
    return 'Sakura Original';
  }
}

/**
 * Detail for one of our novels, or null if the slug is not ours.
 *
 * Returning null rather than throwing is what lets the caller fall through to
 * the external scraper without knowing anything about how we store novels.
 */
export async function fetchSakuraNovelDetail(novelPath: string): Promise<AllNovelDetail | null> {
  const slug = String(novelPath ?? '').toLowerCase();
  if (!slug) return null;

  let index = await loadIndex().catch(() => null);
  if (!index) return null;

  // A miss on a warm index may just mean the novel was published since we last
  // looked. Re-check once before handing the path to the scraper.
  if (!index.has(slug) && Date.now() - indexFetchedAt > 10_000) {
    index = await loadIndex(true).catch(() => index);
  }

  const meta = index?.get(slug);
  if (!meta) return null;

  const { data, error } = await supabase
    .from('novel_chapters')
    .select('id, chapter_number, title, release_time')
    .eq('novel_id', meta.id)
    .eq('published', true)
    .order('chapter_number', { ascending: true });

  if (error) throw error;

  const chapters: AllNovelChapter[] = (data ?? []).map((row) => ({
    path: sakuraChapterPath(slug, String(row.id)),
    name: row.title || `Chapter ${row.chapter_number}`,
    chapterNumber: row.chapter_number,
    releaseTime: (row.release_time as string | null) ?? null,
  }));

  return {
    path: slug,
    name: meta.title,
    cover: meta.cover_url || undefined,
    author: await authorName(meta.creator_wallet),
    genres: Array.isArray(meta.genres) ? meta.genres.join(', ') : undefined,
    status: meta.status,
    summary: meta.description || undefined,
    chapters,
  };
}

/** Chapter text for one of our novels, or null if the path is not ours. */
export async function fetchSakuraChapterContent(chapterPath: string): Promise<string | null> {
  const parsed = parseSakuraChapterPath(chapterPath);
  if (!parsed) return null;

  const slug = parsed.novelPath.toLowerCase();
  const index = await loadIndex().catch(() => null);
  const meta = index?.get(slug);
  if (!meta) return null;

  const { data, error } = await supabase
    .from('novel_chapters')
    .select('content')
    .eq('id', parsed.chapterId)
    .eq('novel_id', meta.id)
    .eq('published', true)
    .maybeSingle();

  if (error) throw error;
  if (!data?.content) return null;
  return String(data.content);
}
