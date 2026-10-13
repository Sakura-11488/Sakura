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

function listItems(data: ProxyListResponse): ContentItem[] {
  return (data.items || data.results || []).filter((item) => item && item.id).map(mapListItem);
}

/**
 * Loose title identity, for deduping across the two upstreams.
 *
 * The scraper dedupes within one answer, but not across answers: the same
 * series comes back as `mr:martial-peak` from `/popular` and `cz:martial-peak`
 * from a search, so deduping the merged catalogue by id alone showed Martial
 * Peak, Solo Leveling, Magic Emperor and a few others twice. Case, whitespace
 * and punctuation (including curly quotes and Unicode dashes) are ignored;
 * letters of any script are kept, so non-Latin titles never collapse together.
 * '' means "no usable key" and must not be used to dedupe.
 */
export function manhwaTitleKey(title: string | null | undefined): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s!-\/:-@[-`{-~\u2010-\u2015\u2018\u2019\u201C\u201D]+/g, ' ')
    .trim();
}

/*
 * The catalogue.
 *
 * The scraper has no "list everything" endpoint. `/popular` is a fixed,
 * hand-picked ~19 titles whatever `limit` / `offset` say, and `/search` caps
 * one query at ~36 hits (12 from mangaread, up to 24 from comizy), also
 * whatever `limit` says. Showing only `/popular` is why the Manhwa tab and
 * "View all" stopped at 19 titles. So the catalogue is grown from `/popular`
 * plus searches for words that are common in manhwa TITLES — both upstreams
 * match on series name, so a genre word like "action" returns almost nothing.
 *
 * Every word below was checked against the live scraper (Oct 2026): each one
 * returns 28–36 titles and adds 23–36 not already seen, ~750 titles in all.
 * The order is the browse order, so new words go on the END — inserting one
 * shifts every later page, and an open "View all" grid would skip or repeat.
 */
export const MANHWA_DISCOVERY_QUERIES: readonly string[] = [
  'martial', 'level', 'return', 'regress', 'tower', 'academy',
  'villain', 'solo', 'reincarnat', 'sword', 'hunter', 'demon',
  'magic', 'king', 'dragon', 'lord', 'duke', 'genius',
  'system', 'god', 'emperor', 'knight', 'heaven', 'mage',
];

/** At most this many scraper requests in flight; mangaread 502s under load. */
const DISCOVERY_CONCURRENCY = 3;
/** Above the scraper's per-query cap, so one request returns a word's whole answer. */
const DISCOVERY_QUERY_LIMIT = 48;
/** Roughly how many NEW titles one word adds after dedupe; sizes a browse page. */
const DISCOVERY_YIELD_PER_QUERY = 30;
/** `/popular` ignores this today; asking for more costs nothing if it ever stops. */
const POPULAR_LIMIT = 60;

/**
 * Thrown inside a cached loader so an empty answer is never cached. Tagged
 * rather than subclassed: `instanceof` on Error subclasses is unreliable once
 * Babel's class transform has been through them.
 */
function emptyAnswer(message: string): Error {
  return Object.assign(new Error(message), { manhwaEmptyAnswer: true });
}

function isEmptyAnswer(error: unknown): boolean {
  return !!error && (error as { manhwaEmptyAnswer?: unknown }).manhwaEmptyAnswer === true;
}

/*
 * The building blocks are cached one scraper request at a time, not one
 * assembled list at a time: the home tab's trending(40) and page 0 of "View
 * all" share requests, and a word that failed is not baked into a cached list
 * for the whole TTL — the next load retries just that word. Like the detail
 * and chapter loaders below, each loader THROWS on failure and on an empty
 * answer, so nothing empty is ever cached and staleIfError serves the last
 * good value.
 */
function fetchPopularManhwaList(): Promise<ContentItem[]> {
  return getOrSetCached<ContentItem[]>(
    'manhwa:popular:v1',
    5 * 60 * 1000,
    async () => {
      const items = listItems(await requestProxy<ProxyListResponse>(`/popular?limit=${POPULAR_LIMIT}`));
      if (!items.length) throw emptyAnswer('No popular manhwa.');
      return items;
    },
    { staleIfError: true },
  );
}

function fetchDiscoveryQuery(query: string): Promise<ContentItem[]> {
  return getOrSetCached<ContentItem[]>(
    `manhwa:discover:v1:${query}`,
    10 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({
        q: query,
        limit: String(DISCOVERY_QUERY_LIMIT),
        offset: '0',
      });
      const items = listItems(await requestProxy<ProxyListResponse>(`/search?${params.toString()}`));
      if (!items.length) throw emptyAnswer(`No manhwa for "${query}".`);
      return items;
    },
    { staleIfError: true },
  );
}

/**
 * Run `loaders` in waves of DISCOVERY_CONCURRENCY and merge their answers in
 * LIST order — not completion order, so the grid does not reshuffle between
 * loads — deduped by id and by title (see manhwaTitleKey). No further wave
 * starts once `limit` titles are in hand. A failed loader is skipped; only
 * when every one that ran failed does this throw, because an empty merge is an
 * outage, not an empty catalogue.
 *
 * A wave in which EVERY loader failed also stops the walk. That is the
 * droplet or the proxy being down, not one flaky word, and nothing is cached
 * on failure — so carrying on cost every home load all 25 requests in 9
 * serial round trips (each one as slow as the outage) before it gave up.
 */
async function collectInOrder(
  loaders: ReadonlyArray<() => Promise<ContentItem[]>>,
  limit = Infinity,
): Promise<ContentItem[]> {
  const out: ContentItem[] = [];
  const seen = new Set<string>();
  let lastError: unknown = null;
  for (let i = 0; i < loaders.length && out.length < limit; i += DISCOVERY_CONCURRENCY) {
    const wave = await Promise.allSettled(
      loaders.slice(i, i + DISCOVERY_CONCURRENCY).map((load) => Promise.resolve().then(load)),
    );
    let failed = 0;
    for (const result of wave) {
      if (result.status === 'rejected') {
        lastError = result.reason;
        failed += 1;
        continue;
      }
      for (const item of result.value) {
        const titleKey = manhwaTitleKey(item.title);
        if (seen.has(item.id) || (titleKey && seen.has(`title:${titleKey}`))) continue;
        seen.add(item.id);
        if (titleKey) seen.add(`title:${titleKey}`);
        out.push(item);
      }
    }
    if (failed === wave.length) break;
  }
  if (!out.length) throw lastError ?? new Error('Manhwa are temporarily unavailable.');
  return out.length > limit ? out.slice(0, limit) : out;
}

const discoveryLoaders = (queries: readonly string[]) =>
  queries.map((query) => () => fetchDiscoveryQuery(query));

/**
 * The first `limit` titles of the catalogue: `/popular` first, topped up from
 * the discovery words in order. Resolves [] when nothing at all could be
 * loaded (the rejection is caught outside every cache, as before).
 */
export async function fetchTrendingManhwa(limit = 24): Promise<ContentItem[]> {
  return collectInOrder(
    [fetchPopularManhwaList, ...discoveryLoaders(MANHWA_DISCOVERY_QUERIES)],
    limit,
  ).catch(() => [] as ContentItem[]);
}

/** One `/search` page. An empty page is the end of the results, never cached. */
async function searchManhwaPage(query: string, offset: number, limit: number): Promise<ContentItem[]> {
  try {
    return await getOrSetCached<ContentItem[]>(
      `manhwa:search-page:v1:${limit}:${offset}:${query.toLowerCase()}`,
      10 * 60 * 1000,
      async () => {
        const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
        const items = listItems(await requestProxy<ProxyListResponse>(`/search?${params.toString()}`));
        if (!items.length) throw emptyAnswer('No more manhwa.');
        return items;
      },
      { staleIfError: true },
    );
  } catch (error) {
    if (isEmptyAnswer(error)) return [];
    throw error;
  }
}

export type ManhwaBrowsePage = { items: ContentItem[]; hasMore: boolean };

/**
 * One page of the full-grid "View all" screen.
 *
 * With a query it is plain `/search` offset paging, with more to come while
 * pages come back full (in practice a query ends at ~36 titles). Without one,
 * page 0 is `/popular` plus the first batch of discovery words and each later
 * page is the next batch, sized so a page adds about `pageSize` titles. Pages
 * may repeat titles from earlier pages; the browse screen dedupes them by id
 * and by the adapter's `titleKey` (manhwaTitleKey).
 *
 * Throws when nothing on the page could be loaded, so the screen shows its
 * retry state rather than an empty grid that claims the catalogue ended.
 */
export async function browseManhwa(
  page: number,
  pageSize = 60,
  query?: string,
): Promise<ManhwaBrowsePage> {
  const p = Math.max(0, Math.floor(page) || 0);
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const q = (query ?? '').trim();
  if (q) {
    const items = await searchManhwaPage(q, p * size, size);
    return { items, hasMore: items.length >= size };
  }
  const perPage = Math.max(1, Math.ceil(size / DISCOVERY_YIELD_PER_QUERY));
  const start = p * perPage;
  const end = start + perPage;
  const loaders = discoveryLoaders(MANHWA_DISCOVERY_QUERIES.slice(start, end));
  if (p === 0) loaders.unshift(fetchPopularManhwaList);
  if (!loaders.length) return { items: [], hasMore: false };
  const items = await collectInOrder(loaders);
  return { items, hasMore: end < MANHWA_DISCOVERY_QUERIES.length };
}

export async function searchManhwa(query: string, limit = 24): Promise<ContentItem[]> {
  if (!query.trim()) return fetchTrendingManhwa(limit);
  // An empty answer is returned but not cached: the scraper answers 200 with
  // no items for "no such title", and an upstream failure behind it can look
  // the same; a cached [] would blank that home shelf / search for the TTL.
  return getOrSetCached<ContentItem[]>(
    `manhwa:search:${query.trim().toLowerCase()}:${limit}`,
    10 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ q: query.trim(), limit: String(limit), offset: '0' });
      const items = listItems(await requestProxy<ProxyListResponse>(`/search?${params.toString()}`));
      if (!items.length) throw emptyAnswer(`No manhwa for "${query.trim()}".`);
      return items;
    },
    { staleIfError: true },
  ).catch((error) => {
    if (isEmptyAnswer(error)) return [] as ContentItem[];
    throw error;
  });
}

/**
 * The detail and chapter loaders THROW on failure instead of returning null /
 * []. getOrSetCached stores whatever a loader returns as fresh for the whole
 * TTL, so a swallowed network error used to be cached as "no such manhwa" for
 * 30 minutes — one offline open left the title on "Could not load" long after
 * the connection came back, and Try again could not clear it. Throwing caches
 * nothing and lets staleIfError serve the last good value. An empty answer is
 * not cached either: a failed upstream behind the proxy looks the same.
 *
 * The exported functions still resolve null / [] on failure, as before, by
 * catching outside the cache.
 *
 * The detail, chapter and page keys are versioned (v2) because the previous
 * release's loaders swallowed those errors and cached null / [] under the old
 * keys, and on web that cache lives in localStorage across deploys. A new key
 * strands the poisoned entries, which then age out on their own TTL; reusing
 * the old key would keep serving "Could not load" until they did. Bump the
 * version again whenever a release has cached something wrong under these.
 */
export async function fetchManhwaDetail(id: string): Promise<MangaDetail | null> {
  return getOrSetCached<MangaDetail>(
    `manhwa:detail:v2:${id}`,
    30 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id });
      const data = await requestProxy<ProxyDetailResponse>(`/details?${params.toString()}`);
      const detail =
        (data as { comic?: ProxyDetail }).comic ||
        (data as { manga?: ProxyDetail }).manga ||
        (data as ProxyDetail);
      if (!detail || !detail.id) throw new Error('Manhwa not found.');
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
    },
    { staleIfError: true },
  ).catch(() => null);
}

/**
 * `/chapters` answers at most this many per request, whatever `limit` says.
 * Long-running manhwa routinely pass 300 chapters (God of Blackfield is 328)
 * and the catalogue reaches into the thousands (Martial Peak lists 3864), so
 * this must not inherit the comics client's 500 or the 18+ client's 10 — and
 * one request is not enough either.
 */
const CHAPTERS_PAGE_SIZE = 2000;
/** A backstop on requests per load: 20,000 chapters, far past any real series. */
const CHAPTERS_MAX_PAGES = 10;

/**
 * Every chapter row of a series, in the scraper's order (reading order,
 * ascending), with duplicate ids removed.
 *
 * Paged by offset until a page comes back short: a single request stopped
 * Martial Peak at chapter 2003 of 3862, and the missing ones are the newest —
 * exactly the chapters a reader of a long series is on. A page that adds no id
 * not already seen also ends the walk, so a scraper that ever ignores `offset`
 * costs one extra request rather than ten.
 *
 * A failure on ANY page rejects the whole load, even when earlier pages came
 * back. The alternative, handing back the chapters fetched so far, is the
 * worse failure: a list missing its newest chapters does not look incomplete.
 * It would be cached as the series for the TTL (or, kept out of the cache,
 * still be the list the detail screen, Continue Reading and downloads act on),
 * with reading progress pointing at a chapter that is not there and no error
 * to retry. Rejecting caches nothing, staleIfError serves the last complete
 * list, and with none the screen shows its retry state.
 *
 * Duplicates: mangaread sometimes lists one chapter id twice. Tales of Demons
 * and Gods has `chapter-524-5` at positions 968 and 970: first as "Chapter
 * 524-5", out of place BEFORE 524.1, then as "Chapter 524.5" in its place
 * after it. The two would share a React key and a download slot, so only one
 * is kept — the LATER one, in its own position: it is the upstream's newer,
 * corrected entry, and dropping the earlier copy is what puts the list back in
 * ascending order. Ids repeated across a page boundary (a chapter inserted
 * upstream between two requests shifts the later offsets by one) are caught
 * the same way.
 */
async function fetchManhwaChapterRows(id: string): Promise<ProxyChapter[]> {
  const rows: ProxyChapter[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < CHAPTERS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      id,
      limit: String(CHAPTERS_PAGE_SIZE),
      offset: String(page * CHAPTERS_PAGE_SIZE),
    });
    const data = await requestProxy<ProxyChaptersResponse>(`/chapters?${params.toString()}`);
    const answered = data.issues || data.chapters || [];
    // "Short page" is judged on what the scraper answered, not on what
    // survives the id filter: one id-less row in a full page of 2000 would
    // otherwise end the walk and silently drop every newer chapter.
    const batch = answered.filter((c) => c && c.id != null && String(c.id) !== '');
    const before = seen.size;
    for (const c of batch) seen.add(String(c.id));
    rows.push(...batch);
    if (answered.length < CHAPTERS_PAGE_SIZE || seen.size === before) break;
  }
  const lastIndex = new Map<string, number>();
  rows.forEach((c, idx) => lastIndex.set(String(c.id), idx));
  return rows.filter((c, idx) => lastIndex.get(String(c.id)) === idx);
}

export async function fetchManhwaChapters(id: string): Promise<MangaChapter[]> {
  return getOrSetCached<MangaChapter[]>(
    // v2: also strands lists the previous release cached from one request,
    // cut off at 2000 chapters.
    `manhwa:chapters:v2:${id}`,
    15 * 60 * 1000,
    async () => {
      const chapters = await fetchManhwaChapterRows(id);
      if (!chapters.length) throw new Error('No chapters.');
      // Numbered after paging and dedupe, so the positional fallback counts
      // across the whole series rather than restarting on each page.
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
    },
    { staleIfError: true },
  ).catch(() => [] as MangaChapter[]);
}

export async function fetchManhwaPages(manhwaId: string, rawChapterId: string): Promise<string[]> {
  // Still resolves [] for a chapter with no pages, as before, but never CACHES
  // it: an upstream hiccup behind the scraper (mangaread intermittently answers
  // with an error page) can surface as zero pages, and a cached [] kept that
  // chapter — and its download — unopenable for the full hour. The previous
  // release did cache it, under v1; see fetchManhwaDetail for the versioning.
  return getOrSetCached<string[]>(
    `manhwa:pages:v2:${manhwaId}:${rawChapterId}`,
    60 * 60 * 1000,
    async () => {
      const params = new URLSearchParams({ id: manhwaId, chapterId: rawChapterId });
      const data = await requestProxy<ProxyPagesResponse>(`/pages?${params.toString()}`);
      const pages = (data.pages || data.images || [])
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => proxyManhwaImage(p));
      if (!pages.length) throw emptyAnswer('No pages.');
      return pages;
    },
    { staleIfError: true },
  ).catch((error) => {
    if (isEmptyAnswer(error)) return [] as string[];
    throw error;
  });
}
