import { getOrSetCached } from '@/lib/cache';
import { atsuFetch } from '@/lib/atsu-fetch';

const BASE = 'https://atsu.moe';
const STATIC = `${BASE}/static`;
const TYPES = 'Manga,Manwha,Manhua,OEL';
const MANGADEX_API = 'https://api.mangadex.org';
const MANGADEX_COVERS = 'https://uploads.mangadex.org/covers';

export interface AtsuItem {
  id: string;
  title: string;
  image?: string;
  largeImage?: string;
  mediumImage?: string;
  type?: string;
}

function imgUrl(item: AtsuItem): string {
  const path = item.largeImage || item.mediumImage || item.image;
  return absUrl(path);
}

function absUrl(path?: string | null): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('//')) return `https:${path}`;
  return `${STATIC}/${path.replace(/^\/+/, '').replace(/^static\//, '')}`;
}

function mangaDexTitle(attrs: any): string {
  const titles = attrs?.title || {};
  return titles.en || Object.values(titles)[0] || 'Unknown';
}

function mangaDexCover(manga: any): string {
  const cover = (manga.relationships || []).find((rel: any) => rel.type === 'cover_art');
  const fileName = cover?.attributes?.fileName;
  return fileName ? `${MANGADEX_COVERS}/${manga.id}/${fileName}.512.jpg` : '';
}

function mangaDexGenres(attrs: any): string[] {
  return (attrs?.tags || [])
    .filter((tag: any) => tag?.attributes?.group === 'genre')
    .map((tag: any) => tag?.attributes?.name?.en || '')
    .filter(Boolean);
}

function mangaDexToItem(manga: any): AtsuItem {
  return {
    id: String(manga.id || ''),
    title: mangaDexTitle(manga.attributes),
    image: mangaDexCover(manga),
    largeImage: mangaDexCover(manga),
    mediumImage: mangaDexCover(manga),
    type: 'Manga',
  };
}

function mangaDexUrl(path: string, params: Record<string, string | string[]> = {}): string {
  const url = new URL(`${MANGADEX_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }
  return url.toString();
}

async function mangaDexJson(path: string, params?: Record<string, string | string[]>): Promise<any> {
  const res = await fetch(mangaDexUrl(path, params), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MangaDex HTTP ${res.status}`);
  return res.json();
}

async function mangaDexList(kind: 'trending' | 'popular', page: number, limit: number): Promise<AtsuItem[]> {
  const data = await mangaDexJson('/manga', {
    limit: String(limit),
    offset: String(Math.max(0, page) * limit),
    'includes[]': ['cover_art'],
    'contentRating[]': ['safe', 'suggestive'],
    'availableTranslatedLanguage[]': ['en'],
    [kind === 'trending' ? 'order[latestUploadedChapter]' : 'order[followedCount]']: 'desc',
  });
  return ((data.data || []) as any[]).map(mangaDexToItem).filter((item) => item.id && item.title);
}

async function mangaDexSearch(query: string, limit: number): Promise<AtsuItem[]> {
  const data = await mangaDexJson('/manga', {
    title: query,
    limit: String(limit),
    'includes[]': ['cover_art'],
    'contentRating[]': ['safe', 'suggestive'],
    'availableTranslatedLanguage[]': ['en'],
    'order[relevance]': 'desc',
  });
  return ((data.data || []) as any[]).map(mangaDexToItem).filter((item) => item.id && item.title);
}

async function cachedFetch(url: string): Promise<AtsuItem[]> {
  return getOrSetCached<AtsuItem[]>(
    `manga:list:${url}`,
    5 * 60 * 1000,
    async () => {
      const res = await atsuFetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      return (json.items || []) as AtsuItem[];
    },
    { staleIfError: true },
  );
}

export async function fetchTrendingManga(limit = 20): Promise<AtsuItem[]> {
  try {
    const items = await cachedFetch(
      `${BASE}/api/infinite/trending?page=0&types=${encodeURIComponent(TYPES)}`,
    );
    if (items.length > 0) return items.slice(0, limit);
  } catch {
    // Fall through to MangaDex when ATSU is blocked/down.
  }
  return mangaDexList('trending', 0, limit);
}

export async function fetchPopularManga(limit = 20): Promise<AtsuItem[]> {
  try {
    const items = await cachedFetch(
      `${BASE}/api/infinite/popular?page=0&types=${encodeURIComponent(TYPES)}`,
    );
    if (items.length > 0) return items.slice(0, limit);
  } catch {
    // Fall through to MangaDex when ATSU is blocked/down.
  }
  return mangaDexList('popular', 0, limit);
}

export async function fetchMangaPagedList(kind: 'trending' | 'popular', page: number): Promise<AtsuItem[]> {
  const url = `${BASE}/api/infinite/${kind}?page=${page}&types=${encodeURIComponent(TYPES)}`;
  const items = await getOrSetCached<AtsuItem[]>(
    `manga:paged:${kind}:${page}`,
    5 * 60 * 1000,
    async () => {
      const res = await atsuFetch(url);
      if (!res.ok) return [];
      const json = await res.json();
      return (json.items || []) as AtsuItem[];
    },
    { staleIfError: true },
  ).catch(() => []);
  return items.length > 0 ? items : mangaDexList(kind, page, 24);
}

export function toCarouselItem(item: AtsuItem) {
  return {
    id: item.id,
    title: item.title,
    cover: imgUrl(item),
    genres: item.type ? [item.type] : [],
    type: 'manga' as const,
  };
}

export function toContentItem(item: AtsuItem, badge?: string) {
  return {
    id: item.id,
    title: item.title,
    cover: imgUrl(item),
    type: 'manga' as const,
    badge,
  };
}

export function toBannerItem(item: AtsuItem) {
  return {
    id: item.id,
    title: item.title,
    cover: imgUrl(item),
    type: 'manga' as const,
  };
}

export interface MangaDetail {
  id: string;
  title: string;
  cover: string;
  description: string;
  genres: string[];
  status: string;
  type: string;
  rating?: number;
}

export interface MangaChapter {
  id: string;
  number: number;
  title: string;
  pageCount: number;
  createdAt: string;
  /** First-page image from API when available */
  coverUrl?: string;
}

/** atsu allChapters merges every scanlation upload; keep one feed + one row per chapter number. */
function pickScanlationChapters(raw: any[]): any[] {
  if (raw.length === 0) return raw;

  const groups = new Map<string, any[]>();
  for (const c of raw) {
    const sid = String(c.scanlationMangaId || c.scanlationId || '__default');
    const list = groups.get(sid);
    if (list) list.push(c);
    else groups.set(sid, [c]);
  }
  if (groups.size <= 1) return dedupeChaptersByNumber(raw);

  let best: any[] = [];
  let bestScore = -1;
  for (const items of groups.values()) {
    const chapters = items.filter((c) => /^chapter\b/i.test(String(c.title || '').trim())).length;
    const score = items.length * 10 + chapters;
    if (score > bestScore) {
      bestScore = score;
      best = items;
    }
  }
  return dedupeChaptersByNumber(best);
}

function dedupeChaptersByNumber(raw: any[]): any[] {
  const byNum = new Map<number, any>();
  for (const c of raw) {
    const num = Number(c.number ?? c.num ?? 0);
    const prev = byNum.get(num);
    if (!prev) {
      byNum.set(num, c);
      continue;
    }
    const prevPages = Number(prev.pageCount ?? prev.pages ?? 0);
    const nextPages = Number(c.pageCount ?? c.pages ?? 0);
    const prevAt = Number(prev.createdAt || 0);
    const nextAt = Number(c.createdAt || 0);
    if (nextPages > prevPages || (nextPages === prevPages && nextAt > prevAt)) {
      byNum.set(num, c);
    }
  }
  return [...byNum.values()].sort((a, b) => Number(a.number ?? a.num) - Number(b.number ?? b.num));
}

function mapRawChapter(c: any): MangaChapter {
  const img = c.image ?? c.cover ?? c.thumbnail ?? c.poster?.image ?? c.poster?.mediumImage;
  const num = Number(c.number ?? c.num ?? 0);
  return {
    id: String(c.id || ''),
    number: num,
    title: c.title || `Chapter ${num}`,
    pageCount: Number(c.pageCount ?? c.pages ?? 0),
    createdAt: c.createdAt || '',
    coverUrl: img ? absUrl(typeof img === 'string' ? img : '') : undefined,
  };
}

async function fetchChapterFirstPageUrl(mangaId: string, chapterId: string): Promise<string | null> {
  const res = await atsuFetch(
    `/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
  );
  if (!res.ok) return null;
  const json = await res.json();
  const raw: unknown[] = json.readChapter?.pages || [];
  const first = raw[0];
  if (!first) return null;
  const row = first as { image?: string };
  const rawImg = row?.image ?? first;
  const path = typeof rawImg === 'string' ? rawImg : '';
  return path ? toPageUrl(path) : null;
}

/** Cached first page of a chapter for list thumbnails. */
export async function fetchMangaChapterThumbnail(
  mangaId: string,
  chapterId: string,
): Promise<string | null> {
  return getOrSetCached<string | null>(
    `manga:thumb:${mangaId}:${chapterId}`,
    60 * 60 * 1000,
    async () => fetchChapterFirstPageUrl(mangaId, chapterId),
    { staleIfError: true },
  );
}

export async function fetchMangaDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail | null>(
    `manga:detail:${id}`,
    30 * 60 * 1000,
    async () => {
      try {
        const res = await atsuFetch(`/api/manga/page?id=${encodeURIComponent(id)}`);
        if (res.ok) {
          const json = await res.json();
          const p = json.mangaPage;
          if (p?.title) {

            // Cover is nested under poster — same as the capacitor app
            const cover = absUrl(p.poster?.largeImage || p.poster?.mediumImage || p.poster?.image);

            return {
              id: p.id || id,
              title: p.title || p.englishTitle || id,
              cover,
              description: p.synopsis || '',
              genres: Array.isArray(p.genres)
                ? p.genres.map((g: any) => (typeof g === 'string' ? g : g.name || '')).filter(Boolean)
                : [],
              status: p.status || '',
              type: p.type || '',
              rating: typeof p.rating === 'number' ? p.rating : undefined,
            };
          }
        }
      } catch {
        // Fall through to MangaDex.
      }
      try {
        const json = await mangaDexJson(`/manga/${encodeURIComponent(id)}`, {
          'includes[]': ['cover_art'],
        });
        const manga = json.data;
        if (!manga?.id) return null;
        return {
          id: manga.id,
          title: mangaDexTitle(manga.attributes),
          cover: mangaDexCover(manga),
          description: manga.attributes?.description?.en || '',
          genres: mangaDexGenres(manga.attributes),
          status: manga.attributes?.status || '',
          type: 'Manga',
        };
      } catch {
        return null;
      }
    },
    { staleIfError: true },
  );
}

export async function fetchMangaChapters(id: string): Promise<MangaChapter[]> {
  const chapters = await getOrSetCached<MangaChapter[]>(
    `manga:chapters:v2:${id}`,
    15 * 60 * 1000,
    async () => {
      try {
        const res = await atsuFetch(`/api/manga/allChapters?mangaId=${encodeURIComponent(id)}`);
        if (!res.ok) return [];
        const json = await res.json();
        const raw: any[] = json.chapters || [];
        return pickScanlationChapters(raw).map(mapRawChapter);
      } catch {
        return [];
      }
    },
    { staleIfError: true },
  ).catch(() => []);
  if (chapters.length > 0) return chapters;

  try {
    const json = await mangaDexJson(`/manga/${encodeURIComponent(id)}/feed`, {
      limit: '500',
      'translatedLanguage[]': ['en'],
      'order[chapter]': 'asc',
      includeEmptyPages: '0',
    });
    return ((json.data || []) as any[])
      .map((chapter) => {
        const num = Number(chapter.attributes?.chapter || 0);
        return {
          id: String(chapter.id || ''),
          number: num,
          title: chapter.attributes?.title || `Chapter ${Number.isFinite(num) && num > 0 ? num : ''}`.trim(),
          pageCount: Number(chapter.attributes?.pages || 0),
          createdAt: chapter.attributes?.readableAt || chapter.attributes?.createdAt || '',
        };
      })
      .filter((chapter) => chapter.id && chapter.number > 0);
  } catch {
    return [];
  }
}

export function toPageUrl(imagePath: string): string {
  return absUrl(imagePath);
}

/** Page image URLs for a manga chapter (atsu). */
export async function fetchMangaChapterPages(mangaId: string, chapterId: string): Promise<string[]> {
  try {
    const res = await atsuFetch(
      `/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
    );
    if (res.ok) {
      const json = await res.json();
      const raw: unknown[] = json.readChapter?.pages || [];
      const pages = raw
        .map((page) => {
          const row = page as { image?: string };
          const rawImg = row?.image ?? page;
          const path = typeof rawImg === 'string' ? rawImg : '';
          return path ? toPageUrl(path) : '';
        })
        .filter(Boolean);
      if (pages.length > 0) return pages;
    }
  } catch {
    // Fall through to MangaDex at-home server.
  }

  try {
    const json = await mangaDexJson(`/at-home/server/${encodeURIComponent(chapterId)}`);
    const baseUrl = String(json.baseUrl || '').replace(/\/+$/, '');
    const hash = String(json.chapter?.hash || '');
    const data = Array.isArray(json.chapter?.data) ? json.chapter.data : [];
    if (!baseUrl || !hash || data.length === 0) return [];
    return data.map((file: string) => `${baseUrl}/data/${hash}/${file}`);
  } catch {
    return [];
  }
}

export async function searchManga(query: string, limit = 24): Promise<AtsuItem[]> {
  if (!query.trim()) return fetchTrendingManga(limit);
  return getOrSetCached<AtsuItem[]>(
    `manga:search:${query.trim().toLowerCase()}:${limit}`,
    10 * 60 * 1000,
    async () => {
      const payload = {
        page: 0,
        filter: {
          search: query.trim(),
          types: ['Manga', 'Manwha', 'Manhua', 'OEL'],
          sortBy: 'popularity',
          showAdult: false,
          officialTranslation: false,
        },
      };
      try {
        const res = await atsuFetch('/api/explore/filteredView', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        const hits = (json.hits || json.items || []) as any[];
        const items = hits
          .map((h) => h.document || h)
          .filter((h): h is AtsuItem => Boolean(h?.id && h?.title))
          .slice(0, limit);
        return items.length > 0 ? items : mangaDexSearch(query.trim(), limit);
      } catch {
        return mangaDexSearch(query.trim(), limit);
      }
    },
    { staleIfError: true },
  );
}
