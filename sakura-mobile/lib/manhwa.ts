import { Platform } from 'react-native';
import { getOrSetCached } from '@/lib/cache';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { MangaDetail, MangaChapter } from '@/lib/manga';
import { manhwaProxyFetch } from '@/lib/manhwa-proxy-fetch';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import { MANHWA_PROXY_DEFAULT } from '@/lib/content-hosts';

/**
 * Sakura Manhwa source for the Expo app.
 *
 * Mirrors the shapes returned by `lib/manga.ts` (atsu.moe) so the shared manga
 * detail screen and chapter reader render manhwa by passing `source=manhwa`,
 * without forking the UI. The client only ever talks to the Sakura manhwa
 * scraper proxy on the droplet, never to the upstream sites.
 *
 * Behind that one proxy sit two upstreams — mangaread.org and comizy.io —
 * because neither covers the catalogue alone. That choice is invisible here:
 * the scraper resolves it at search time and encodes it in the id as `mr:` or
 * `cz:`. Treat those ids as opaque and never construct one; they are persisted
 * in offline manifests and reading progress, so a hand-built id that resolves
 * to the wrong upstream yields an empty reader with no error.
 *
 * Unlike the 18+ source, manhwa is SFW and DOES belong in Continue Reading,
 * reading history and lock-screen activity.
 */

export const MANHWA_PROXY_BASE = (
  process.env.EXPO_PUBLIC_MANHWA_PROXY || MANHWA_PROXY_DEFAULT
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
  return manhwaProxyFetch<T>(path);
}

/**
 * Route covers and pages through the droplet's `/img` endpoint.
 *
 * Not optional for this source: comizy's CDN hard-403s any request without a
 * `Referer`, which a device cannot usefully send, so a direct URL renders as a
 * blank page rather than an error. The proxy attaches the right Referer per
 * image host.
 */
export function proxyManhwaImage(url?: string | null): string {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  // Normalize protocol-relative (//host/…) URLs to https before wrapping.
  const abs = url.startsWith('//') ? `https:${url}` : url;
  if (!/^https?:\/\//i.test(abs)) return url;
  const proxied = abs.startsWith(`${MANHWA_PROXY_BASE}/img?`)
    ? abs
    : `${MANHWA_PROXY_BASE}/img?u=${encodeURIComponent(abs)}`;
  // Droplet is HTTP-only; on the HTTPS web build route through the same-origin
  // media proxy to avoid mixed-content blocking. Native is unaffected.
  return Platform.OS === 'web' ? getWebMediaProxyUrl(proxied) : proxied;
}

function mapListItem(item: ProxyListItem): ContentItem {
  return {
    id: item.id,
    title: item.title || item.id,
    cover: proxyManhwaImage(item.cover),
    type: 'manga',
    source: 'manhwa',
  };
}

export async function fetchTrendingManhwa(limit = 24): Promise<ContentItem[]> {
  return getOrSetCached<ContentItem[]>(
    `manhwa:trending:${limit}`,
    5 * 60 * 1000,
    async () => {
      try {
        const data = await requestProxy<ProxyListResponse>(`/popular?limit=${limit}`);
        const items = data.items || data.results || [];
        if (items.length > 0) return items.map(mapListItem);
      } catch {
        // fall through to keyword fallback below
      }
      const fallbackQueries = ['martial', 'leveling', 'return', 'tower'];
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

export async function searchManhwa(query: string, limit = 24): Promise<ContentItem[]> {
  if (!query.trim()) return fetchTrendingManhwa(limit);
  return getOrSetCached<ContentItem[]>(
    `manhwa:search:${query.trim().toLowerCase()}:${limit}`,
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

export async function fetchManhwaDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail | null>(
    `manhwa:detail:${id}`,
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
          cover: proxyManhwaImage(detail.cover),
          description: detail.description || '',
          genres: Array.isArray(detail.tags) ? detail.tags.filter(Boolean) : [],
          status: detail.status || '',
          type: authors ? `Manhwa · ${authors}` : 'Manhwa',
        };
      } catch {
        return null;
      }
    },
    { staleIfError: true },
  );
}

export async function fetchManhwaChapters(id: string): Promise<MangaChapter[]> {
  return getOrSetCached<MangaChapter[]>(
    `manhwa:chapters:${id}`,
    15 * 60 * 1000,
    async () => {
      try {
        // Long-running manhwa routinely pass 300 chapters (God of Blackfield is
        // 328), and the catalogue reaches into the thousands, so this must not
        // inherit the comics client's 500 or the 18+ client's 10.
        const params = new URLSearchParams({ id, limit: '2000', offset: '0' });
        const data = await requestProxy<ProxyChaptersResponse>(`/chapters?${params.toString()}`);
        const chapters = data.issues || data.chapters || [];
        return chapters.map((c, idx) => {
          const num = c.number != null ? Number(c.number) : idx + 1;
          return {
            id: c.id,
            // The proxy returns chapters in reading order (ascending), so the
            // positional fallback counts up. Comics counts down because its
            // upstream lists newest first — copying that here would number
            // every chapter backwards whenever the parsed number is missing.
            number: Number.isFinite(num) ? num : idx + 1,
            title: c.title || (c.number != null ? `Chapter ${c.number}` : c.id),
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

export async function fetchManhwaPages(manhwaId: string, rawChapterId: string): Promise<string[]> {
  return getOrSetCached<string[]>(
    `manhwa:pages:v1:${manhwaId}:${rawChapterId}`,
    60 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id: manhwaId, chapterId: rawChapterId });
      const data = await requestProxy<ProxyPagesResponse>(`/pages?${params.toString()}`);
      const pages = data.pages || data.images || [];
      return pages
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => proxyManhwaImage(p));
    },
    { staleIfError: true },
  );
}
