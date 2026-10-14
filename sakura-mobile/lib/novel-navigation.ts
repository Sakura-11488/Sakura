/**
 * Chapter-list arithmetic shared by the novel reader and the detail screens.
 *
 * Pure functions (unit-tested in test/novel-reader.test.mjs). Chapters are
 * always identified by PATH: novelfull numbers chapters by position in its
 * list, so "chapter 12" can name a different chapter after the source inserts
 * a prologue, while the path never changes.
 */

export interface NavChapter {
  path: string;
  name: string;
  chapterNumber: number;
}

export interface ChapterNeighbours<T extends NavChapter = NavChapter> {
  /** 0-based position in reading order, -1 when the path is not in the list. */
  index: number;
  total: number;
  prev: T | null;
  next: T | null;
  current: T | null;
}

/** Reading order: ascending chapter number, then original order for ties. */
export function sortChaptersForReading<T extends NavChapter>(chapters: readonly T[]): T[] {
  return chapters
    .map((ch, i) => ({ ch, i }))
    .sort((a, b) => (a.ch.chapterNumber - b.ch.chapterNumber) || (a.i - b.i))
    .map((x) => x.ch);
}

export function findChapterNeighbours<T extends NavChapter>(ordered: readonly T[], path: string): ChapterNeighbours<T> {
  const total = ordered.length;
  const index = path ? ordered.findIndex((ch) => ch.path === path) : -1;
  if (index < 0) return { index: -1, total, prev: null, next: null, current: null };
  return {
    index,
    total,
    current: ordered[index],
    prev: index > 0 ? ordered[index - 1] : null,
    next: index < total - 1 ? ordered[index + 1] : null,
  };
}

/**
 * The series (detail page) path for a chapter path, when nothing better is known.
 *
 * novelfull: "some-novel/chapter-1.html" → "some-novel.html".
 * Sakura originals: "some-slug/chapter/<id>" → "some-slug".
 * Continue Reading rows only carry the chapter path, so the reader needs this
 * to find the chapter list.
 */
export function seriesPathFromChapterPath(chapterPath: string): string {
  const p = String(chapterPath ?? '').trim().replace(/^\/+/, '');
  const sakura = p.match(/^([^/]+)\/chapter\/[^/]+$/);
  if (sakura) return sakura[1];
  const idx = p.indexOf('/');
  if (idx <= 0) return p;
  const slug = p.slice(0, idx);
  return /\.html?$/i.test(p) ? `${slug}.html` : slug;
}

export interface ChapterReadState {
  /** Chapter paths read to the end (>= 98%). */
  finished: Set<string>;
  /** Partly read chapters → 0–1 progress. */
  partial: Map<string, number>;
}

/** Read marks for one series from the flat per-chapter progress rows. */
export function buildChapterReadState(
  rows: ReadonlyArray<{ path: string; progress: number; novelSeriesPath?: string }>,
  belongsToSeries: (row: { path: string; novelSeriesPath?: string }) => boolean,
): ChapterReadState {
  const finished = new Set<string>();
  const partial = new Map<string, number>();
  for (const row of rows) {
    if (!row?.path || !belongsToSeries(row)) continue;
    if (row.progress >= 0.98) finished.add(row.path);
    else if (row.progress >= 0.01) partial.set(row.path, row.progress);
  }
  return { finished, partial };
}

/**
 * Where "Download next N" should start.
 *
 * The button used to download chapters 1–30 whatever the reader's position, so
 * someone on chapter 500 got thirty chapters they had already read. It now
 * starts at the chapter being read; failing that, just after the furthest
 * finished chapter; failing that, at the beginning.
 */
export function downloadStartIndex(
  ordered: readonly NavChapter[],
  opts: { resumePath?: string | null; finished?: ReadonlySet<string> },
): number {
  if (!ordered.length) return 0;
  if (opts.resumePath) {
    const i = ordered.findIndex((ch) => ch.path === opts.resumePath);
    if (i >= 0) return i;
  }
  if (opts.finished && opts.finished.size) {
    let furthest = -1;
    ordered.forEach((ch, i) => {
      if (opts.finished!.has(ch.path)) furthest = i;
    });
    if (furthest >= 0) return Math.min(ordered.length - 1, furthest + 1);
  }
  return 0;
}

/** The next `count` chapters from `start` that are not already on the device. */
export function planNextDownloads<T extends NavChapter>(
  ordered: readonly T[],
  start: number,
  count: number,
  isDownloaded: (path: string) => boolean,
): T[] {
  const out: T[] = [];
  for (let i = Math.max(0, start); i < ordered.length && out.length < count; i++) {
    if (!isDownloaded(ordered[i].path)) out.push(ordered[i]);
  }
  return out;
}

/** Filter a chapter list by number or title, as the detail page's search does. */
export function filterChapters<T extends NavChapter>(chapters: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return chapters.slice();
  return chapters.filter((ch) => String(ch.chapterNumber).includes(q) || ch.name.toLowerCase().includes(q));
}
