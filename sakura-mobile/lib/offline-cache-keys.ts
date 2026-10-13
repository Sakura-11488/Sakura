import type { ScrapedSource } from '@/lib/scraped-sources';

/**
 * Where web offline downloads live, in one place.
 *
 * These constants are shared by the two web stores that WRITE them
 * (lib/scraped-offline.web.ts, lib/novel-offline.web.ts), the exporter that
 * READS them (lib/offline-export.web.ts), and — by name — web/public/sw.js,
 * which serves the page URLs.
 *
 * They are here rather than duplicated because a drift between writer and
 * reader is invisible: the write succeeds, the read misses, and the user is
 * told they have no downloads. The service worker's copy of these strings is
 * the one genuine duplication, and it cannot be avoided — a service worker is a
 * separate script with no access to the app bundle — so if you change the
 * prefix here, change it in web/public/sw.js too.
 */

/**
 * One cache for everything the user downloaded.
 *
 * NEVER add a version suffix that changes between releases. This is user data,
 * not build output, and web/public/sw.js deliberately sweeps only
 * `sakura-shell-*` on activate so this survives every deploy.
 */
export const LIBRARY_CACHE = 'sakura-offline-v1';

/** Must sit inside the service worker's scope (/app/) to be interceptable. */
export const OFFLINE_PREFIX = '/app/__offline/';

export const IMAGE_MANIFEST_URL = `${OFFLINE_PREFIX}manifest.json`;
export const NOVEL_MANIFEST_URL = `${OFFLINE_PREFIX}novel-manifest.json`;

export const ANIME_MANIFEST_URL = `${OFFLINE_PREFIX}anime-manifest.json`;

/** atsu (the default manga source) — lib/manga-offline.web.ts. */
export const MANGA_MANIFEST_URL = `${OFFLINE_PREFIX}manga-manifest.json`;

const NOVEL_PREFIX = `${OFFLINE_PREFIX}novel/`;
const ANIME_PREFIX = `${OFFLINE_PREFIX}anime/`;
const MANGA_PREFIX = `${OFFLINE_PREFIX}atsu/`;
const TITLE_PREFIX = `${OFFLINE_PREFIX}title/`;
const COVER_PREFIX = `${OFFLINE_PREFIX}cover/`;

/**
 * Same-origin URL for one downloaded episode.
 *
 * Deliberately carries NO file extension. components/anime/WebVideoPlayer.web.tsx
 * routes to hls.js when the URL looks like a playlist, and an extension-less URL
 * falls through to the plain <video> path — which is what a progressive MP4
 * wants. The content type comes from the stored Response's own headers.
 */
export function offlineEpisodeUrl(animeId: string, episodeId: string): string {
  return `${ANIME_PREFIX}${encodeURIComponent(animeId)}/${encodeURIComponent(episodeId)}`;
}

/**
 * One file of a downloaded HLS episode: the rewritten `index.m3u8`, a segment,
 * a key or a caption track. Lives one level below offlineEpisodeUrl, so an
 * HLS download and a progressive one for the same episode never share a key.
 * The `.m3u8` name is load-bearing: WebVideoPlayer.web.tsx routes to hls.js
 * on that extension.
 */
export function offlineEpisodeFileUrl(animeId: string, episodeId: string, name: string): string {
  return `${offlineEpisodeUrl(animeId, episodeId)}/${encodeURIComponent(name)}`;
}

/** Same-origin URL for one downloaded atsu page. The service worker serves these. */
export function offlineMangaPageUrl(mangaId: string, chapterId: string, index: number): string {
  const seg = [mangaId, chapterId].map(encodeURIComponent).join('/');
  return `${MANGA_PREFIX}${seg}/${String(index).padStart(4, '0')}`;
}

/**
 * Title snapshot (detail + chapter list) for a series with downloads, so its
 * page renders with no network. `source` is 'atsu' or a ScrapedSource.
 */
export function offlineTitleUrl(source: string, contentId: string): string {
  return `${TITLE_PREFIX}${encodeURIComponent(source)}/${encodeURIComponent(contentId)}.json`;
}

/** Cover bytes for a title snapshot. Extension-less; the stored Response carries the type. */
export function offlineCoverUrl(source: string, contentId: string): string {
  return `${COVER_PREFIX}${encodeURIComponent(source)}/${encodeURIComponent(contentId)}`;
}

/** Same-origin URL for one downloaded page. The service worker serves these. */
export function offlinePageUrl(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
  index: number,
): string {
  const seg = [source, contentId, chapterId].map(encodeURIComponent).join('/');
  return `${OFFLINE_PREFIX}${seg}/${String(index).padStart(4, '0')}`;
}

/** Same-origin URL for one downloaded novel chapter's text. */
export function offlineNovelUrl(novelPath: string, chapterPath: string): string {
  return `${NOVEL_PREFIX}${encodeURIComponent(novelPath)}/${encodeURIComponent(chapterPath)}`;
}

export async function openOfflineLibrary(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(LIBRARY_CACHE);
  } catch {
    return null;
  }
}
