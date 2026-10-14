/**
 * Web-only client for the same-origin catalogue route, /api/catalog/ (hosting
 * repo: api/catalog.js + lib/catalog.js).
 *
 * Why: every atsu and manhwa read on web was a cross-origin POST to the
 * web-content-proxy edge function — a CORS preflight, a second TLS
 * connection, Deno overhead, and nothing any CDN could cache — 0.6–1.2 s per
 * call, and 1.5–3.5 s whenever the droplet had to scrape. The same data as a
 * same-origin GET is cached at Vercel's edge (with stale-while-revalidate), so
 * a repeat in the same region answers in ~80 ms and never waits on a scrape.
 *
 * The route is a cache in front of the edge function, not a replacement:
 * - it only covers requests that map exactly onto one of its operations
 *   (atsuCatalogRequest / manhwaCatalogRequest return null for anything else,
 *   which the callers send to the edge function as before);
 * - on a clean 200 it returns the upstream JSON the edge function would have
 *   returned, so callers' parsers and error handling are unchanged;
 * - on anything else — an error, the route not deployed (a dev server, an
 *   older hosting deploy), a timeout — fetchCatalog reports a miss and the
 *   caller asks the edge function, which defines the error the app sees.
 *
 * The canonical URLs below must match lib/catalog.js in the hosting repo
 * exactly (parameter names, order and value spelling): it refuses any other
 * form so that one title is one edge-cache entry. Both repos' tests pin the
 * same examples (test/catalog-client.test.mjs, scripts/catalog.test.cjs).
 */

export const CATALOG_PATH = '/api/catalog/';

/**
 * The route answers its own 504 after 9 s; this only catches a route that is
 * hung, and leaves the edge function its full 25 s afterwards.
 */
export const CATALOG_TIMEOUT_MS = 11_000;

/**
 * After the route itself fails (not one title — the route), skip it for this
 * long, so a missing deploy or an outage costs one extra request per few
 * minutes rather than one per call.
 */
export const CATALOG_RETRY_AFTER_MS = 2 * 60_000;

export type CatalogRequest = {
  source: 'atsu' | 'manhwa';
  op: string;
  /** Parameters in the route's canonical order. */
  params: [string, string][];
};

export type CatalogResult<T> = { ok: true; data: T } | { ok: false };

const MISS: CatalogResult<never> = { ok: false };

// Must match TYPES and searchManga's Typesense parameters in lib/manga.ts and
// the constants in the hosting repo's lib/catalog.js. A request that differs
// in any of them is not mapped, so a change on one side degrades to the edge
// function instead of returning the wrong results.
const ATSU_TYPES = 'Manga,Manwha,Manhua,OEL';
const ATSU_SEARCH_FIXED: Record<string, string> = {
  query_by: 'title,englishTitle,otherNames,authors',
  query_by_weights: '4,3,2,1',
  num_typos: '4,3,2,1',
  include_fields: 'id,title,englishTitle,poster,posterSmall,posterMedium,type,isAdult,status,year,mbRating,popularity',
  filter_by: 'hidden:!=true && isAdult:=false && type:=[Manga,Manwha,Manhua,OEL]',
  infix: 'off,off,fallback,off',
  page: '1',
};

// Genre/status browsing as browseManga sends it. Must match mangaBrowseFilter
// and SORT_BY in lib/manga.ts and atsuBrowseFilter in the hosting repo's
// lib/catalog.js, which rebuilds the filter from the genre and status alone.
const ATSU_BROWSE_FILTER = new RegExp(
  '^hidden:!=true && isAdult:=false && medium:=Comic && type:=\\[Manga,Manwha,Manhua,OEL\\] && genreIds:!=\\[10,41,46\\]' +
    '(?: && genreWeightKeys:=\\[`([1-9][0-9]{0,3}):core`,`\\1:defining`\\])?' +
    '(?: && status:=(Ongoing|Completed|Hiatus))?$',
);
const ATSU_BROWSE_SORTS: Record<string, string> = {
  'views:desc': 'popular',
  'mbRating:desc': 'rating',
  'trending:desc': 'trending',
  'dateAdded:desc': 'added',
};
const ATSU_BROWSE_FIELDS = 'id,title,englishTitle,poster,posterSmall,posterMedium,type,mbRating';

const ATSU_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MANHWA_ID = /^(?:mr|cz):[\p{L}\p{N}][\p{L}\p{N}._~-]{0,199}$/u;
const MANHWA_CHAPTER = /^[\p{L}\p{N}][\p{L}\p{N}._~-]{0,199}$/u;

function hasExactly(query: Record<string, string>, keys: string[]): boolean {
  const present = Object.keys(query);
  return present.length === keys.length && keys.every((key) => typeof query[key] === 'string');
}

function isInt(value: string, min: number, max: number): boolean {
  if (!/^(?:0|[1-9][0-9]{0,5})$/.test(value)) return false;
  const n = Number(value);
  return n >= min && n <= max;
}

function isSearchText(value: string): boolean {
  return !!value && value.length <= 200 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The route URL for a request; the one spelling the route accepts. */
export function catalogUrl(req: CatalogRequest): string {
  const query = new URLSearchParams([['s', req.source], ['op', req.op], ...req.params]);
  return `${CATALOG_PATH}?${query.toString()}`;
}

function atsuBrowseRequest(q: Record<string, string>): CatalogRequest | null {
  if (!hasExactly(q, ['q', 'filter_by', 'sort_by', 'include_fields', 'page', 'per_page'])) return null;
  if (q.include_fields !== ATSU_BROWSE_FIELDS || !isInt(q.page, 1, 500) || !isInt(q.per_page, 1, 60)) return null;
  const sort = Object.prototype.hasOwnProperty.call(ATSU_BROWSE_SORTS, q.sort_by) ? ATSU_BROWSE_SORTS[q.sort_by] : null;
  const filter = ATSU_BROWSE_FILTER.exec(q.filter_by);
  if (!sort || !filter) return null;
  return {
    source: 'atsu',
    op: 'browse',
    params: [['genre', filter[1] ?? ''], ['status', filter[2] ?? ''], ['sort', sort], ['page', q.page], ['limit', q.per_page]],
  };
}

/**
 * The catalogue operation for an atsu request as lib/manga.ts makes it
 * (path without host, decoded query), or null when it is not one.
 */
export function atsuCatalogRequest(
  pathname: string,
  query: Record<string, string> | undefined,
  method: string = 'GET',
): CatalogRequest | null {
  if (method.toUpperCase() !== 'GET') return null;
  const q = query || {};
  const list = /^\/api\/infinite\/(trending|popular)$/.exec(pathname);
  if (list) {
    if (!hasExactly(q, ['page', 'types']) || q.types !== ATSU_TYPES || !isInt(q.page, 0, 50)) return null;
    return { source: 'atsu', op: list[1], params: [['page', q.page]] };
  }
  const updates = /^\/api\/home2\/(recentlyUpdated|hotUpdates)$/.exec(pathname);
  if (updates) {
    if (!hasExactly(q, ['offset', 'limit', 'types', 'mediums']) || q.types !== ATSU_TYPES || q.mediums !== 'Comic') return null;
    if (!isInt(q.offset, 0, 2000) || !isInt(q.limit, 1, 60)) return null;
    return { source: 'atsu', op: updates[1], params: [['offset', q.offset], ['limit', q.limit]] };
  }
  switch (pathname) {
    case '/api/manga/page':
      return hasExactly(q, ['id']) && ATSU_ID.test(q.id)
        ? { source: 'atsu', op: 'detail', params: [['id', q.id]] }
        : null;
    case '/api/manga/allChapters':
      return hasExactly(q, ['mangaId']) && ATSU_ID.test(q.mangaId)
        ? { source: 'atsu', op: 'chapters', params: [['id', q.mangaId]] }
        : null;
    case '/api/read/chapter':
      return hasExactly(q, ['mangaId', 'chapterId']) && ATSU_ID.test(q.mangaId) && ATSU_ID.test(q.chapterId)
        ? { source: 'atsu', op: 'read', params: [['mangaId', q.mangaId], ['chapterId', q.chapterId]] }
        : null;
    case '/collections/manga/documents/search': {
      if (q.q === '*') return atsuBrowseRequest(q);
      const fixed = Object.keys(ATSU_SEARCH_FIXED);
      if (!hasExactly(q, ['q', 'per_page', ...fixed])) return null;
      if (fixed.some((key) => q[key] !== ATSU_SEARCH_FIXED[key])) return null;
      if (!isSearchText(q.q) || !isInt(q.per_page, 1, 100)) return null;
      return { source: 'atsu', op: 'search', params: [['q', q.q], ['limit', q.per_page]] };
    }
    default:
      return null;
  }
}

/**
 * The catalogue operation for a manhwa scraper request as lib/manhwa.ts makes
 * it, or null. The ranges are the droplet's own clamps, so a mapped request
 * gets exactly the answer it asked for.
 */
export function manhwaCatalogRequest(
  pathname: string,
  query: Record<string, string> | undefined,
): CatalogRequest | null {
  const q = query || {};
  switch (pathname) {
    case '/popular':
      return hasExactly(q, ['limit']) && isInt(q.limit, 1, 60)
        ? { source: 'manhwa', op: 'popular', params: [['limit', q.limit]] }
        : null;
    case '/search':
      return hasExactly(q, ['q', 'limit', 'offset']) && isSearchText(q.q) && isInt(q.limit, 1, 60) && isInt(q.offset, 0, 500)
        ? { source: 'manhwa', op: 'search', params: [['q', q.q], ['limit', q.limit], ['offset', q.offset]] }
        : null;
    case '/details':
      return hasExactly(q, ['id']) && MANHWA_ID.test(q.id)
        ? { source: 'manhwa', op: 'details', params: [['id', q.id]] }
        : null;
    case '/chapters':
      return hasExactly(q, ['id', 'limit', 'offset']) && MANHWA_ID.test(q.id) && isInt(q.limit, 1, 2000) && isInt(q.offset, 0, 5000)
        ? { source: 'manhwa', op: 'chapters', params: [['id', q.id], ['limit', q.limit], ['offset', q.offset]] }
        : null;
    case '/pages':
      return hasExactly(q, ['id', 'chapterId']) && MANHWA_ID.test(q.id) && MANHWA_CHAPTER.test(q.chapterId)
        ? { source: 'manhwa', op: 'pages', params: [['id', q.id], ['chapterId', q.chapterId]] }
        : null;
    default:
      return null;
  }
}

/**
 * Consecutive failed answers from one operation's upstream before that
 * operation is skipped for CATALOG_RETRY_AFTER_MS. One failure is usually one
 * title (a droplet scrape that broke), and the next title should still get
 * the cache. Two in a row more likely means the upstream refuses the route
 * itself — atsu blocking Vercel's addresses, a rate limit on its egress, or
 * the two repos' parameter rules drifting apart — and without a pause every
 * read would pay a function round trip, and hit the upstream twice, before
 * the edge function answered: slower than before the route existed.
 */
export const CATALOG_OP_FAILURES_BEFORE_PAUSE = 2;

let routeDownUntil = 0;
const opFailures = new Map<string, number>();
const opDownUntil = new Map<string, number>();

function markRouteDown() {
  routeDownUntil = Date.now() + CATALOG_RETRY_AFTER_MS;
}

function opKey(req: CatalogRequest): string {
  return `${req.source}:${req.op}`;
}

function noteOpAnswered(req: CatalogRequest) {
  opFailures.delete(opKey(req));
}

function noteOpFailed(req: CatalogRequest) {
  const key = opKey(req);
  const failures = (opFailures.get(key) || 0) + 1;
  if (failures < CATALOG_OP_FAILURES_BEFORE_PAUSE) {
    opFailures.set(key, failures);
    return;
  }
  opFailures.delete(key);
  opDownUntil.set(key, Date.now() + CATALOG_RETRY_AFTER_MS);
}

/** Forget previous route failures (tests; and nothing else needs it). */
export function resetCatalogRoute() {
  routeDownUntil = 0;
  opFailures.clear();
  opDownUntil.clear();
}

/**
 * GET the route. { ok: true, data } only for a 200 JSON answer; every other
 * outcome is a miss the caller answers from the edge function. The route's
 * own JSON errors (code CATALOG_*) are a miss for that call: a not-found is
 * about one title, and any other one counts towards pausing that operation
 * (CATALOG_OP_FAILURES_BEFORE_PAUSE). Anything else means the route is
 * unavailable, and it is skipped for CATALOG_RETRY_AFTER_MS.
 *
 * No custom headers: the edge cache keys on Accept, and a plain fetch sends
 * the same Accept as a <link rel="preload" as="fetch"> of the same URL, so a
 * preloaded answer and the app's own request share one cache entry.
 */
export async function fetchCatalog<T>(req: CatalogRequest): Promise<CatalogResult<T>> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return MISS;
  if (Date.now() < routeDownUntil || Date.now() < (opDownUntil.get(opKey(req)) || 0)) return MISS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(catalogUrl(req), { signal: controller.signal });
    if (!(res.headers.get('content-type') || '').includes('application/json')) {
      // An HTML page (dev server, Vercel's 404 before the route is deployed)
      // or a platform error page: not our route answering.
      void res.body?.cancel().catch(() => {});
      markRouteDown();
      return MISS;
    }
    const data = (await res.json()) as unknown;
    if (!res.ok) {
      const code = (data as { code?: unknown } | null)?.code;
      if (!(typeof code === 'string' && code.startsWith('CATALOG_'))) markRouteDown();
      else if (code === 'CATALOG_NOT_FOUND') noteOpAnswered(req);
      else noteOpFailed(req);
      return MISS;
    }
    noteOpAnswered(req);
    return { ok: true, data: data as T };
  } catch {
    // Network failure, timeout, or a body that is not the JSON it claimed.
    markRouteDown();
    return MISS;
  } finally {
    clearTimeout(timer);
  }
}
