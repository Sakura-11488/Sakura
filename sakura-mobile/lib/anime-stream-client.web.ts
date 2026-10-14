import { supabase } from '@/lib/supabase';
import { withAnimeTimeout } from './anime-network';
import type { StreamingSource } from './anime';
import type { AnimeStreamRequest } from './anime-stream-client';

export const usesBrowserAnimeStream = true;

function functionEndpoint(): URL | null {
  const configured = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!configured) return null;
  try {
    const base = new URL(configured);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:'))
      || base.username || base.password || base.search || base.hash) return null;
    return new URL(`${base.href.replace(/\/+$/, '')}/functions/v1/anime-stream`);
  } catch {
    return null;
  }
}

function isSignedProxyUrl(value: unknown, endpoint: URL): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === endpoint.origin && url.pathname === endpoint.pathname
      && !url.username && !url.password && !url.hash
      && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.searchParams.get('token') ?? '');
  } catch {
    return false;
  }
}

function validEmbed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function timing(value: unknown): { start: number; end: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { start, end } = value as Record<string, unknown>;
  return typeof start === 'number' && typeof end === 'number'
    && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
    ? { start, end } : undefined;
}

function readSource(value: unknown, endpoint: URL): StreamingSource | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!isSignedProxyUrl(data.url, endpoint) || data.isM3U8 !== true
    || (data.category !== 'sub' && data.category !== 'dub')) return null;
  const subtitles: NonNullable<StreamingSource['subtitles']> = [];
  if (Array.isArray(data.subtitles)) {
    for (const entry of data.subtitles.slice(0, 32)) {
      if (!entry || typeof entry !== 'object') continue;
      const { url, lang, label } = entry as Record<string, unknown>;
      if (isSignedProxyUrl(url, endpoint) && typeof lang === 'string' && /^[a-z0-9-]{1,35}$/i.test(lang)
        && typeof label === 'string' && label.trim() && label.length <= 100) {
        subtitles.push({ url, lang, label });
      }
    }
  }
  return {
    url: data.url,
    isM3U8: true,
    category: data.category,
    embedUrl: validEmbed(data.embedUrl),
    availableCategories: Array.isArray(data.availableCategories)
      ? [...new Set(data.availableCategories.filter((category): category is 'sub' | 'dub' => category === 'sub' || category === 'dub'))]
      : [data.category],
    intro: timing(data.intro),
    outro: timing(data.outro),
    subtitles: subtitles.length ? subtitles : undefined,
  };
}

/**
 * Lookups started ahead of playback (see prewarmBrowserAnimeStream), keyed by
 * title, episode and audio. Memory only and single use: the signed URLs are
 * valid for two hours server-side, so a ten-minute window is safely inside it,
 * and a retry or a second play always asks again.
 */
const PREWARM_TTL_MS = 10 * 60_000;
const PREWARM_LIMIT = 6;
const prewarmed = new Map<string, { at: number; promise: Promise<StreamingSource | null> }>();
const prewarmKey = (request: Pick<AnimeStreamRequest, 'malId' | 'episode' | 'category'>) =>
  `${request.malId}:${request.episode}:${request.category}`;

function saveDataRequested(): boolean {
  try {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return connection?.saveData === true || navigator.onLine === false;
  } catch {
    return false;
  }
}

/**
 * Resolve an episode's stream before the viewer presses play. The lookup is
 * the first of four serial round trips before a frame shows (lookup, master
 * playlist, media playlist, first segment); doing it during hover, while the
 * detail page settles, or near the end of the previous episode takes ~0.5 s off
 * every start and the autoplay handoff. Skipped when the browser asks to save data.
 */
export function prewarmBrowserAnimeStream(request: Omit<AnimeStreamRequest, 'force'>): void {
  if (saveDataRequested()) return;
  const key = prewarmKey(request);
  const now = Date.now();
  for (const [entryKey, entry] of prewarmed) if (now - entry.at > PREWARM_TTL_MS) prewarmed.delete(entryKey);
  if (prewarmed.has(key)) return;
  while (prewarmed.size >= PREWARM_LIMIT) prewarmed.delete(prewarmed.keys().next().value!);
  const promise = resolveBrowserAnimeStream(request);
  // An unobserved failure must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  prewarmed.set(key, { at: now, promise });
}

/** Resolve a fresh signed URL for each playback attempt; never persist it in a content cache. */
export async function fetchBrowserAnimeStream(request: AnimeStreamRequest): Promise<StreamingSource | null> {
  const key = prewarmKey(request);
  const warm = prewarmed.get(key);
  prewarmed.delete(key);
  if (warm && !request.force && Date.now() - warm.at <= PREWARM_TTL_MS) {
    // A failed warm-up is not an answer; ask again rather than report "no stream".
    const source = await warm.promise.catch(() => null);
    if (source) return source;
  }
  return resolveBrowserAnimeStream(request);
}

async function resolveBrowserAnimeStream(request: AnimeStreamRequest): Promise<StreamingSource | null> {
  const endpoint = functionEndpoint();
  if (!endpoint || !/^[1-9]\d*$/.test(request.malId) || !Number.isSafeInteger(request.episode)
    || request.episode < 1 || (request.category !== 'sub' && request.category !== 'dub')) return null;
  try {
    return await withAnimeTimeout(async (signal) => {
      const { data, error } = await supabase.functions.invoke('anime-stream', {
        body: { malId: request.malId, episode: request.episode, category: request.category, ...(request.force ? { force: true } : {}) },
        signal,
      });
      if (error) {
        const response = error.context;
        if (response?.status === 404 && typeof response.json === 'function') {
          const failure = await response.json().catch(() => null);
          if (failure?.code === 'EPISODE_UNAVAILABLE') {
            return {
              url: '', isM3U8: false, category: request.category,
              unavailableCategory: request.category,
              availableCategories: ['sub', 'dub'],
            };
          }
        }
        return null;
      }
      return readSource(data, endpoint);
    }, 20_000);
  } catch {
    // A missing deployment, timeout, or rejected upstream leaves the existing
    // explicit external-player fallback available to the viewer.
    return null;
  }
}
