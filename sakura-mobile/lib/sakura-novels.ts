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

/**
 * Which table a novel came from.
 *
 * Two systems grew separately and never met. `novels` is the older, curated one
 * — three hand-inserted rows, one of which the reader could open because it was
 * also hardcoded here. `creator_works` is what the actual upload screen at
 * /creator-upload writes, and creators have been using it: nine novels, six of
 * them published and public, including one with 8,598 characters of chapter
 * text that nobody could read because the reader only ever looked at `novels`.
 *
 * So both are resolved. On a slug collision `novels` wins, being the curated
 * side, but in practice their slugs differ.
 */
export type NovelSource = 'novels' | 'creator_works';

export interface SakuraNovelRow {
  source: NovelSource;
  id: string;
  slug: string;
  title: string;
  description: string;
  cover_url: string;
  genres: string[];
  status: string;
  creator_wallet: string;
}

/**
 * Cover for a creator work. Mirrors workCoverUrl in lib/creator.ts rather than
 * importing it — that module pulls in the whole creator API surface, and this
 * one sits on the novel reader's hot path.
 *
 * The empty-string check matters: legacy rows carry cover_url: "", and returning
 * that renders a blank image instead of falling through to cover_path.
 */
function creatorWorkCover(meta: Record<string, unknown> | null): string {
  const m = meta ?? {};
  const direct = typeof m.cover_url === 'string' ? m.cover_url.trim() : '';
  if (direct) return direct;
  const path = typeof m.cover_path === 'string' ? m.cover_path.trim() : '';
  if (!path) return '';
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
  return `${base}/storage/v1/object/public/creator-covers/${path}`;
}

let indexCache: Map<string, SakuraNovelRow> | null = null;
let indexFetchedAt = 0;
let inflight: Promise<Map<string, SakuraNovelRow>> | null = null;

async function loadIndex(force = false): Promise<Map<string, SakuraNovelRow>> {
  const fresh = indexCache && Date.now() - indexFetchedAt < INDEX_TTL_MS;
  if (!force && fresh) return indexCache!;
  if (inflight) return inflight;

  inflight = (async () => {
    const [curated, creator] = await Promise.all([
      supabase
        .from('novels')
        .select('id, slug, title, description, cover_url, genres, status, creator_wallet')
        .eq('published', true),
      supabase
        .from('creator_works')
        .select('id, slug, title, description, genres, series_status, creator_wallet, release_metadata')
        .eq('kind', 'novel')
        .eq('publication_status', 'published')
        .eq('visibility', 'public'),
    ]);

    if (curated.error && creator.error) {
      // Serve a stale index rather than pretending our own novels are external
      // — falling through to the scraper would 404 and look like the novel had
      // been deleted.
      if (indexCache) return indexCache;
      throw curated.error;
    }

    const map = new Map<string, SakuraNovelRow>();

    // Creator works first, so a curated row of the same slug overwrites it.
    for (const row of creator.data ?? []) {
      const r = row as Record<string, unknown>;
      const slug = String(r.slug ?? '').toLowerCase();
      if (!slug) continue;
      map.set(slug, {
        source: 'creator_works',
        id: String(r.id),
        slug,
        title: String(r.title ?? ''),
        description: String(r.description ?? ''),
        cover_url: creatorWorkCover(r.release_metadata as Record<string, unknown> | null),
        genres: Array.isArray(r.genres) ? (r.genres as string[]) : [],
        status: String(r.series_status ?? 'ongoing'),
        creator_wallet: String(r.creator_wallet ?? ''),
      });
    }

    for (const row of curated.data ?? []) {
      const r = row as Record<string, unknown>;
      const slug = String(r.slug ?? '').toLowerCase();
      if (!slug) continue;
      map.set(slug, {
        source: 'novels',
        id: String(r.id),
        slug,
        title: String(r.title ?? ''),
        description: String(r.description ?? ''),
        cover_url: String(r.cover_url ?? ''),
        genres: Array.isArray(r.genres) ? (r.genres as string[]) : [],
        status: String(r.status ?? 'ongoing'),
        creator_wallet: String(r.creator_wallet ?? ''),
      });
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

  let chapters: AllNovelChapter[] = [];

  if (meta.source === 'creator_works') {
    // Chapters live in work_releases, keyed by sequence_number, with the prose
    // in body_text. Only published+public releases, so a creator's unreleased
    // chapter does not appear the moment they save it.
    const { data, error } = await supabase
      .from('work_releases')
      .select('id, sequence_number, title, published_at')
      .eq('work_id', meta.id)
      .eq('publication_status', 'published')
      .eq('visibility', 'public')
      .order('sequence_number', { ascending: true });
    if (error) throw error;
    chapters = (data ?? []).map((row) => ({
      path: sakuraChapterPath(slug, String(row.id)),
      name: row.title || `Chapter ${row.sequence_number}`,
      chapterNumber: row.sequence_number,
      releaseTime: (row.published_at as string | null) ?? null,
    }));
  } else {
    const { data, error } = await supabase
      .from('novel_chapters')
      .select('id, chapter_number, title, release_time')
      .eq('novel_id', meta.id)
      .eq('published', true)
      .order('chapter_number', { ascending: true });
    if (error) throw error;
    chapters = (data ?? []).map((row) => ({
      path: sakuraChapterPath(slug, String(row.id)),
      name: row.title || `Chapter ${row.chapter_number}`,
      chapterNumber: row.chapter_number,
      releaseTime: (row.release_time as string | null) ?? null,
    }));
  }

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

  if (meta.source === 'creator_works') {
    const { data, error } = await supabase
      .from('work_releases')
      .select('body_text')
      .eq('id', parsed.chapterId)
      .eq('work_id', meta.id)
      .eq('publication_status', 'published')
      .eq('visibility', 'public')
      .maybeSingle();
    if (error) throw error;
    if (!data?.body_text) return null;
    return String(data.body_text);
  }

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
