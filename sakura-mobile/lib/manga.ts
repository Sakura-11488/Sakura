import { Platform } from 'react-native';
import { getOrSetCached } from '@/lib/cache';
import { atsuFetch } from '@/lib/atsu-fetch';
import { getWebMangaPageProxyUrl } from '@/lib/content-proxy-client';

const BASE = 'https://atsu.moe';
const STATIC = `${BASE}/static`;
/**
 * Chapter pages live on the CDN host only. atsu.moe/static/pages now answers
 * 410 Gone (an HTML body), which is why atsu chapters stopped rendering; the
 * CDN serves the same paths. Posters deliberately stay on atsu.moe — they
 * still 301 to the CDN, and lib/cover-thumbnail.ts and its tests key on that
 * form — so only pages move. See atsuPageCdnUrl in lib/content-proxy-client.ts
 * for why web cannot load even the CDN URL directly.
 */
const PAGES_STATIC = 'https://cdn.atsu.moe/static';
const ATSU_PAGES_ORIGIN = /^https?:\/\/(?:www\.)?atsu\.moe(?=\/static\/pages\/)/i;
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

function imgUrl(item: AtsuItem, size: 'medium' | 'large' = 'large'): string {
  // ATSU's smallImage is a square crop. Medium preserves the full portrait.
  const path = size === 'medium'
    ? item.mediumImage || item.largeImage || item.image
    : item.largeImage || item.mediumImage || item.image;
  return absUrl(path);
}

function absUrl(path?: string | null): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path.replace(ATSU_PAGES_ORIGIN, 'https://cdn.atsu.moe');
  if (path.startsWith('//')) return `https:${path}`.replace(ATSU_PAGES_ORIGIN, 'https://cdn.atsu.moe');
  const rel = path.replace(/^\/+/, '').replace(/^static\//, '');
  return `${rel.startsWith('pages/') ? PAGES_STATIC : STATIC}/${rel}`;
}

/**
 * MangaDex is a native-only fallback.
 *
 * api.mangadex.org sends no Access-Control-Allow-Origin to other origins, so on
 * web every MangaDex call below was a request that could only fail — after a
 * full round trip, and in fetchMangaChapterPages only after atsu had already
 * failed, doubling the wait before the reader could show its error. Web fails
 * fast instead. Read lazily, not at module load, so tests can load this file
 * without a react-native implementation.
 */
function mangaDexReachable(): boolean {
  return Platform.OS !== 'web';
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
  if (!mangaDexReachable()) throw new Error('MangaDex cannot be reached from the browser.');
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
  // null when atsu could not be reached; [] when it answered with an empty page.
  const items = await getOrSetCached<AtsuItem[]>(
    // v2: the previous build returned [] on a failed fetch and cached it here.
    // That was harmless while [] fell through to MangaDex, but [] now means
    // "end of catalogue" (below), so those entries must not be read.
    `manga:paged:v2:${kind}:${page}`,
    5 * 60 * 1000,
    async () => {
      const res = await atsuFetch(url);
      // Throw rather than return [], or the failure is cached as a real empty
      // page for the whole TTL (see fetchMangaDetail).
      if (!res.ok) throw new Error(`atsu HTTP ${res.status}`);
      const json = await res.json();
      return (json.items || []) as AtsuItem[];
    },
    { staleIfError: true },
  ).catch(() => null);
  if (items && items.length > 0) return items;
  // atsu answering with no items is the end of its catalogue (live: page 51
  // onwards is {"items":[]}). On web the MangaDex fallback below can only
  // throw (see mangaDexReachable), which turned reaching the end of the list
  // into "This shelf could not load"; [] makes browse stop paging instead.
  // A failed atsu fetch (null) still goes on to MangaDex, and throws on web.
  if (items && !mangaDexReachable()) return [];
  return mangaDexList(kind, page, 24);
}

export function toCarouselItem(item: AtsuItem) {
  return {
    id: item.id,
    title: item.title,
    cover: imgUrl(item, 'medium'),
    genres: item.type ? [item.type] : [],
    type: 'manga' as const,
  };
}

export function toContentItem(item: AtsuItem, badge?: string) {
  return {
    id: item.id,
    title: item.title,
    cover: imgUrl(item, 'medium'),
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

const rawChapterNumber = (c: any): number => Number(c.number ?? c.num ?? 0);
const rawPageCount = (c: any): number => Number(c.pageCount ?? c.pages ?? 0);
const TITLE_NUMBER = /^\s*(?:chapter|ch\.?|episode|ep\.?)\s*(\d+(?:\.\d+)?)/i;
/** The number a row's own title gives it ("Chapter 12", "Ep. 12 - …"), or null when it names none. */
function rawTitleNumber(c: any): number | null {
  const m = TITLE_NUMBER.exec(String(c.title || ''));
  return m ? Number(m[1]) : null;
}

/**
 * atsu allChapters merges every scanlation group's uploads. One group is the
 * primary feed — the one with the most rows, preferring "Chapter N" titles —
 * so numbering and titles stay consistent, and the chapters it lacks are then
 * filled in from the other groups, one row per number.
 *
 * The fill is what keeps the newest chapters visible. Groups upload at
 * different speeds and the biggest is often a release or two behind; showing
 * it alone hid exactly the chapters readers come back for (live: Lookism's
 * primary stopped at 624 while three groups had 628, Stellar Swordmaster lacked
 * 141-142, Eleceed 421-422).
 *
 * Filled: every number above the primary's newest, and whole numbers it
 * skipped — unless it uploaded that chapter as parts (Lookism's primary has
 * 510.1 and 510.2; other groups' 510 is the same pages in one upload). Not
 * filled: another group's fractional numbers inside the primary's range. Live,
 * those were one group's re-split parts of chapters the primary already has
 * (Lookism 1.1-5.3, interleaved through its first five chapters) and one-page
 * notices (Eleceed 187.5, 408.5). Nor, above the primary's newest, a part of a
 * chapter it already has whole (Northern Blade: it has 202, another group's
 * 202.2 is the back half of its own split 202). Rows atsu reports with zero
 * pages never fill a gap: live they were placeholders a later upload replaced,
 * and could only open an empty reader.
 *
 * A row is only as good as its `number`, which is all that lines groups up.
 * One whose title names a different number ("Episode 158" at 170) is counted
 * on another scheme, and never fills: live, one Time-Limited Genius Dark
 * Knight group's numbers ran 12 ahead of everyone's, so its re-numbered copies
 * of 158-168 would have shown up as eleven new chapters 170-180. And where
 * several rows could fill one number, one whose title names that number wins
 * over one that does not: Villainess Turns the Hourglass has "Episode 5" and
 * "Epilogue 5" both at 5, and the epilogue has more pages.
 */
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

  const primary = dedupeChaptersByNumber(best);
  const have = new Set(primary.map(rawChapterNumber));
  let newest = -Infinity;
  // Fractional numbers per whole number. Two or more means the chapter was
  // uploaded in parts; a lone N.5 is an extra, and N itself is still missing.
  const partsOf = new Map<number, number>();
  for (const num of have) {
    if (num > newest) newest = num;
    if (Number.isFinite(num) && !Number.isInteger(num)) {
      partsOf.set(Math.floor(num), (partsOf.get(Math.floor(num)) || 0) + 1);
    }
  }
  // `have` holds every number in the primary group, so this also skips its own rows.
  const candidates = raw.filter((c) => {
    const num = rawChapterNumber(c);
    if (have.has(num) || !Number.isFinite(num)) return false;
    if ((c.pageCount ?? c.pages) != null && rawPageCount(c) <= 0) return false;
    const named = rawTitleNumber(c);
    // "Chapter 44 Part 2" at 44.2 agrees; only the whole number is in the title.
    if (named !== null && named !== num && named !== Math.floor(num)) return false;
    if (!Number.isInteger(num)) return num > newest && !have.has(Math.floor(num));
    return num > newest || (partsOf.get(num) || 0) < 2;
  });
  // Candidates' titles name their own number or none (see above), so a number
  // with a named candidate drops its unnamed ones ("Epilogue 5", "Hunt 22").
  const namedNums = new Set(candidates.filter((c) => rawTitleNumber(c) !== null).map(rawChapterNumber));
  const fill = candidates.filter((c) => rawTitleNumber(c) !== null || !namedNums.has(rawChapterNumber(c)));
  // Numbers in `fill` are disjoint from the primary's, so deduping the union
  // only picks the best of the other groups' rows (most pages, then newest)
  // and never displaces a primary row.
  return fill.length ? dedupeChaptersByNumber([...primary, ...fill]) : primary;
}

function dedupeChaptersByNumber(raw: any[]): any[] {
  const byNum = new Map<number, any>();
  for (const c of raw) {
    const num = rawChapterNumber(c);
    const prev = byNum.get(num);
    if (!prev) {
      byNum.set(num, c);
      continue;
    }
    const prevPages = rawPageCount(prev);
    const nextPages = rawPageCount(c);
    const prevAt = Number(prev.createdAt || 0);
    const nextAt = Number(c.createdAt || 0);
    if (nextPages > prevPages || (nextPages === prevPages && nextAt > prevAt)) {
      byNum.set(num, c);
    }
  }
  return [...byNum.values()].sort((a, b) => rawChapterNumber(a) - rawChapterNumber(b));
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

/** Throws on any failure, so callers inside getOrSetCached never cache one. */
async function fetchChapterFirstPageUrl(mangaId: string, chapterId: string): Promise<string> {
  const res = await atsuFetch(
    `/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
  );
  if (!res.ok) throw new Error(`atsu HTTP ${res.status}`);
  const json = await res.json();
  const raw: unknown[] = json.readChapter?.pages || [];
  const first = raw[0];
  const row = first as { image?: string } | undefined;
  const rawImg = row?.image ?? first;
  const path = typeof rawImg === 'string' ? rawImg : '';
  if (!path) throw new Error('Chapter has no pages.');
  return toPageUrl(path);
}

/**
 * The URL a screen should display an atsu chapter image with: the CDN form
 * (which also repairs atsu.moe page URLs cached by earlier builds, now 410),
 * wrapped in the same-origin page proxy on web. Native gets the CDN URL.
 */
function displayPageUrl(url: string): string {
  return getWebMangaPageProxyUrl(toPageUrl(url));
}

/** Cached first page of a chapter for list thumbnails. Null when unavailable. */
export async function fetchMangaChapterThumbnail(
  mangaId: string,
  chapterId: string,
): Promise<string | null> {
  // The cache holds the platform-neutral CDN URL; proxying is applied on the
  // way out so a cached value is right on either platform. v2: the previous
  // build cached null here for an hour when atsu answered non-2xx or with no
  // pages (see the note above fetchMangaDetail).
  const url = await getOrSetCached<string>(
    `manga:thumb:v2:${mangaId}:${chapterId}`,
    60 * 60 * 1000,
    () => fetchChapterFirstPageUrl(mangaId, chapterId),
    { staleIfError: true },
  ).catch(() => null);
  return url ? displayPageUrl(url) : null;
}

/**
 * Why the loaders below throw instead of returning null / []:
 *
 * getOrSetCached stores whatever its loader RETURNS as a fresh value for the
 * full TTL. These loaders used to catch their own network errors and return
 * null or [], so opening a title once while offline cached "no such title" for
 * 30 minutes (and "no chapters" for 15). The page then showed "Could not load
 * this title" even after the connection came back, and Try again could not fix
 * it, because the poisoned entry was still fresh. A throwing loader caches
 * nothing and lets staleIfError serve the last good value instead.
 *
 * Empty results are treated the same way — never cached — because a proxy that
 * failed upstream and a title that genuinely has nothing look identical here,
 * and re-asking for a genuinely empty title is cheap.
 *
 * The exported functions keep their old contract (null / [] on failure) by
 * catching OUTSIDE the cache.
 *
 * The keys are versioned because the previous build still had those catching
 * loaders, and its null / [] entries sit in clients' persisted caches under
 * the old keys. This code cannot tell them from a real value — a fresh hit is
 * returned without running the loader — so a new key is the only way to make
 * every client drop them. manga:list and manga:search keep their keys: their
 * loaders never cached a failure.
 */
export async function fetchMangaDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail>(
    `manga:detail:v2:${id}`,
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
      // Throws on web (see mangaDexReachable) and on any MangaDex failure.
      const json = await mangaDexJson(`/manga/${encodeURIComponent(id)}`, {
        'includes[]': ['cover_art'],
      });
      const manga = json.data;
      if (!manga?.id) throw new Error('Title not found.');
      return {
        id: manga.id,
        title: mangaDexTitle(manga.attributes),
        cover: mangaDexCover(manga),
        description: manga.attributes?.description?.en || '',
        genres: mangaDexGenres(manga.attributes),
        status: manga.attributes?.status || '',
        type: 'Manga',
      };
    },
    { staleIfError: true },
  ).catch(() => null);
}

export async function fetchMangaChapters(id: string): Promise<MangaChapter[]> {
  const chapters = await getOrSetCached<MangaChapter[]>(
    // v3 also drops lists picked before pickScanlationChapters filled in the
    // newest chapters from other groups.
    `manga:chapters:v3:${id}`,
    15 * 60 * 1000,
    async () => {
      const res = await atsuFetch(`/api/manga/allChapters?mangaId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`atsu HTTP ${res.status}`);
      const json = await res.json();
      const raw: any[] = json.chapters || [];
      const list = pickScanlationChapters(raw).map(mapRawChapter);
      if (!list.length) throw new Error('No chapters.');
      return list;
    },
    { staleIfError: true },
  ).catch(() => [] as MangaChapter[]);
  if (chapters.length > 0) {
    return chapters.map((ch) => (ch.coverUrl ? { ...ch, coverUrl: displayPageUrl(ch.coverUrl) } : ch));
  }
  if (!mangaDexReachable()) return [];

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

/** Absolute URL for an atsu image path; chapter pages resolve to the CDN host. */
export function toPageUrl(imagePath: string): string {
  return absUrl(imagePath);
}

/**
 * Page image URLs for a manga chapter (atsu), [] when unavailable.
 *
 * On web these are same-origin /api/manga-page/ URLs, because the browser can
 * load neither atsu host directly (see atsuPageCdnUrl). The web downloader
 * unwraps them again to reach its fallback route, so the wrapping is the only
 * form any web caller needs.
 */
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
          return path ? displayPageUrl(path) : '';
        })
        .filter(Boolean);
      if (pages.length > 0) return pages;
    }
  } catch {
    // Fall through to MangaDex at-home server.
  }
  if (!mangaDexReachable()) return [];

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
      // atsu removed its REST search API (`POST /api/explore/filteredView` now
      // 404s, which silently broke manga search). The site itself queries its
      // Typesense index through this unauthenticated same-origin proxy, so we
      // do the same. GET, no body, `page` is 1-based here.
      const params = new URLSearchParams({
        q: query.trim(),
        query_by: 'title,englishTitle,otherNames,authors',
        query_by_weights: '4,3,2,1',
        num_typos: '4,3,2,1',
        include_fields:
          'id,title,englishTitle,poster,posterSmall,posterMedium,type,isAdult,status,year,mbRating,popularity',
        filter_by: 'hidden:!=true && isAdult:=false && type:=[Manga,Manwha,Manhua,OEL]',
        infix: 'off,off,fallback,off', // partial words: "blackfi" -> "God of Blackfield"
        page: '1',
        per_page: String(limit),
      });

      try {
        const res = await atsuFetch(`/collections/manga/documents/search?${params.toString()}`);
        if (!res.ok) throw new Error(`atsu search ${res.status}`);
        const json = await res.json();
        const items = ((json.hits || []) as any[])
          .map((h) => h.document)
          .filter((d) => d?.id && (d.title || d.englishTitle))
          .map(
            (d): AtsuItem => ({
              id: d.id,
              title: d.title || d.englishTitle,
              // Typesense returns "/static/posters/x.jpg"; absUrl() normalizes
              // the leading slash and the `static/` prefix. There is no
              // posterLarge field, so `poster` doubles as the large image.
              image: d.posterSmall || d.poster,
              mediumImage: d.posterMedium || d.poster,
              largeImage: d.poster,
              type: d.type,
            }),
          )
          .slice(0, limit);
        // A genuine "no results" from atsu stays an empty list on web rather
        // than becoming a MangaDex request that can only fail.
        return items.length > 0 || !mangaDexReachable() ? items : mangaDexSearch(query.trim(), limit);
      } catch {
        return mangaDexSearch(query.trim(), limit);
      }
    },
    { staleIfError: true },
  );
}
