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

const NOVEL_PREFIX = `${OFFLINE_PREFIX}novel/`;
const ANIME_PREFIX = `${OFFLINE_PREFIX}anime/`;

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
