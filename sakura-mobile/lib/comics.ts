import { Platform } from 'react-native';
import { getOrSetCached } from '@/lib/cache';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { MangaDetail, MangaChapter } from '@/lib/manga';
import { comicsProxyFetch } from '@/lib/comics-proxy-fetch';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import { COMICS_PROXY_DEFAULT } from '@/lib/content-hosts';

/**
 * Sakura Comics sources for the Expo app.
 *
 * Mirrors the data shapes returned by `lib/manga.ts` (atsu.moe) so the shared
 * manga detail screen and chapter reader can render comics by passing
 * `source=comics`, without forking the UI. The client only ever talks to the
 * Sakura comics scraper proxy (DigitalOcean droplet); it never hits the
 * upstream comic site directly. React Native fetch has no CORS restrictions,
 * so unlike the web build we don't need a native HTTP bridge here.
 */

export const COMICS_PROXY_BASE = (
  process.env.EXPO_PUBLIC_COMICS_PROXY || COMICS_PROXY_DEFAULT
).replace(/\/+$/, '');

type ProxyListItem = {
  id: string;
  title: string;
  cover?: string | null;
  url?: string | null;
};

type ProxyDetail = ProxyListItem & {
  description?: string | null;
  author?: string | null;
  authors?: string[] | null;
  tags?: string[] | null;
  status?: string | null;
  year?: number | null;
};

type ProxyChapter = {
  id: string;
  title?: string | null;
  number?: number | string | null;
  publishAt?: string | null;
  pages?: number | null;
};

type ProxyListResponse = { items?: ProxyListItem[]; results?: ProxyListItem[] };
type ProxyDetailResponse =
  | { comic?: ProxyDetail | null; manga?: ProxyDetail | null }
  | ProxyDetail;
type ProxyChaptersResponse = { chapters?: ProxyChapter[]; issues?: ProxyChapter[] };
type ProxyPagesResponse = { pages?: string[]; images?: string[] };

async function requestProxy<T>(path: string): Promise<T> {
  return comicsProxyFetch<T>(path);
}

/**
 * Route covers and pages through the droplet's `/img` endpoint so the user
 * always sees what the proxy successfully fetched, regardless of region or
 * upstream Cloudflare edge behaviour.
 */
export function proxyComicImage(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  // Normalize protocol-relative (//host/…) URLs to https before wrapping.
  const abs = url.startsWith('//') ? `https:${url}` : url;
  if (!/^https?:\/\//i.test(abs)) return url;
  // Internet Archive exposes public HTTPS images; using them directly keeps
  // the web reader independent of the legacy droplet's host allowlist.
  try {
    const target = new URL(abs);
    if (target.protocol === 'https:' && (
      (target.hostname === 'archive.org' && target.pathname.startsWith('/services/img/')) ||
      (target.hostname === 'iiif.archive.org' && target.pathname.startsWith('/image/iiif/'))
    )) return abs;
  } catch { /* Continue through the existing comic image proxy. */ }
  const proxied = abs.startsWith(`${COMICS_PROXY_BASE}/img?`)
    ? abs
    : `${COMICS_PROXY_BASE}/img?u=${encodeURIComponent(abs)}`;
  // Droplet is HTTP-only; on the HTTPS web build route through the same-origin
  // media proxy to avoid mixed-content blocking. Native is unaffected.
  return Platform.OS === 'web' ? getWebMediaProxyUrl(proxied) : proxied;
}

function mapListItem(item: ProxyListItem): ContentItem {
  return {
    id: item.id,
    title: item.title || item.id,
    cover: proxyComicImage(item.cover),
    type: 'manga',
    source: 'comics',
  };
}

/**
 * Thrown inside a cached loader so an empty answer is never cached, then
 * turned back into null / [] outside the cache — so callers see exactly what
 * they always did: null / [] for "nothing there", a rejection for a failed
 * request (the detail screen words the two differently). Tagged rather than
 * subclassed: `instanceof` on Error subclasses is unreliable once Babel's
 * class transform has been through them. Same pattern as lib/manhwa.ts.
 */
function emptyAnswer(message: string): Error {
  return Object.assign(new Error(message), { comicsEmptyAnswer: true });
}

function isEmptyAnswer(error: unknown): boolean {
  return !!error && (error as { comicsEmptyAnswer?: unknown }).comicsEmptyAnswer === true;
}

export async function fetchTrendingComics(limit = 24): Promise<ContentItem[]> {
  return getOrSetCached<ContentItem[]>(
    `comics:trending:${limit}`,
    5 * 60 * 1000,
    async () => {
      const data = await requestProxy<ProxyListResponse>(`/popular?limit=${limit}`);
      const items = data.items || data.results || [];
      if (!items.length) throw new Error('Comics are temporarily unavailable. Please try again.');
      return items.map(mapListItem);
    },
    { staleIfError: true },
  );
}

export async function searchComics(query: string, limit = 24): Promise<ContentItem[]> {
  if (!query.trim()) return fetchTrendingComics(limit);
  return getOrSetCached<ContentItem[]>(
    `comics:search:${query.trim().toLowerCase()}:${limit}`,
    10 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ q: query.trim(), limit: String(limit), offset: '0' });
      const data = await requestProxy<ProxyListResponse>(`/search?${params.toString()}`);
      const items = data.items || data.results || [];
      return items.map(mapListItem);
    },
    { staleIfError: true },
  );
}

/*
 * Detail, chapters and pages never cache an empty answer: getOrSetCached keeps
 * whatever a loader returns as fresh for the whole TTL, and the scraper's
 * "nothing" is also what an upstream hiccup behind it looks like, so a cached
 * null / [] pinned a comic on "not found" / no issues / a blank reader for up
 * to an hour. The keys are versioned (v2) because the previous release did
 * cache those under the old keys, and on web that cache lives in localStorage
 * across deploys; a new key strands the poisoned entries until their TTL
 * runs out. Bump the version again whenever a release caches something wrong.
 */
export async function fetchComicDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail>(
    `comics:detail:v2:${id}`,
    30 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id });
      const data = await requestProxy<ProxyDetailResponse>(`/details?${params.toString()}`);
      const detail =
        (data as { comic?: ProxyDetail }).comic ||
        (data as { manga?: ProxyDetail }).manga ||
        (data as ProxyDetail);
      if (!detail || !detail.id) throw emptyAnswer('Comic not found.');
      const authors =
        Array.isArray(detail.authors) && detail.authors.length
          ? detail.authors.join(', ')
          : detail.author || '';
      return {
        id: detail.id,
        title: detail.title || detail.id,
        cover: proxyComicImage(detail.cover),
        description: detail.description || '',
        genres: Array.isArray(detail.tags) ? detail.tags.filter(Boolean) : [],
        status: detail.status || '',
        type: authors ? `Comic · ${authors}` : 'Comic',
      };
    },
    { staleIfError: true },
  ).catch((error) => {
    if (isEmptyAnswer(error)) return null;
    throw error;
  });
}

export async function fetchComicChapters(id: string): Promise<MangaChapter[]> {
  return getOrSetCached<MangaChapter[]>(
    `comics:chapters:v2:${id}`,
    15 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id, limit: '500', offset: '0' });
      const data = await requestProxy<ProxyChaptersResponse>(`/chapters?${params.toString()}`);
      const chapters = data.issues || data.chapters || [];
      if (!chapters.length) throw emptyAnswer('No issues.');
      return chapters.map((c, idx) => {
        const num = c.number != null ? Number(c.number) : chapters.length - idx;
        return {
          id: c.id,
          number: Number.isFinite(num) ? num : chapters.length - idx,
          title: c.title || (c.number != null ? `Issue ${c.number}` : c.id),
          pageCount: c.pages || 0,
          createdAt: c.publishAt || '',
        } as MangaChapter;
      });
    },
    { staleIfError: true },
  ).catch((error) => {
    if (isEmptyAnswer(error)) return [] as MangaChapter[];
    throw error;
  });
}

export async function fetchComicPages(comicId: string, rawChapterId: string): Promise<string[]> {
  // Still resolves [] for an issue with no pages, but never caches it (see
  // fetchComicDetail): a cached [] kept the issue, and its download, blank for
  // the full hour.
  return getOrSetCached<string[]>(
    `comics:pages:v2:${comicId}:${rawChapterId}`,
    60 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id: comicId, chapterId: rawChapterId });
      const data = await requestProxy<ProxyPagesResponse>(`/pages?${params.toString()}`);
      const pages = (data.pages || data.images || [])
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => proxyComicImage(p));
      if (!pages.length) throw emptyAnswer('No pages.');
      return pages;
    },
    { staleIfError: true },
  ).catch((error) => {
    if (isEmptyAnswer(error)) return [] as string[];
    throw error;
  });
}
