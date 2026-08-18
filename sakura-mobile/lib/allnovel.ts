/**
 * AllNovel.org scraper — ported from the Sakura Capacitor app.
 * Scrapes novel listings, details, chapters, and content from allnovel.org.
 */
import { Parser } from 'htmlparser2';
import { getOrSetCached } from '@/lib/cache';
import {
  fetchSakuraChapterContent,
  fetchSakuraNovelDetail,
} from '@/lib/sakura-novels';
import { fetchNovelHtml } from '@/lib/allnovel-html';

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

async function fetchHtml(url: string, ttlMs = 10 * 60 * 1000): Promise<string> {
  return getOrSetCached<string>(
    `novel:html:${url}`,
    ttlMs,
    async () => fetchNovelHtml(resolveUrl(url)),
    { staleIfError: true },
  );
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

export async function parseNovelDetail(novelPath: string): Promise<AllNovelDetail> {
  // Ask the database, do not guess. The old synchronous check consulted a
  // hardcoded Set, so it could answer instantly; a DB-backed index cannot, and
  // a cold cache answering "not ours" would send one of our own novels to the
  // external scraper and 404. fetchSakuraNovelDetail returns null when the slug
  // genuinely is not ours, which is the only safe way to fall through.
  const sakura = await fetchSakuraNovelDetail(novelPath);
  if (sakura) return sakura;

  const html = await fetchHtml(SITE + novelPath, 30 * 60 * 1000);

  const result: AllNovelDetail = { path: novelPath, name: '', chapters: [] };
  const summaryParts: string[] = [];
  const infoParts: string[] = [];
  const genreParts: string[] = [];
  const authorParts: string[] = [];
  const statusParts: string[] = [];

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
        case 'img':
          if (state === S.Cover) {
            const src = attrs.src || attrs['data-cfsrc'] || attrs['data-src'];
            if (src) result.cover = resolveUrl(src);
            if (attrs.title) result.name = attrs.title;
          }
          break;
        case 'h3':
          if (state === S.Cover) push(S.NovelName);
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
      const t = text.trim();
      if (!t) return;
      switch (peek()) {
        case S.NovelName: result.name = (result.name || '') + t; break;
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
        case 'h3': if (state === S.NovelName) pop(); break;
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

  if (novelDataId) {
    try {
      const chapUrl = `${SITE}ajax-chapter-option?novelId=${novelDataId}`;
      const chapHtml = await fetchHtml(chapUrl, 15 * 60 * 1000);
      result.chapters = parseChapterList(chapHtml);
    } catch (e) {
      console.error('Failed to fetch chapter list:', e);
    }
  }

  return result;
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
  const html = await fetchHtml(SITE + path);
  return parseNovels(html);
}

export async function fetchLatestNovels(page = 1): Promise<AllNovelItem[]> {
  const html = await fetchHtml(`${SITE}latest-release-novel?page=${page}`);
  return parseNovels(html);
}

export async function searchNovels(query: string, page = 1): Promise<AllNovelItem[]> {
  const url = `${SITE}search?keyword=${encodeURIComponent(query)}&page=${page}`;
  const html = await fetchHtml(url);
  return parseNovels(html);
}

export async function parseChapterContent(chapterPath: string): Promise<string> {
  // Same here: null means "not one of ours", not "empty chapter". The index is
  // already warm by this point because opening a chapter follows opening the
  // novel, so this costs no extra round trip in practice.
  const sakuraContent = await fetchSakuraChapterContent(chapterPath);
  if (sakuraContent) return sakuraContent;

  const html = await fetchHtml(SITE + chapterPath, 24 * 60 * 60 * 1000);
  const parts: string[] = [];
  let depth = 0;
  let hiddenDepth = 0;
  const stack: S[] = [S.Idle];
  const peek = () => stack[stack.length - 1];
  const push = (s: S) => stack.push(s);
  const pop = () => (stack.length > 1 ? stack.pop() : peek());

  const parser = new Parser({
    onopentag(name, attrs) {
      const state = peek();
      const cls = attrs.class?.trim() || '';
      switch (state) {
        case S.Idle:
          if (cls === 'txt' || attrs.id === 'chr-content' || attrs.id === 'chapter-content') {
            push(S.Chapter);
            depth = 0;
          }
          break;
        case S.Chapter:
          if (name === 'sub') {
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
          if (name === 'sub') push(S.Hidden);
          else if (name === 'div') hiddenDepth++;
          break;
      }
    },
    ontext(text) {
      if (peek() === S.Chapter) parts.push(text);
    },
    onclosetag(name) {
      const state = peek();
      if (state === S.Hidden) {
        if (name === 'sub') pop();
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
  return parts.join('').trim();
}

// ─── HD cover via Google Books ────────────────────────────────────────────────

const coverCache = new Map<string, string | null>();

export async function getHDCover(title: string): Promise<string | null> {
  const key = title.toLowerCase().trim();
  if (coverCache.has(key)) return coverCache.get(key) ?? null;
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&maxResults=1`;
    const res = await fetch(url);
    const data = await res.json();
    const links = data.items?.[0]?.volumeInfo?.imageLinks;
    if (links) {
      const raw = (links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail || '') as string;
      const hdUrl = raw
        .replace('http://', 'https://')
        .replace('&edge=curl', '')
        .replace(/zoom=\d+/, 'zoom=5');
      coverCache.set(key, hdUrl || null);
      return hdUrl || null;
    }
  } catch { /* ignore */ }
  coverCache.set(key, null);
  return null;
}

export async function enhanceCovers(items: AllNovelItem[]): Promise<AllNovelItem[]> {
  const results = await Promise.allSettled(
    items.map(async (item) => {
      const hd = await getHDCover(item.name);
      const original = item.originalCover || item.cover;
      return hd ? { ...item, cover: hd, originalCover: original } : { ...item, originalCover: original };
    }),
  );
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : items[i]));
}
