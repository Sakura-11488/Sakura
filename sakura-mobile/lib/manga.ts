import { getOrSetCached } from '@/lib/cache';
const BASE = 'https://atsu.moe';
const STATIC = `${BASE}/static`;
const TYPES = 'Manga,Manwha,Manhua,OEL';

// Every request must include Referer or atsu.moe returns empty/blocked responses
const HEADERS = { Accept: 'application/json', Referer: BASE };

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

async function cachedFetch(url: string): Promise<AtsuItem[]> {
  return getOrSetCached<AtsuItem[]>(
    `manga:list:${url}`,
    5 * 60 * 1000,
    async () => {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      return (json.items || []) as AtsuItem[];
    },
    { staleIfError: true },
  );
}

export async function fetchTrendingManga(limit = 20): Promise<AtsuItem[]> {
  const items = await cachedFetch(
    `${BASE}/api/infinite/trending?page=0&types=${encodeURIComponent(TYPES)}`,
  );
  return items.slice(0, limit);
}

export async function fetchPopularManga(limit = 20): Promise<AtsuItem[]> {
  const items = await cachedFetch(
    `${BASE}/api/infinite/popular?page=0&types=${encodeURIComponent(TYPES)}`,
  );
  return items.slice(0, limit);
}

export async function fetchMangaPagedList(kind: 'trending' | 'popular', page: number): Promise<AtsuItem[]> {
  const url = `${BASE}/api/infinite/${kind}?page=${page}&types=${encodeURIComponent(TYPES)}`;
  return getOrSetCached<AtsuItem[]>(
    `manga:paged:${kind}:${page}`,
    5 * 60 * 1000,
    async () => {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) return [];
      const json = await res.json();
      return (json.items || []) as AtsuItem[];
    },
    { staleIfError: true },
  );
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
  const res = await fetch(
    `${BASE}/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
    { headers: HEADERS },
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
        const res = await fetch(`${BASE}/api/manga/page?id=${encodeURIComponent(id)}`, {
          headers: HEADERS,
        });
        if (!res.ok) return null;
        const json = await res.json();
        const p = json.mangaPage;
        if (!p?.title) return null;

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
      } catch {
        return null;
      }
    },
    { staleIfError: true },
  );
}

export async function fetchMangaChapters(id: string): Promise<MangaChapter[]> {
  return getOrSetCached<MangaChapter[]>(
    `manga:chapters:v2:${id}`,
    15 * 60 * 1000,
    async () => {
      try {
        const res = await fetch(`${BASE}/api/manga/allChapters?mangaId=${encodeURIComponent(id)}`, {
          headers: HEADERS,
        });
        if (!res.ok) return [];
        const json = await res.json();
        const raw: any[] = json.chapters || [];
        return pickScanlationChapters(raw).map(mapRawChapter);
      } catch {
        return [];
      }
    },
    { staleIfError: true },
  );
}

export function toPageUrl(imagePath: string): string {
  return absUrl(imagePath);
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
        const res = await fetch(`${BASE}/api/explore/filteredView`, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        const hits = (json.hits || json.items || []) as any[];
        return hits
          .map((h) => h.document || h)
          .filter((h): h is AtsuItem => Boolean(h?.id && h?.title))
          .slice(0, limit);
      } catch {
        return [];
      }
    },
    { staleIfError: true },
  );
}
