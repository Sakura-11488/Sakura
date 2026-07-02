import { getOrSetCached } from '@/lib/cache';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { MangaDetail, MangaChapter } from '@/lib/manga';
import { comicsProxyFetch } from '@/lib/comics-proxy-fetch';

/**
 * Sakura Comics source (XOXO Comics-backed) for the Expo app.
 *
 * Mirrors the data shapes returned by `lib/manga.ts` (atsu.moe) so the shared
 * manga detail screen and chapter reader can render comics by passing
 * `source=comics`, without forking the UI. The client only ever talks to the
 * Sakura comics scraper proxy (DigitalOcean droplet); it never hits the
 * upstream comic site directly. React Native fetch has no CORS restrictions,
 * so unlike the web build we don't need a native HTTP bridge here.
 */

export const COMICS_PROXY_BASE = (
  process.env.EXPO_PUBLIC_COMICS_PROXY || 'http://165.232.83.159/comics/v1'
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
  if (!/^https?:\/\//i.test(url)) return url;
  if (url.startsWith(`${COMICS_PROXY_BASE}/img?`)) return url;
  return `${COMICS_PROXY_BASE}/img?u=${encodeURIComponent(url)}`;
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

export async function fetchTrendingComics(limit = 24): Promise<ContentItem[]> {
  return getOrSetCached<ContentItem[]>(
    `comics:trending:${limit}`,
    5 * 60 * 1000,
    async () => {
      try {
        const data = await requestProxy<ProxyListResponse>(`/popular?limit=${limit}`);
        const items = data.items || data.results || [];
        if (items.length > 0) return items.map(mapListItem);
      } catch {
        // fall through to keyword fallback below
      }
      const fallbackQueries = ['batman', 'spider-man', 'superman', 'x-men'];
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

export async function fetchComicDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail | null>(
    `comics:detail:${id}`,
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
          cover: proxyComicImage(detail.cover),
          description: detail.description || '',
          genres: Array.isArray(detail.tags) ? detail.tags.filter(Boolean) : [],
          status: detail.status || '',
          type: authors ? `Comic · ${authors}` : 'Comic',
        };
      } catch {
        return null;
      }
    },
    { staleIfError: true },
  );
}

export async function fetchComicChapters(id: string): Promise<MangaChapter[]> {
  return getOrSetCached<MangaChapter[]>(
    `comics:chapters:${id}`,
    15 * 60 * 1000,
    async () => {
      try {
        const params = new URLSearchParams({ id, limit: '500', offset: '0' });
        const data = await requestProxy<ProxyChaptersResponse>(`/chapters?${params.toString()}`);
        const chapters = data.issues || data.chapters || [];
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
      } catch {
        return [];
      }
    },
    { staleIfError: true },
  );
}

export async function fetchComicPages(comicId: string, rawChapterId: string): Promise<string[]> {
  return getOrSetCached<string[]>(
    `comics:pages:v1:${comicId}:${rawChapterId}`,
    60 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id: comicId, chapterId: rawChapterId });
      const data = await requestProxy<ProxyPagesResponse>(`/pages?${params.toString()}`);
      const pages = data.pages || data.images || [];
      return pages
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => proxyComicImage(p));
    },
    { staleIfError: true },
  );
}
