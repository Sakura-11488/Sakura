import { readStore, writeStore } from '@/lib/kv-store';

export type ReadingKind = 'manga' | 'novel';

export interface ContinueReadingItem {
  kind: ReadingKind;
  id: string;
  title: string;
  cover?: string;
  subtitle: string;
  progress: number;
  updatedAt: number;
  mangaId?: string;
  chapterId?: string;
  page?: number;
  /** Backing source for manga-type items: 'comics' | 'hentai' route to the
   *  scraped reader, undefined/'manga' to the manga backend. */
  source?: string;
  novelPath?: string;
  novelOffsetY?: number;
  /**
   * Manga rows: 'up-next' opens a chapter not started yet (the one after a
   * finished chapter), 'caught-up'/'finished' reopen a finished chapter on its
   * last page. Absent while mid-chapter.
   */
  mangaState?: 'up-next' | 'caught-up' | 'finished';
}

export type NovelProgress = {
  path: string;
  offsetY: number;
  progress: number;
  updatedAt: number;
  title?: string;
  cover?: string;
  chapterLabel?: string;
  /** AllNovel / series path when known (detail screen id). */
  novelSeriesPath?: string;
};

export type MangaProgress = {
  mangaId: string;
  chapterId: string;
  title: string;
  cover?: string;
  chapterLabel: string;
  page: number;
  totalPages: number;
  progress: number;
  updatedAt: number;
  /** 'comics' | 'hentai' for droplet-scraped sources; absent for atsu manga. */
  source?: string;
  /**
   * Chapter number when the reader knew it. The id alone is not stable for
   * atsu: the newest chapters can be filled in from another scanlation group
   * (see pickScanlationChapters), and once the main group uploads that number
   * its own row — with a different id — replaces the filled one. The title
   * page falls back to this number so Continue still finds the chapter.
   */
  chapterNumber?: number;
  /**
   * The previous chapter was read to its last page and this row now points at
   * the one after it (chapterId/chapterLabel/chapterNumber), not started yet.
   * page is 1 and progress is MIN_ACTIVE_PROGRESS.
   */
  upNext?: boolean;
  /** For upNext rows: the chapter that was finished. */
  finishedChapterId?: string;
  finishedChapterLabel?: string;
  /**
   * chapterId was read to its last page and was the newest chapter the reader
   * knew of. A new chapter appearing later is found from here (the reader's
   * end card, or the title page's chapter list).
   */
  caughtUp?: boolean;
  /**
   * chapterId was read to its last page, but whether another chapter follows
   * was not known when it was saved (the chapter list had not loaded).
   */
  finished?: boolean;
};

type ProgressStore = {
  novels: Record<string, NovelProgress>;
  manga: Record<string, MangaProgress>;
};

const FILE = 'sakura_reader_progress.json';
const mem: ProgressStore = { novels: {}, manga: {} };
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeReadingProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const raw = await readStore(FILE);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProgressStore>;
      mem.novels = parsed?.novels || {};
      mem.manga = parsed?.manga || {};
      for (const [key, row] of Object.entries(mem.novels)) {
        if (row && !row.path) {
          try {
            row.path = decodeURIComponent(key);
          } catch {
            row.path = key;
          }
        }
      }
    }
  } catch {
    mem.novels = {};
    mem.manga = {};
  } finally {
    loaded = true;
  }
}

async function persist() {
  try {
    await writeStore(FILE, JSON.stringify(mem));
    notify();
  } catch {
    // no-op
  }
}

function keyForPath(path: string) {
  return encodeURIComponent(path.trim());
}

function novelTitleFromPath(path: string) {
  const slug = path.split('/').filter(Boolean).pop() || path;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isActiveReadingProgress(progress: number): boolean {
  return progress >= 0.01 && progress < 0.98;
}

/**
 * Bounds for a saved manga position, chosen against isActiveReadingProgress,
 * which the title page (native and web) and novel screens use to decide
 * between "Continue" and "Start reading".
 *
 * MIN: page 1 of a 138-page chapter is 0.007, under that 1% floor, so the
 * title page offered "Start reading" from chapter 0 to someone mid-series.
 * MAX: page 49 of 50 is 0.98, which read as finished and dropped the series
 * out of Continue Reading one page early. A position that is not finished is
 * therefore kept inside [MIN, MAX]; a finished one is saved as an Up next,
 * caught-up or finished row (buildMangaProgressRecord), never as 1.0.
 */
export const MIN_ACTIVE_PROGRESS = 0.01;
export const MAX_ACTIVE_PROGRESS = 0.97;

/** The chapter after a finished one, as the reader knows it. */
export type UpNextChapter = {
  chapterId: string;
  chapterLabel?: string;
  chapterNumber?: number;
  /** Page count when known (the reader usually has the next list prefetched). */
  totalPages?: number;
};

export type MangaProgressEntry = {
  mangaId: string;
  chapterId: string;
  title: string;
  cover?: string;
  chapterLabel?: string;
  page: number;
  totalPages: number;
  source?: string;
  chapterNumber?: number;
  /**
   * The chapter was read to its end. Defaults to page >= totalPages; the
   * reader also sets it when the end of a chapter is on screen, which page
   * numbers alone cannot always show (a short last page is never the top row).
   */
  finished?: boolean;
  /**
   * What follows chapterId: the next chapter, null when chapterId is the
   * newest one (caught up), undefined when not known yet.
   */
  next?: UpNextChapter | null;
};

/**
 * The row to store for a reader position. Pure, for tests and so the rules
 * live in one place:
 *
 *  - Reading: the chapter and page, progress kept inside the active bounds.
 *  - Finished, next known: the NEXT chapter at page 1, flagged upNext. This is
 *    what keeps the series in Continue Reading and makes the title page say
 *    "Continue · Chapter 13" instead of "Start reading" from chapter 0, with
 *    no change needed in the screens that read it.
 *  - Finished, newest chapter: caughtUp on the finished chapter's last page.
 *  - Finished, next unknown: finished on its last page; reopening it lands
 *    on the reader's end card, which resolves the next chapter by then.
 */
export function buildMangaProgressRecord(
  entry: MangaProgressEntry,
  prev: MangaProgress | undefined,
  now: number,
): MangaProgress {
  const total = Math.max(1, Math.floor(entry.totalPages || 1));
  const page = Math.min(total, Math.max(1, Math.floor(entry.page || 1)));
  const finished = entry.finished ?? page >= total;
  const label = entry.chapterLabel || `Chapter ${entry.chapterId}`;
  const base = {
    mangaId: entry.mangaId,
    title: entry.title || prev?.title || 'Manga',
    cover: entry.cover ?? prev?.cover,
    updatedAt: now,
    source: entry.source ?? prev?.source,
  };
  const number = (n: number | undefined) => (n && n > 0 ? { chapterNumber: n } : {});

  if (finished && entry.next && entry.next.chapterId) {
    const next = entry.next;
    const nextTotal = Math.max(1, Math.floor(next.totalPages || 0) || 1);
    return {
      ...base,
      chapterId: next.chapterId,
      chapterLabel:
        next.chapterLabel || (next.chapterNumber != null ? `Chapter ${next.chapterNumber}` : `Chapter ${next.chapterId}`),
      page: 1,
      totalPages: nextTotal,
      progress: MIN_ACTIVE_PROGRESS,
      ...number(next.chapterNumber),
      upNext: true,
      finishedChapterId: entry.chapterId,
      finishedChapterLabel: label,
    };
  }
  if (finished) {
    return {
      ...base,
      chapterId: entry.chapterId,
      chapterLabel: label,
      page: total,
      totalPages: total,
      // Inside the active bounds on purpose: the title page and Continue
      // Reading only understand a number, and 1.0 sent them back to
      // "Start reading" from chapter 0.
      progress: MAX_ACTIVE_PROGRESS,
      ...number(entry.chapterNumber),
      ...(entry.next === null ? { caughtUp: true } : { finished: true }),
    };
  }
  return {
    ...base,
    chapterId: entry.chapterId,
    chapterLabel: label,
    page,
    totalPages: total,
    progress: Math.min(MAX_ACTIVE_PROGRESS, Math.max(MIN_ACTIVE_PROGRESS, page / total)),
    ...number(entry.chapterNumber),
  };
}

export function novelSeriesPathFromChapterPath(chapterPath: string): string {
  const p = chapterPath.trim();
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : p;
}

export async function findNovelProgressForSeries(seriesPath: string): Promise<NovelProgress | null> {
  if (!seriesPath) return null;
  await ensureLoaded();
  const base = seriesPath.trim().replace(/\/$/, '');
  let best: NovelProgress | null = null;

  for (const row of Object.values(mem.novels)) {
    if (!row?.path || !isActiveReadingProgress(row.progress)) continue;
    const rowSeries = (row.novelSeriesPath || novelSeriesPathFromChapterPath(row.path)).replace(/\/$/, '');
    const matches =
      row.path === base ||
      rowSeries === base ||
      row.path.startsWith(`${base}/`) ||
      base.startsWith(rowSeries);
    if (!matches) continue;
    if (!best || row.updatedAt > best.updatedAt) best = row;
  }
  return best;
}

/** Latest in-progress novel entry per series path (for novel grid). */
export async function getNovelProgressBySeries(): Promise<Record<string, NovelProgress>> {
  await ensureLoaded();
  const index: Record<string, NovelProgress> = {};
  for (const row of Object.values(mem.novels)) {
    if (!row?.path || !isActiveReadingProgress(row.progress)) continue;
    const series = (row.novelSeriesPath || novelSeriesPathFromChapterPath(row.path)).replace(/\/$/, '');
    const prev = index[series];
    if (!prev || row.updatedAt > prev.updatedAt) index[series] = row;
  }
  return index;
}

export async function getNovelReadProgress(path: string): Promise<NovelProgress | null> {
  if (!path) return null;
  await ensureLoaded();
  return mem.novels[keyForPath(path)] || null;
}

export async function setNovelReadProgress(
  path: string,
  payload: {
    offsetY: number;
    progress: number;
    title?: string;
    cover?: string;
    chapterLabel?: string;
    novelSeriesPath?: string;
  },
): Promise<void> {
  if (!path) return;
  await ensureLoaded();
  const prev = mem.novels[keyForPath(path)];
  mem.novels[keyForPath(path)] = {
    path: path.trim(),
    offsetY: Math.max(0, payload.offsetY || 0),
    progress: Math.min(1, Math.max(0, payload.progress || 0)),
    updatedAt: Date.now(),
    title: payload.title ?? prev?.title,
    cover: payload.cover ?? prev?.cover,
    chapterLabel: payload.chapterLabel ?? prev?.chapterLabel,
    novelSeriesPath:
      payload.novelSeriesPath?.trim() ||
      prev?.novelSeriesPath ||
      novelSeriesPathFromChapterPath(path),
  };
  await persist();
}

export async function getMangaReadProgress(mangaId: string): Promise<MangaProgress | null> {
  if (!mangaId) return null;
  await ensureLoaded();
  return mem.manga[mangaId] || null;
}

export async function setMangaReadProgress(entry: MangaProgressEntry): Promise<void> {
  if (!entry.mangaId || !entry.chapterId) return;
  await ensureLoaded();
  mem.manga[entry.mangaId] = buildMangaProgressRecord(entry, mem.manga[entry.mangaId], Date.now());
  await persist();
}

/** Continue Reading line for a manga row; its first ' · ' part is the chapter label (ContinueReadingRow relies on it). */
export function mangaContinueSubtitle(row: MangaProgress): string {
  if (row.upNext) return `${row.chapterLabel} · Up next`;
  if (row.caughtUp) return `${row.chapterLabel} · Caught up`;
  if (row.finished) return `${row.chapterLabel} · Finished`;
  return `${row.chapterLabel} · p.${row.page}/${row.totalPages}`;
}

export async function getContinueReading(limit = 12): Promise<ContinueReadingItem[]> {
  await ensureLoaded();
  const items: ContinueReadingItem[] = [];

  for (const row of Object.values(mem.manga)) {
    // Floor is "any progress at all", not 1%. Crossing into a new chapter saves
    // its page 1 immediately, and in a 200-page chapter that is 0.005 — a 1%
    // floor made the series vanish from Continue Reading at exactly the moment
    // the reader started it.
    //
    // Up next, caught-up and finished rows are kept on purpose (see
    // buildMangaProgressRecord). Rows saved as 1.0 by older builds still drop
    // out, as they always did.
    if (!row || row.progress <= 0 || row.progress >= 0.98) continue;
    items.push({
      kind: 'manga',
      id: `manga-${row.mangaId}`,
      title: row.title,
      cover: row.cover,
      subtitle: mangaContinueSubtitle(row),
      // The bar shows the chapter it opens: empty for one not started, full
      // for one read to the end.
      progress: row.upNext ? 0 : row.caughtUp || row.finished ? 1 : row.progress,
      updatedAt: row.updatedAt,
      mangaId: row.mangaId,
      chapterId: row.chapterId,
      page: row.page,
      source: row.source,
      ...(row.upNext
        ? { mangaState: 'up-next' as const }
        : row.caughtUp
          ? { mangaState: 'caught-up' as const }
          : row.finished
            ? { mangaState: 'finished' as const }
            : {}),
    });
  }

  for (const row of Object.values(mem.novels)) {
    if (!row?.path || row.progress < 0.01 || row.progress >= 0.98) continue;
    items.push({
      kind: 'novel',
      id: `novel-${keyForPath(row.path)}`,
      title: row.title || novelTitleFromPath(row.path),
      cover: row.cover,
      subtitle: row.chapterLabel || 'Continue chapter',
      progress: row.progress,
      updatedAt: row.updatedAt,
      novelPath: row.path,
      novelOffsetY: row.offsetY,
    });
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function clearAllReadingProgress(): Promise<void> {
  await ensureLoaded();
  mem.novels = {};
  mem.manga = {};
  await persist();
}

/** Snapshot the full reading-progress store (cloud-sync). */
export async function exportReadingProgress(): Promise<ProgressStore> {
  await ensureLoaded();
  return { novels: { ...mem.novels }, manga: { ...mem.manga } };
}

/** Merge a cloud snapshot into local progress, newest-updatedAt wins. */
export async function importReadingProgress(incoming: Partial<ProgressStore>): Promise<void> {
  await ensureLoaded();
  for (const [key, row] of Object.entries(incoming.novels || {})) {
    const local = mem.novels[key];
    if (!local || (row.updatedAt || 0) > (local.updatedAt || 0)) mem.novels[key] = row;
  }
  for (const [key, row] of Object.entries(incoming.manga || {})) {
    const local = mem.manga[key];
    if (!local || (row.updatedAt || 0) > (local.updatedAt || 0)) mem.manga[key] = row;
  }
  await persist();
}

export async function getAllMangaProgressEntries(): Promise<MangaProgress[]> {
  await ensureLoaded();
  return Object.values(mem.manga).filter(Boolean);
}

export async function getAllNovelProgressEntries(): Promise<NovelProgress[]> {
  await ensureLoaded();
  return Object.values(mem.novels).filter((row) => Boolean(row?.path));
}
