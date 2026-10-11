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

/** Resolve a fresh signed URL for each playback attempt; never persist it in a content cache. */
export async function fetchBrowserAnimeStream(request: AnimeStreamRequest): Promise<StreamingSource | null> {
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
