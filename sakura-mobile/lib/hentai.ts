import { Platform } from 'react-native';
import { getOrSetCached } from '@/lib/cache';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { MangaDetail, MangaChapter } from '@/lib/manga';
import { hentaiProxyFetch } from '@/lib/hentai-proxy-fetch';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import { HENTAI_PROXY_DEFAULT } from '@/lib/content-hosts';

/**
 * Sakura Hentai (18+) source (HentaiFox-backed) for the Expo app.
 *
 * Mirrors the data shapes returned by `lib/manga.ts` (atsu.moe) and
 * `lib/comics.ts` (XOXO) so the shared manga detail screen and chapter reader
 * can render 18+ galleries by passing `source=hentai`, without forking the UI.
 * The client only ever talks to the Sakura hentai scraper proxy (DigitalOcean
 * droplet); it never hits the upstream site directly. React Native fetch has no
 * CORS restrictions, so unlike the web build we don't need a native HTTP bridge.
 *
 * HentaiFox galleries are single works with no chapters, so the scraper exposes
 * exactly one synthetic chapter (`id = "gallery"`) per gallery and returns every
 * page image from `/pages`.
 */

export const HENTAI_PROXY_BASE = (
  process.env.EXPO_PUBLIC_HENTAI_PROXY || HENTAI_PROXY_DEFAULT
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
  pageCount?: number | null;
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
  return hentaiProxyFetch<T>(path);
}

/**
 * Route covers and pages through the droplet's `/img` endpoint. HentaiFox's CDN
 * enforces hotlink protection via Referer, so a device fetching the image URL
 * directly gets a 403 — the proxy refetches with the right header.
 */
export function proxyHentaiImage(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  // HentaiFox emits some URLs protocol-relative (//i3.hentaifox.com/…).
  // Normalize to https before wrapping, otherwise they skip the proxy and load
  // straight from the CDN — where hotlink protection returns a blank image.
  const abs = url.startsWith('//') ? `https:${url}` : url;
  if (!/^https?:\/\//i.test(abs)) return url;
  const proxied = abs.startsWith(`${HENTAI_PROXY_BASE}/img?`)
    ? abs
    : `${HENTAI_PROXY_BASE}/img?u=${encodeURIComponent(abs)}`;
  // The droplet only serves HTTP. On the HTTPS web build, route the image
  // through the same-origin HTTPS media proxy or the browser blocks it as
  // mixed content (covers/pages render blank). Native fetch has no such limit.
  return Platform.OS === 'web' ? getWebMediaProxyUrl(proxied) : proxied;
}

function mapListItem(item: ProxyListItem): ContentItem {
  return {
    id: item.id,
    title: item.title || item.id,
    cover: proxyHentaiImage(item.cover),
    type: 'manga',
    source: 'hentai',
  };
}

export async function fetchTrendingHentai(limit = 24): Promise<ContentItem[]> {
  return getOrSetCached<ContentItem[]>(
    `hentai:trending:${limit}`,
    5 * 60 * 1000,
    async () => {
      try {
        const data = await requestProxy<ProxyListResponse>(`/popular?limit=${limit}`);
        const items = data.items || data.results || [];
        if (items.length > 0) return items.map(mapListItem);
      } catch {
        // fall through to keyword fallback below
      }
      const fallbackQueries = ['love', 'romance', 'school', 'story'];
      const collected: ContentItem[] = [];
      const seen = new Set<string>();
      for (const q of fallbackQueries) {
        try {
          const data = await requestProxy<ProxyListResponse>(
            `/search?q=${encodeURIComponent(q)}&limit=${Math.ceil(limit / 2)}&offset=0`,
          );
          const items = (data.items || data.results || []).map(mapListItem);
          for (const item of items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            collected.push(item);
            if (collected.length >= limit) return collected;
          }
        } catch {
          // ignore individual fallback failures
        }
      }
      return collected;
    },
    { staleIfError: true },
  );
}

export async function searchHentai(query: string, limit = 24): Promise<ContentItem[]> {
  if (!query.trim()) return fetchTrendingHentai(limit);
  return getOrSetCached<ContentItem[]>(
    `hentai:search:${query.trim().toLowerCase()}:${limit}`,
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

export async function fetchHentaiDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail | null>(
    `hentai:detail:${id}`,
    30 * 60 * 1000,
    async () => {
      try {
        const params = new URLSearchParams({ id });
        const data = await requestProxy<ProxyDetailResponse>(`/details?${params.toString()}`);
        const detail =
          (data as { comic?: ProxyDetail }).comic ||
          (data as { manga?: ProxyDetail }).manga ||
          (data as ProxyDetail);
        if (!detail || !detail.id) return null;
        const authors =
          Array.isArray(detail.authors) && detail.authors.length
            ? detail.authors.join(', ')
            : detail.author || '';
        return {
          id: detail.id,
          title: detail.title || detail.id,
          cover: proxyHentaiImage(detail.cover),
          description: detail.description || '',
          genres: Array.isArray(detail.tags) ? detail.tags.filter(Boolean) : [],
          status: detail.status || '',
          type: authors ? `Doujin · ${authors}` : 'Doujin',
        };
      } catch {
        return null;
      }
    },
    { staleIfError: true },
  );
}

export async function fetchHentaiChapters(id: string): Promise<MangaChapter[]> {
  return getOrSetCached<MangaChapter[]>(
    `hentai:chapters:${id}`,
    15 * 60 * 1000,
    async () => {
      try {
        const params = new URLSearchParams({ id, limit: '10', offset: '0' });
        const data = await requestProxy<ProxyChaptersResponse>(`/chapters?${params.toString()}`);
        const chapters = data.issues || data.chapters || [];
        return chapters.map((c, idx) => {
          const num = c.number != null ? Number(c.number) : chapters.length - idx;
          return {
            id: c.id,
            number: Number.isFinite(num) ? num : chapters.length - idx,
            title: c.title || 'Read Gallery',
            pageCount: c.pages || 0,
            createdAt: c.publishAt || '',
          } as MangaChapter;
        });
      } catch {
        return [];
      }
    },
    { staleIfError: true },
  );
}

export async function fetchHentaiPages(galleryId: string, rawChapterId: string): Promise<string[]> {
  return getOrSetCached<string[]>(
    `hentai:pages:v1:${galleryId}:${rawChapterId}`,
    60 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id: galleryId, chapterId: rawChapterId || 'gallery' });
      const data = await requestProxy<ProxyPagesResponse>(`/pages?${params.toString()}`);
      const pages = data.pages || data.images || [];
      return pages
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => proxyHentaiImage(p));
    },
    { staleIfError: true },
  );
}
