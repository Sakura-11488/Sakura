/**
 * AllNovel.org scraper — ported from the Sakura Capacitor app.
 * Scrapes novel listings, details, chapters, and content from allnovel.org.
 */
import { Parser } from 'htmlparser2';
import { getOrSetCached, getCachedValue } from '@/lib/cache';
import {
  fetchSakuraChapterContent,
  fetchSakuraNovelDetail,
} from '@/lib/sakura-novels';
import { fetchNovelHtml } from '@/lib/allnovel-html';
import { stripSourceBoilerplate } from '@/lib/novel-text';

/**
 * Novel source.
 *
 * Was `allnovel.org`, which now 302-redirects every path to novelfull.com —
 * including the list pages. The redirect resolves to a homepage the list parser
 * finds no entries in, so the tab went silently empty rather than erroring:
 * a 200 with unparseable markup looks exactly like a site with no novels.
 *
 * novelfull.com serves the same paths (`most-popular`, `latest-release-novel`,
 * the genre slugs) with the same markup — an `archive` container and
 * `h3.truyen-title > a` per entry — so only the origin changes.
 */
const SITE = 'https://novelfull.com/';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AllNovelItem {
  path: string;
  name: string;
  cover?: string;
  originalCover?: string;
}

export interface AllNovelDetail {
  path: string;
  name: string;
  cover?: string;
  author?: string;
  genres?: string;
  status?: string;
  rating?: number;
  summary?: string;
  chapters: AllNovelChapter[];
  /**
   * novelfull's numeric id, needed for the chapter list request. Present on
   * headers from fetchNovelDetailHeader so the list can load separately.
   */
  novelId?: string;
}

export interface AllNovelChapter {
  path: string;
  name: string;
  releaseTime?: string | null;
  chapterNumber: number;
}

export const ALLNOVEL_GENRES = [
  { label: 'Action',        value: 'genre/Action' },
  { label: 'Adventure',     value: 'genre/Adventure' },
  { label: 'Fantasy',       value: 'genre/Fantasy' },
  { label: 'Romance',       value: 'genre/Romance' },
  { label: 'Isekai',        value: 'genre/Reincarnation' },
  { label: 'Comedy',        value: 'genre/Comedy' },
  { label: 'Drama',         value: 'genre/Drama' },
  { label: 'Mystery',       value: 'genre/Mystery' },
  { label: 'Horror',        value: 'genre/Horror' },
  { label: 'Sci-Fi',        value: 'genre/Sci-fi' },
  { label: 'Slice of Life', value: 'genre/Slice+of+Life' },
  { label: 'Martial Arts',  value: 'genre/Martial+Arts' },
  { label: 'Supernatural',  value: 'genre/Supernatural' },
  { label: 'Historical',    value: 'genre/Historical' },
  { label: 'Psychological', value: 'genre/Psychological' },
  { label: 'Shounen',       value: 'genre/Shounen' },
  { label: 'Shoujo',        value: 'genre/Shoujo' },
  { label: 'Seinen',        value: 'genre/Seinen' },
  { label: 'Xianxia',       value: 'genre/Xianxia' },
  { label: 'Wuxia',         value: 'genre/Wuxia' },
];

// ─── Parser state enum ────────────────────────────────────────────────────────

const enum S {
  Idle, Info, Cover, Author, Genres, Status, Hidden, Summary,
  Stopped, Chapter, ChapterList, NovelName, NovelList,
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

/**
 * Requests already on the wire, by cache key.
 *
 * lib/cache has no in-flight de-duplication, so a prefetch on press-in followed
 * by the real load 100 ms later used to fetch the same page twice. Sharing the
 * promise makes the prefetch a head start rather than a duplicate.
 */
const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Cache a parsed value rather than the page it came from.
 *
 * Raw HTML is 3–4x the size of what the reader needs (a 52 KB chapter page
 * holds ~17 KB of text; one long novel's chapter-list HTML is 667 KB), and
 * every lib/cache miss rewrites the whole cache blob. If the network fails and
 * an older HTML copy is still cached under the previous key, parse that so
 * a chapter that used to open offline still does.
 */
async function getOrSetParsed<T>(
  key: string,
  ttlMs: number,
  url: string,
  parse: (html: string) => T,
): Promise<T> {
  return dedupe(key, () =>
    getOrSetCached<T>(
      key,
      ttlMs,
      async () => {
        try {
          return parse(await fetchNovelHtml(resolveUrl(url)));
        } catch (error) {
          let legacy: string | null = null;
          try {
            legacy = await getCachedValue<string>(`novel:html:${url}`);
          } catch {
            legacy = null;
          }
          if (legacy) return parse(legacy);
          throw error;
        }
      },
      { staleIfError: true },
    ),
  );
}

const DETAIL_TTL = 30 * 60 * 1000;
const LIST_TTL = 10 * 60 * 1000;

/**
 * A novelfull detail page, parsed: ~2 KB in the cache instead of ~63 KB of
 * HTML. Book cards prefetch this on hover, so caching raw pages let a minute
 * of browsing fill lib/cache's whole budget (its eviction then drops every
 * section's catalogue first).
 */
function fetchDetailFields(novelPath: string): Promise<AllNovelDetail> {
  return getOrSetParsed<AllNovelDetail>(`novel:detail:v1:${novelPath}`, DETAIL_TTL, SITE + novelPath, (html) => {
    const parsed = parseNovelDetailHtml(html, novelPath);
    // No title means a challenge or error page: never cache it as the novel.
    if (!parsed.name) throw new Error('The title is not available.');
    return parsed;
  });
}

/** A list page (popular, genre, latest, search), parsed: ~6 KB cached instead of ~70 KB of HTML. */
function fetchNovelList(url: string): Promise<AllNovelItem[]> {
  return getOrSetParsed<AllNovelItem[]>(`novel:list:v1:${url}`, LIST_TTL, url, (html) => parseNovels(html));
}

function resolveUrl(path: string): string {
  if (path.startsWith('http')) return path;
  return new URL(path, SITE).href;
}

// ─── Parse novel list ─────────────────────────────────────────────────────────

function parseNovels(html: string): AllNovelItem[] {
  const items: AllNovelItem[] = [];
  let current: Partial<AllNovelItem> = {};
  const stack: S[] = [S.Idle];
  let divDepth = 0;

  const peek = () => stack[stack.length - 1];
  const push = (s: S) => stack.push(s);
  const pop = () => (stack.length > 1 ? stack.pop() : peek());

  const parser = new Parser({
    onopentag(name, attrs) {
      const state = peek();

      if (
        (attrs.class?.includes('archive') || attrs.class === 'col-content') &&
        (state === S.Idle || state === S.NovelList)
      ) {
        push(S.NovelList);
        divDepth = 0;
      }

      if (state === S.NovelList || state === S.NovelName) {
        switch (name) {
          case 'img': {
            const src = attrs['data-src'] || attrs.src;
            if (src) current.cover = resolveUrl(src);
            break;
          }
          case 'h3':
            if (state === S.NovelList) push(S.NovelName);
            break;
          case 'a':
            if (state === S.NovelName && attrs.href) {
              try {
                current.path = new URL(attrs.href, SITE).pathname.substring(1);
              } catch {
                current.path = attrs.href;
              }
              if (attrs.title) current.name = attrs.title;
            }
            break;
          case 'div':
            divDepth++;
            break;
        }
      }
    },
    ontext(text) {
      if (peek() === S.NovelName && !current.name) {
        const t = text.trim();
        if (t) current.name = t;
      }
    },
    onclosetag(name) {
      const state = peek();
      if (name === 'a' && state === S.NovelName) {
        if (current.name && current.path) {
          items.push({ ...current } as AllNovelItem);
        }
        current = {};
        pop();
      }
      if (name === 'div' && state === S.NovelList) {
        divDepth--;
        if (divDepth < 0) pop();
      }
    },
  });
  parser.write(html);
  parser.end();
  return items;
}

// ─── Parse novel detail ───────────────────────────────────────────────────────

/** The detail page's fields; the chapter list is a separate request. Exported for tests. */
export function parseNovelDetailHtml(html: string, novelPath: string): AllNovelDetail {
  const result: AllNovelDetail = { path: novelPath, name: '', chapters: [] };
  const summaryParts: string[] = [];
  const infoParts: string[] = [];
  const genreParts: string[] = [];
  const authorParts: string[] = [];
  const statusParts: string[] = [];
  let headingParts: string[] | null = null;
  let hasHeadingTitle = false;

  let novelDataId: string | null = null;
  let infoDepth = 0;
  const stack: S[] = [S.Idle];
  const peek = () => stack[stack.length - 1];
  const push = (s: S) => stack.push(s);
  const pop = () => (stack.length > 1 ? stack.pop() : peek());

  const detailParser = new Parser({
    onopentag(name, attrs) {
      const state = peek();
      switch (name) {
        case 'div':
          if (attrs.class === 'books' || attrs.class === 'm-imgtxt') {
            push(S.Cover);
          } else if (attrs.class === 'inner' || attrs.class === 'desc-text') {
            if (state === S.Cover) pop();
            push(S.Summary);
          } else if (attrs.class === 'info') {
            push(S.Info);
            infoDepth = 0;
          }
          if (attrs.id === 'rating' && attrs['data-novel-id']) {
            novelDataId = attrs['data-novel-id'];
          }
          if (state === S.Info) infoDepth++;
          break;
        case 'input':
          // <input type="hidden" id="rateVal" value="8.7"> — the rating pill
          // on both detail screens never showed because this was not parsed.
          if (attrs.id === 'rateVal' && attrs.value) {
            const rating = Number.parseFloat(attrs.value);
            if (Number.isFinite(rating) && rating > 0 && rating <= 10) result.rating = rating;
          }
          break;
        case 'img':
          if (state === S.Cover) {
            const src = attrs.src || attrs['data-cfsrc'] || attrs['data-src'];
            if (src) result.cover = resolveUrl(src);
            if (attrs.title && !hasHeadingTitle) result.name = attrs.title;
          }
          break;
        case 'h3':
          if (state === S.Cover) {
            headingParts = [];
            push(S.NovelName);
          }
          break;
        case 'span':
          if (state === S.Cover && attrs.title) {
            const mapping: Record<string, S> = { Genre: S.Genres, Author: S.Author, Status: S.Status };
            if (mapping[attrs.title]) push(mapping[attrs.title]);
          }
          break;
        case 'br':
          if (state === S.Summary) summaryParts.push('\n');
          break;
        case 'a':
          if (state === S.ChapterList && attrs.href) push(S.Chapter);
          break;
      }
    },
    ontext(text) {
      if (peek() === S.NovelName) {
        headingParts?.push(text);
        return;
      }
      const t = text.trim();
      if (!t) return;
      switch (peek()) {
        case S.Summary:   summaryParts.push(text); break;
        case S.Info:      infoParts.push(t); break;
        case S.Genres:    genreParts.push(text); break;
        case S.Author:    authorParts.push(text); break;
        case S.Status:    statusParts.push(t); break;
      }
    },
    onclosetag(name) {
      const state = peek();
      switch (name) {
        case 'div':
          if (state === S.Info) {
            infoDepth--;
            infoParts.push('\n');
            if (infoDepth < 0) pop();
          } else if (
            state === S.Genres || state === S.Author ||
            state === S.Status || state === S.Summary
          ) {
            pop();
          }
          break;
        case 'h3':
          if (state === S.NovelName) {
            // The cover's title attribute is a fallback, not a prefix. Keep
            // one complete heading even when responsive markup repeats it.
            const heading = headingParts?.join('').replace(/\s+/g, ' ').trim();
            if (heading && !hasHeadingTitle) {
              result.name = heading;
              hasHeadingTitle = true;
            }
            headingParts = null;
            pop();
          }
          break;
        case 'li': if (state === S.Info) infoParts.push('\n'); break;
        case 'ul': if (state === S.Info || state === S.ChapterList) pop(); break;
      }
    },
    onend() {
      if (infoParts.length) {
        infoParts
          .join('')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes(':'))
          .forEach((line) => {
            const [key, ...rest] = line.split(':');
            const val = rest.join(':').split(',').map((s) => s.trim()).join(', ');
            switch (key.trim().toLowerCase()) {
              case 'author': result.author = val; break;
              case 'genre':  result.genres = val; break;
              case 'status': result.status = val.toLowerCase(); break;
            }
          });
        if (!novelDataId) {
          const m = novelPath.match(/\d+/);
          novelDataId = m ? m[0] : null;
        }
      } else {
        result.genres = genreParts.join('').trim();
        result.author = authorParts.join('').trim();
        result.status = statusParts.join('').toLowerCase();
      }
      result.summary = summaryParts.join('\n\n').trim();
    },
  });
  detailParser.write(html);
  detailParser.end();
  if (novelDataId) result.novelId = novelDataId;
  return result;
}

/**
 * Title, cover, synopsis and metadata — without waiting for the chapter list.
 *
 * Opening a novel used to be three requests in a row (is it ours? → detail
 * page → chapter list, 1.33 s measured) and nothing rendered until the last
 * one. For novelfull paths (they always end in ".html"; Sakura slugs never
 * do) the detail page is now requested at the same time as the Sakura check,
 * and the screens render this header while the chapter list loads.
 *
 * Sakura originals come back complete, chapters included.
 */
export async function fetchNovelDetailHeader(novelPath: string): Promise<AllNovelDetail> {
  const external = /\.html?$/i.test(novelPath);
  const fieldsPromise = external ? fetchDetailFields(novelPath) : null;
  // Never an unhandled rejection if the Sakura check wins and this is unused.
  fieldsPromise?.catch(() => undefined);

  // Ask the database, do not guess. A cold index answering "not ours" would
  // send one of our own novels to the external scraper and 404.
  // fetchSakuraNovelDetail returns null when the slug genuinely is not ours.
  const sakura = await fetchSakuraNovelDetail(novelPath);
  if (sakura) return sakura;

  return fieldsPromise ?? fetchDetailFields(novelPath);
}

/** Full detail, chapters included — the shape every caller had before the split. */
export async function parseNovelDetail(novelPath: string): Promise<AllNovelDetail> {
  const header = await fetchNovelDetailHeader(novelPath);
  if (header.chapters.length || !header.novelId) return header;
  try {
    return { ...header, chapters: await fetchNovelChapterList(header.novelId, novelPath) };
  } catch (e) {
    console.warn('Failed to fetch chapter list:', e);
    return header;
  }
}

// ─── Chapter lists ────────────────────────────────────────────────────────────

const CHAPTER_LIST_TTL = 15 * 60 * 1000;
/** Parsed lists by series path, so the reader and detail page share one copy. */
const chapterLists = new Map<string, { at: number; chapters: AllNovelChapter[] }>();

/** Compact cache form: the shared path prefix once, then [suffix, name] pairs. */
type PackedChapters = { p: string; c: Array<[string, string]> };

function packChapters(chapters: AllNovelChapter[]): PackedChapters {
  const first = chapters[0]?.path ?? '';
  const slash = first.lastIndexOf('/');
  let prefix = slash > 0 ? first.slice(0, slash + 1) : '';
  if (prefix && !chapters.every((ch) => ch.path.startsWith(prefix))) prefix = '';
  return { p: prefix, c: chapters.map((ch) => [ch.path.slice(prefix.length), ch.name]) };
}

function unpackChapters(packed: PackedChapters): AllNovelChapter[] {
  return (packed?.c ?? []).map(([suffix, name], i) => ({
    path: `${packed.p}${suffix}`,
    name,
    chapterNumber: i + 1,
    releaseTime: null,
  }));
}

export async function fetchNovelChapterList(novelId: string, seriesPath?: string): Promise<AllNovelChapter[]> {
  const packed = await getOrSetParsed<PackedChapters>(
    `novel:chapters:v2:${novelId}`,
    CHAPTER_LIST_TTL,
    `${SITE}ajax-chapter-option?novelId=${novelId}`,
    (html) => {
      const list = parseChapterList(html);
      // An empty list is almost always a challenge page, not a novel with no
      // chapters; throwing keeps it out of the cache (and serves the stale copy).
      if (!list.length) throw new Error('The chapter list is empty.');
      return packChapters(list);
    },
  );
  const chapters = unpackChapters(packed);
  if (seriesPath && chapters.length) chapterLists.set(seriesPath, { at: Date.now(), chapters });
  return chapters;
}

/** The cached list for a series, without waiting; null when not loaded this session. */
export function peekNovelChapterList(seriesPath: string): AllNovelChapter[] | null {
  const hit = chapterLists.get(seriesPath);
  if (!hit || Date.now() - hit.at > CHAPTER_LIST_TTL) return null;
  return hit.chapters;
}

/**
 * Chapters for a series, from wherever is cheapest.
 *
 * The reader usually knows novelfull's numeric id from the chapter page, so it
 * can skip the detail page entirely; Sakura originals and cold starts go
 * through the full detail.
 */
export async function fetchNovelChapterListFor(seriesPath: string, novelIdHint?: string): Promise<AllNovelChapter[]> {
  const cached = peekNovelChapterList(seriesPath);
  if (cached) return cached;
  if (novelIdHint && /\.html?$/i.test(seriesPath)) return fetchNovelChapterList(novelIdHint, seriesPath);
  const detail = await parseNovelDetail(seriesPath);
  if (detail.chapters.length) chapterLists.set(seriesPath, { at: Date.now(), chapters: detail.chapters });
  return detail.chapters;
}

/**
 * Warm a novel's detail page, e.g. on hover or press-in of its card, so the
 * detail screen usually renders its title from cache. Errors are ignored: the
 * screen makes the same requests and reports its own failures.
 *
 * The chapter list is only fetched with `chapters: true`, for a deliberate
 * press (pointerdown). It can be ~600 KB for a long novel, and the cheaper
 * signals fire on things that are not an intent to open: native press-in fires
 * at the start of every scroll drag that begins on a card, and hover/focus fire
 * while a pointer or the Tab key moves across the grid. The header is one
 * small, 30-minute-cached request per title, so those stay cheap.
 */
export function prefetchNovelDetail(novelPath: string, opts: { chapters?: boolean } = {}): void {
  if (!novelPath || peekNovelChapterList(novelPath)) return;
  void fetchNovelDetailHeader(novelPath)
    .then((header) => {
      if (header.chapters.length) {
        chapterLists.set(novelPath, { at: Date.now(), chapters: header.chapters });
        return;
      }
      if (opts.chapters && header.novelId) return fetchNovelChapterList(header.novelId, novelPath);
    })
    .catch(() => undefined);
}

function parseChapterList(html: string): AllNovelChapter[] {
  const chapters: AllNovelChapter[] = [];
  let current: Partial<AllNovelChapter> = {};
  const stack: S[] = [S.Idle];
  const peek = () => stack[stack.length - 1];
  const push = (s: S) => stack.push(s);
  const pop = () => (stack.length > 1 ? stack.pop() : peek());
  let num = 0;

  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'a' && attrs.href) {
        push(S.Chapter);
        num++;
        try { current.path = new URL(attrs.href, SITE).pathname.substring(1); }
        catch { current.path = attrs.href; }
        current.name = attrs.title || '';
        current.chapterNumber = num;
        current.releaseTime = null;
      } else if (name === 'option' && attrs.value) {
        push(S.Chapter);
        num++;
        try { current.path = new URL(attrs.value, SITE).pathname.substring(1); }
        catch { current.path = attrs.value; }
        current.name = '';
        current.chapterNumber = num;
        current.releaseTime = null;
      }
    },
    ontext(text) {
      const t = text.trim();
      if (peek() === S.Chapter && !current.name && t) current.name = t;
    },
    onclosetag(name) {
      if ((name === 'a' || name === 'option') && peek() === S.Chapter) {
        if (current.name && current.path) {
          current.name = (current.name || '').trim();
          chapters.push({ ...current } as AllNovelChapter);
        }
        current = {};
        pop();
      }
    },
  });
  parser.write(html);
  parser.end();
  return chapters;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchPopularNovels(
  page = 1,
  filter?: { type?: string; genre?: string }
): Promise<AllNovelItem[]> {
  let path: string;
  if (filter?.genre) {
    path = `${filter.genre}?page=${page}`;
  } else {
    const type = filter?.type || 'most-popular';
    path = `${type}?page=${page}`;
  }
  return fetchNovelList(SITE + path);
}

export async function fetchLatestNovels(page = 1): Promise<AllNovelItem[]> {
  return fetchNovelList(`${SITE}latest-release-novel?page=${page}`);
}

export async function searchNovels(query: string, page = 1): Promise<AllNovelItem[]> {
  const url = `${SITE}search?keyword=${encodeURIComponent(query)}&page=${page}`;
  return fetchNovelList(url);
}

export interface NovelChapterPage {
  path: string;
  text: string;
  /** The page's own chapter title, e.g. "Chapter 1 - Starting Over". */
  title?: string;
  /** Series (detail page) path and name, from the chapter page's breadcrumb. */
  novelPath?: string;
  novelTitle?: string;
  prevPath?: string;
  nextPath?: string;
  /** novelfull's numeric id: lets the reader fetch the chapter list directly. */
  novelId?: string;
}

/** Parse a novelfull chapter page. Exported for tests. */
export function parseChapterPageHtml(html: string, chapterPath: string): NovelChapterPage {
  const parts: string[] = [];
  const page: NovelChapterPage = { path: chapterPath, text: '' };
  let depth = 0;
  let hiddenDepth = 0;
  let titleParts: string[] | null = null;
  const paragraphTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);
  const stack: S[] = [S.Idle];
  const peek = () => stack[stack.length - 1];
  const push = (s: S) => stack.push(s);
  const pop = () => (stack.length > 1 ? stack.pop() : peek());
  const toPath = (href: string) => {
    try {
      return new URL(href, SITE).pathname.substring(1);
    } catch {
      return href.replace(/^\/+/, '');
    }
  };

  const parser = new Parser({
    onopentag(name, attrs) {
      const state = peek();
      const cls = attrs.class?.trim() || '';
      // Navigation and breadcrumb sit outside the chapter body, top and bottom.
      if (state !== S.Chapter && state !== S.Hidden) {
        if (name === 'a' && (attrs.id === 'prev_chap' || attrs.id === 'next_chap')) {
          // A disabled link (first/last chapter) has no href.
          const href = attrs.href;
          if (href && !cls.includes('disabled') && !('disabled' in attrs)) {
            const target = toPath(href);
            if (attrs.id === 'prev_chap') page.prevPath = page.prevPath || target;
            else page.nextPath = page.nextPath || target;
          }
        } else if (name === 'a' && cls.split(/\s+/).includes('truyen-title') && attrs.href) {
          page.novelPath = page.novelPath || toPath(attrs.href);
          if (attrs.title) page.novelTitle = page.novelTitle || attrs.title.trim();
        } else if (name === 'a' && cls.split(/\s+/).includes('chapter-title')) {
          if (attrs.title && !page.title) page.title = attrs.title.trim();
          else if (!page.title) titleParts = [];
        }
        if (attrs['data-novel-id'] && !page.novelId) page.novelId = attrs['data-novel-id'];
      }
      switch (state) {
        case S.Idle:
          if (cls === 'txt' || attrs.id === 'chr-content' || attrs.id === 'chapter-content') {
            push(S.Chapter);
            depth = 0;
          }
          break;
        case S.Chapter:
          // HTML text nodes omit the boundaries between adjacent paragraphs.
          // Preserve those boundaries while keeping inline emphasis contiguous.
          if (paragraphTags.has(name)) parts.push('\n\n');
          else if (name === 'br') parts.push('\n');
          if (name === 'sub' || name === 'script' || name === 'style') {
            push(S.Hidden);
          } else if (name === 'div') {
            depth++;
            if (cls.includes('unlock-buttons') || cls.includes('ads')) {
              push(S.Hidden);
              hiddenDepth = 0;
            }
          }
          break;
        case S.Hidden:
          if (name === 'sub' || name === 'script' || name === 'style') push(S.Hidden);
          else if (name === 'div') hiddenDepth++;
          break;
      }
    },
    ontext(text) {
      if (titleParts) titleParts.push(text);
      if (peek() === S.Chapter) parts.push(text);
    },
    onclosetag(name) {
      const state = peek();
      if (name === 'a' && titleParts) {
        const t = titleParts.join('').replace(/\s+/g, ' ').trim();
        if (t && !page.title) page.title = t;
        titleParts = null;
      }
      if (state === S.Chapter && paragraphTags.has(name)) parts.push('\n\n');
      if (state === S.Hidden) {
        if (name === 'sub' || name === 'script' || name === 'style') pop();
        else if (name === 'div') {
          hiddenDepth--;
          if (hiddenDepth < 0) { pop(); depth--; }
        }
      }
      if (name === 'div' && state === S.Chapter) {
        depth--;
        if (depth < 0) push(S.Stopped);
      }
    },
  });
  parser.write(html);
  parser.end();
  const raw = parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // The source's "If you find any errors … report chapter" notice is not prose.
  page.text = stripSourceBoilerplate(raw);
  return page;
}

const CHAPTER_TTL = 24 * 60 * 60 * 1000;
/** Recently parsed chapters, so a prefetched "next chapter" renders on the first frame. */
const recentPages = new Map<string, NovelChapterPage>();
const RECENT_PAGES = 8;

function remember(page: NovelChapterPage) {
  recentPages.delete(page.path);
  recentPages.set(page.path, page);
  while (recentPages.size > RECENT_PAGES) {
    const oldest = recentPages.keys().next().value;
    if (oldest === undefined) break;
    recentPages.delete(oldest);
  }
}

/** A chapter parsed earlier this session (opened or prefetched), or null. */
export function peekNovelChapterPage(chapterPath: string): NovelChapterPage | null {
  return recentPages.get(chapterPath) ?? null;
}

export async function fetchNovelChapterPage(
  chapterPath: string,
  opts: { persist?: boolean } = {},
): Promise<NovelChapterPage> {
  const recent = recentPages.get(chapterPath);
  if (recent) return recent;
  // null means "not one of ours", not "empty chapter". It answers without a
  // request for novelfull paths, which do not have the "<slug>/chapter/<id>" shape.
  const sakuraContent = await fetchSakuraChapterContent(chapterPath);
  if (sakuraContent) {
    const page: NovelChapterPage = { path: chapterPath, text: sakuraContent };
    if (opts.persist !== false) remember(page);
    return page;
  }
  const key = `novel:page:v1:${chapterPath}`;
  const parse = (html: string) => {
    const parsed = parseChapterPageHtml(html, chapterPath);
    // Same reasoning: never cache a bot-check page as an empty chapter for a day.
    if (!parsed.text) throw new Error('The chapter has no readable text.');
    return parsed;
  };
  if (opts.persist === false) {
    // Batch downloads store the text in the offline library already. Putting
    // 10–100 chapters (~20 KB each) into lib/cache as well overflows its
    // 1.5 M-character budget, and the budget evicts the entries that expire
    // soonest first — every section's catalogue — so one "Download next 100"
    // used to make home, manga and anime load cold again. A copy that is
    // already cached (the chapter was just read) is still used.
    const cached = await getCachedValue<NovelChapterPage>(key).catch(() => null);
    if (cached?.text) return cached;
    return dedupe(key, async () => parse(await fetchNovelHtml(resolveUrl(SITE + chapterPath))));
  }
  const page = await getOrSetParsed<NovelChapterPage>(key, CHAPTER_TTL, SITE + chapterPath, parse);
  if (page?.text) remember(page);
  return page;
}

/** Start loading a chapter in the background (the reader's "next chapter"). */
export function prefetchNovelChapterPage(chapterPath: string): void {
  if (!chapterPath || recentPages.has(chapterPath)) return;
  void fetchNovelChapterPage(chapterPath).catch(() => undefined);
}

export async function parseChapterContent(chapterPath: string, opts: { persist?: boolean } = {}): Promise<string> {
  return (await fetchNovelChapterPage(chapterPath, opts)).text;
}

// Optional cover enrichment is separate from the readable novel data.
export { getHDCover, enhanceCovers, mergeNovelCovers } from './novel-covers';
