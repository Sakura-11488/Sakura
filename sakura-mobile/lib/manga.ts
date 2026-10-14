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
  /** MangaBaka score out of 10, on list rows (trending, popular, updates). */
  mbRating?: number;
  /** Abbreviated view count as atsu prints it ("3.1M"). */
  views?: string;
  /** ms since epoch: when a chapter last landed (recently-updated rows only). */
  updatedAt?: number;
  isAdult?: boolean;
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
    // List rows carry atsu's score; dropping it here is why the web cards'
    // ★ badge (MangaHomeWeb) never showed for atsu titles.
    ...(typeof item.mbRating === 'number' && item.mbRating > 0 ? { score: Math.round(item.mbRating * 10) / 10 } : {}),
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

/**
 * atsu spells Korean webtoons 'Manwha'. Kept here rather than imported from
 * lib/chapter-progress (which has the same rule for screens) so this module's
 * tests can load it with no other app modules.
 */
function displayMangaType(type: unknown): string {
  const t = typeof type === 'string' ? type.trim() : '';
  return /^manwha$/i.test(t) ? 'Manhwa' : t;
}

/** A title linked from a series page: a sequel, prequel or similar series. */
export interface MangaRelatedTitle {
  id: string;
  title: string;
  cover: string;
  /** Display type: 'Manga', 'Manhwa', 'Manhua', 'OEL'. */
  type?: string;
  /** For relations: 'Sequel', 'Prequel', 'Spin-off', … as atsu names them. */
  relation?: string;
  rating?: number;
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
  /*
   * Everything below is optional: atsu's /api/manga/page returns it (and
   * Sakura used to throw it away), the scrapers mostly do not, and offline
   * snapshots never kept it. Screens show each part only when present.
   */
  /** Story credits. */
  authors?: string[];
  /** Art credits, when atsu lists them separately from the story. */
  artists?: string[];
  /** Other names the series goes by (original script, translations), deduped. */
  altTitles?: string[];
  /** Trope tags beyond the genres ("Regression", "Weak to Strong"), strongest first. */
  tags?: string[];
  /** "9.5M", as atsu prints it. */
  views?: string;
  /** Year of first publication. */
  year?: number;
  /** Sequels, prequels and other relations. */
  related?: MangaRelatedTitle[];
  /** atsu's recommendations and similar series, merged and deduped. */
  similar?: MangaRelatedTitle[];
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
    // v3: credits, alternative titles, tags, relations and similar titles, the
    // real rating (avgRating), and 'Manwha' shown as 'Manhwa'. A v2 entry
    // lacks all of them and would hide them for its whole TTL.
    `manga:detail:v3:${id}`,
    30 * 60 * 1000,
    async () => {
      try {
        const res = await atsuFetch(`/api/manga/page?id=${encodeURIComponent(id)}`);
        if (res.ok) {
          const json = await res.json();
          const p = json.mangaPage;
          if (p?.title) return parseAtsuMangaPage(p, id);
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

/** Tag weights atsu marks as central to a series, strongest first. */
const TAG_WEIGHT_ORDER: Record<string, number> = { Core: 0, Defining: 1, Recurrent: 2 };
/** Enough to describe a series; the long tail of 50+ trope tags is noise on a title page. */
const MAX_DETAIL_TAGS = 14;
const MAX_ALT_TITLES = 12;
const MAX_SIMILAR = 20;

function nameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: unknown } | null)?.name))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());
}

function uniqueStrings(values: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((v) => v.toLocaleLowerCase()));
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** A list row (recommendation, relation) as a linkable title; null for adult or malformed rows. */
function relatedTitle(raw: any, relation?: string): MangaRelatedTitle | null {
  if (!raw || typeof raw !== 'object' || raw.isAdult === true) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const title = typeof raw.title === 'string' ? raw.title : '';
  if (!id || !title) return null;
  return {
    id,
    title,
    cover: imgUrl(raw as AtsuItem, 'medium'),
    ...(raw.type ? { type: displayMangaType(raw.type) } : {}),
    ...(relation ? { relation } : {}),
    ...(typeof raw.mbRating === 'number' && raw.mbRating > 0 ? { rating: Math.round(raw.mbRating * 10) / 10 } : {}),
  };
}

/**
 * atsu's /api/manga/page payload → MangaDetail. Exported for the tests, which
 * pin it against a trimmed copy of a live answer.
 *
 * The payload is ~100–125 KB (forum reviews, commenter profiles, the newest
 * 80 chapters); only what a title page shows is kept, so the cached entry
 * stays a few KB.
 */
export function parseAtsuMangaPage(p: any, fallbackId: string): MangaDetail {
  // Cover is nested under poster — same as the capacitor app
  const cover = absUrl(p.poster?.largeImage || p.poster?.mediumImage || p.poster?.image);
  const credits = Array.isArray(p.authors) ? p.authors : [];
  const byRole = (role: string) => uniqueStrings(nameList(
    credits.filter((c: any) => String(c?.type || '').toLowerCase() === role),
  ));
  const story = byRole('author');
  const art = byRole('artist');
  const rating = typeof p.avgRating === 'number' ? p.avgRating : typeof p.rating === 'number' ? p.rating : undefined;
  const genres = nameList(p.genres);
  const tags = (Array.isArray(p.tags) ? p.tags : [])
    .filter((t: any) => t && typeof t.name === 'string' && t.weight in TAG_WEIGHT_ORDER)
    .sort((a: any, b: any) => TAG_WEIGHT_ORDER[a.weight] - TAG_WEIGHT_ORDER[b.weight]);
  const title = p.title || p.englishTitle || fallbackId;
  const year = typeof p.released === 'number' && p.released > 0 ? new Date(p.released).getUTCFullYear() : undefined;
  const related = (Array.isArray(p.relations) ? p.relations : [])
    .map((r: any) => relatedTitle(r?.manga, typeof r?.type === 'string' ? r.type : undefined))
    .filter(Boolean) as MangaRelatedTitle[];
  const relatedIds = new Set([p.id || fallbackId, ...related.map((r) => r.id)]);
  const similar: MangaRelatedTitle[] = [];
  for (const raw of [...(Array.isArray(p.recommendations) ? p.recommendations : []), ...(Array.isArray(p.similarManga) ? p.similarManga : [])]) {
    const item = relatedTitle(raw);
    if (!item || relatedIds.has(item.id)) continue;
    relatedIds.add(item.id);
    similar.push(item);
    if (similar.length >= MAX_SIMILAR) break;
  }
  return {
    id: p.id || fallbackId,
    title,
    cover,
    description: p.synopsis || '',
    genres,
    status: p.status || '',
    type: displayMangaType(p.type),
    ...(typeof rating === 'number' && rating > 0 ? { rating: Math.round(rating * 100) / 100 } : {}),
    ...(story.length ? { authors: story } : {}),
    // An artist who also wrote it is credited once, as the author.
    ...(uniqueStrings(art, story).length ? { artists: uniqueStrings(art, story) } : {}),
    ...(() => {
      const alt = uniqueStrings(nameList(p.otherNames).concat(p.englishTitle ? [p.englishTitle] : []), [title]).slice(0, MAX_ALT_TITLES);
      return alt.length ? { altTitles: alt } : {};
    })(),
    ...(tags.length ? { tags: uniqueStrings(tags.map((t: any) => t.name.trim()), genres).slice(0, MAX_DETAIL_TAGS) } : {}),
    ...(typeof p.views === 'string' && p.views ? { views: p.views } : {}),
    ...(year && year > 1900 ? { year } : {}),
    ...(related.length ? { related } : {}),
    ...(similar.length ? { similar } : {}),
  };
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

// ─── Genre browsing ──────────────────────────────────────────────────────────

/**
 * atsu's genres, by the ids its Typesense index files them under (genreIds,
 * genreWeightKeys). The index cannot facet these fields, so the list is fixed:
 * ids read off live documents (Oct 2026), which line up 1:1 with the names in
 * each document's `tags`. Hentai (10), Smut (41) and Adult (46) are left out
 * on purpose and also excluded from every query below.
 *
 * The home "genre" shelves used to be TITLE searches — searchManga('action')
 * returned "Action Idols" and "Action Mask", and nothing tagged Action.
 */
export const ATSU_GENRES: readonly { id: string; name: string }[] = [
  { id: '39', name: 'Action' },
  { id: '37', name: 'Adventure' },
  { id: '6', name: 'Comedy' },
  { id: '31', name: 'Drama' },
  { id: '36', name: 'Fantasy' },
  { id: '9', name: 'Romance' },
  { id: '7', name: 'Slice of Life' },
  { id: '22', name: 'Supernatural' },
  { id: '32', name: 'Mystery' },
  { id: '18', name: 'Psychological' },
  { id: '29', name: 'Martial Arts' },
  { id: '1', name: 'Sci-Fi' },
  { id: '45', name: 'Historical' },
  { id: '44', name: 'Horror' },
  { id: '19', name: 'Thriller' },
  { id: '5', name: 'Tragedy' },
  { id: '180', name: 'Boys Love' },
  { id: '4', name: 'Girls Love' },
];

const EXCLUDED_GENRE_IDS = '10,41,46';

/** The genre id for a name as atsu writes it ("Slice of Life"), or null when it is not one of ATSU_GENRES. */
export function atsuGenreId(name: string | null | undefined): string | null {
  const key = String(name || '').trim().toLowerCase();
  return ATSU_GENRES.find((g) => g.name.toLowerCase() === key)?.id ?? null;
}

export type MangaBrowseSort = 'popular' | 'rating' | 'trending' | 'added';
export type MangaBrowseStatus = 'Ongoing' | 'Completed' | 'Hiatus';

export const MANGA_BROWSE_SORTS: readonly { id: MangaBrowseSort; label: string }[] = [
  { id: 'popular', label: 'Most viewed' },
  { id: 'trending', label: 'Trending' },
  { id: 'rating', label: 'Top rated' },
  { id: 'added', label: 'Recently added' },
];

const SORT_BY: Record<MangaBrowseSort, string> = {
  popular: 'views:desc',
  rating: 'mbRating:desc',
  trending: 'trending:desc',
  added: 'dateAdded:desc',
};

export interface MangaBrowseQuery {
  /** One of ATSU_GENRES' ids. */
  genreId?: string | null;
  status?: MangaBrowseStatus | null;
  sort?: MangaBrowseSort;
}

/** Typesense filter for a browse query. Exported for the tests. */
export function mangaBrowseFilter(query: MangaBrowseQuery): string {
  const parts = [
    'hidden:!=true',
    'isAdult:=false',
    // Comics only: atsu also indexes light novels, which this reader cannot open.
    'medium:=Comic',
    `type:=[${TYPES}]`,
    `genreIds:!=[${EXCLUDED_GENRE_IDS}]`,
  ];
  const genre = query.genreId && ATSU_GENRES.some((g) => g.id === query.genreId) ? query.genreId : null;
  // "Defining" or "core" only: a genre atsu marks as merely present (Horror
  // on The Greatest Estate Developer, Slice of Life on One Piece) put famous
  // titles at the top of shelves they do not belong on. "Core" is atsu's
  // strongest weight (Martial Arts on Lookism and Absolute Regression, Action
  // on Solo Leveling: Arise); matching "defining" alone left those titles off
  // the very shelf they are most about.
  if (genre) parts.push(`genreWeightKeys:=[\`${genre}:core\`,\`${genre}:defining\`]`);
  if (query.status === 'Ongoing' || query.status === 'Completed' || query.status === 'Hiatus') {
    parts.push(`status:=${query.status}`);
  }
  return parts.join(' && ');
}

export interface MangaBrowsePage {
  items: AtsuItem[];
  /** Total matches atsu reports for the query. */
  found: number;
  hasMore: boolean;
}

/**
 * One page (0-based) of atsu's catalogue filtered by genre and status, in the
 * chosen order. Through the same Typesense proxy as searchManga, with q='*'.
 * Rejects when atsu cannot be reached (a browse grid shows Retry); an empty
 * page is a real answer.
 */
export async function browseManga(query: MangaBrowseQuery, page = 0, perPage = 30): Promise<MangaBrowsePage> {
  const sort = query.sort && SORT_BY[query.sort] ? query.sort : 'popular';
  const p = Math.max(0, Math.floor(page) || 0);
  const size = Math.max(1, Math.min(60, Math.floor(perPage) || 30));
  const filter = mangaBrowseFilter(query);
  return getOrSetCached<MangaBrowsePage>(
    `manga:browse:v1:${filter}:${sort}:${p}:${size}`,
    10 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({
        q: '*',
        filter_by: filter,
        sort_by: SORT_BY[sort],
        include_fields: 'id,title,englishTitle,poster,posterSmall,posterMedium,type,mbRating',
        page: String(p + 1),
        per_page: String(size),
      });
      const res = await atsuFetch(`/collections/manga/documents/search?${params.toString()}`);
      if (!res.ok) throw new Error(`atsu browse ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json?.hits)) throw new Error('atsu browse: no hits');
      const items = (json.hits as any[])
        .map((h) => h?.document)
        .filter((d) => d?.id && (d.title || d.englishTitle))
        .map((d): AtsuItem => ({
          id: d.id,
          title: d.title || d.englishTitle,
          image: d.posterSmall || d.poster,
          mediumImage: d.posterMedium || d.poster,
          largeImage: d.poster,
          type: d.type,
          ...(typeof d.mbRating === 'number' ? { mbRating: d.mbRating } : {}),
        }));
      const found = typeof json.found === 'number' ? json.found : items.length;
      return { items, found, hasMore: (p + 1) * size < found && items.length > 0 };
    },
    { staleIfError: true },
  );
}

// ─── Recently updated ────────────────────────────────────────────────────────

/**
 * Titles that just got a chapter, newest first, as atsu's own "Recently
 * Updated" and "Hot Updates" shelves list them (/api/home2/*). Each row
 * carries `updatedAt`.
 *
 * mediums=Comic matters: without it 31 of the first 40 recently-updated rows
 * were light novels (atsu indexes those too), which this reader cannot open.
 * The older /api/infinite/recentlyUpdated ignores every medium parameter.
 */
async function fetchUpdatesList(kind: 'recentlyUpdated' | 'hotUpdates', offset: number, limit: number): Promise<AtsuItem[]> {
  const params = new URLSearchParams({
    offset: String(Math.max(0, Math.floor(offset) || 0)),
    limit: String(Math.max(1, Math.min(60, Math.floor(limit) || 40))),
    types: TYPES,
    mediums: 'Comic',
  });
  return getOrSetCached<AtsuItem[]>(
    `manga:updates:v1:${kind}:${params.toString()}`,
    // Short: the point of the list is what landed in the last few minutes.
    3 * 60 * 1000,
    async () => {
      const res = await atsuFetch(`/api/home2/${kind}?${params.toString()}`);
      if (!res.ok) throw new Error(`atsu ${kind} ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json?.items)) throw new Error(`atsu ${kind}: no items`);
      return (json.items as AtsuItem[]).filter((item) => item?.id && item.title && item.isAdult !== true);
    },
    { staleIfError: true },
  );
}

/** One page (0-based, 40 a page) of every comic that just got a chapter. Rejects when atsu is unreachable. */
export function fetchRecentlyUpdatedManga(page = 0, perPage = 40): Promise<AtsuItem[]> {
  return fetchUpdatesList('recentlyUpdated', page * perPage, perPage);
}

/** Popular titles that updated recently — atsu's "Hot Updates". Rejects when atsu is unreachable. */
export function fetchHotUpdatedManga(limit = 20): Promise<AtsuItem[]> {
  return fetchUpdatesList('hotUpdates', 0, limit);
}

// ─── Library update checks ───────────────────────────────────────────────────

/** Ids per Typesense request; a filter list this long is still a short URL. */
const COUNT_CHUNK = 50;
const ATSU_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * atsu's chapter count per title, for many titles in one request per 50 ids.
 *
 * lib/library-updates uses it as a cheap "did anything change?" signal before
 * downloading a full chapter list (Lookism's is 710 KB): a library of 40 atsu
 * titles is one request instead of forty. It is a SIGNAL, not a number to
 * show: atsu counts every scanlation group's extras (Lookism 642 against 628
 * chapters in the merged list). Missing ids are absent from the answer.
 */
export async function fetchAtsuChapterCounts(ids: readonly string[]): Promise<Record<string, number>> {
  const clean = [...new Set(ids.filter((id) => ATSU_ID_RE.test(id)))];
  const out: Record<string, number> = {};
  for (let i = 0; i < clean.length; i += COUNT_CHUNK) {
    const chunk = clean.slice(i, i + COUNT_CHUNK);
    const params = new URLSearchParams({
      q: '*',
      filter_by: `id:=[${chunk.join(',')}]`,
      include_fields: 'id,chapterCount',
      per_page: String(chunk.length),
    });
    const res = await atsuFetch(`/collections/manga/documents/search?${params.toString()}`);
    if (!res.ok) throw new Error(`atsu counts ${res.status}`);
    const json = await res.json();
    for (const hit of Array.isArray(json?.hits) ? json.hits : []) {
      const doc = hit?.document;
      if (doc?.id && typeof doc.chapterCount === 'number') out[doc.id] = doc.chapterCount;
    }
  }
  return out;
}
