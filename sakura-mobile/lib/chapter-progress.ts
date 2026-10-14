/**
 * Pure chapter-list logic shared by the series page (app/manga/[id].tsx, both
 * layouts) and the library's unread counts (lib/library-updates.ts): which
 * chapters count as read, where Start / Continue should open, and how a
 * chapter list reads at a glance.
 *
 * No imports with side effects, so the node tests load it directly.
 *
 * Two stores feed it, and neither is enough alone:
 *  - lib/reader-progress keeps ONE row per series: the chapter and page you
 *    were last on. It cannot say which chapters you have finished.
 *  - lib/chapter-read-state keeps the finished chapter ids, but only from the
 *    moment it existed; years of reading before that left no marks.
 * So "read" is the marks plus the progress chapter once it is finished, and
 * seedReadIdsFromProgress backfills marks for history that predates them.
 */

/** The fields of a chapter this module uses (lib/manga's MangaChapter has them all). */
export interface ChapterLike {
  id: string;
  number: number;
  title?: string;
  pageCount?: number;
  createdAt?: string | number;
}

/** The fields of a reader-progress row this module uses (MangaProgress). */
export interface ProgressLike {
  chapterId: string;
  chapterNumber?: number;
  page: number;
  totalPages: number;
  progress: number;
  /**
   * The reader's newer rows (lib/reader-progress buildMangaProgressRecord):
   * upNext points at the chapter AFTER a finished one (finishedChapterId),
   * not started yet; caughtUp / finished sit on a chapter read to its end
   * with progress held below FINISHED_PROGRESS so older screens keep it.
   */
  upNext?: boolean;
  finishedChapterId?: string;
  caughtUp?: boolean;
  finished?: boolean;
}

/**
 * At or past this a chapter is finished. Matches reader-progress, which drops
 * a row from Continue Reading at the same point (isActiveReadingProgress), so
 * the series page and the Continue row agree on what "finished" means.
 */
export const FINISHED_PROGRESS = 0.98;

/** A chapter released within this window gets a NEW pill. */
export const NEW_CHAPTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Ascending by number; equal numbers keep the source's order (Array.sort is stable). */
export function sortChaptersAsc<T extends ChapterLike>(chapters: readonly T[]): T[] {
  return [...chapters].sort((a, b) => a.number - b.number);
}

/**
 * The chapter a progress row points at. By id first, then by number: atsu can
 * replace a chapter filled in from another scanlation group with the main
 * group's own upload, under a different id (see MangaProgress.chapterNumber).
 */
export function findProgressChapter<T extends ChapterLike>(
  chapters: readonly T[],
  progress: ProgressLike | null | undefined,
): T | null {
  if (!progress?.chapterId) return null;
  const byId = chapters.find((c) => c.id === progress.chapterId);
  if (byId) return byId;
  const num = progress.chapterNumber;
  if (typeof num === 'number' && num > 0) return chapters.find((c) => c.number === num) ?? null;
  return null;
}

/**
 * The progress chapter has been read to the end: saved as 1.0 by older
 * builds, or flagged by the reader's caught-up / finished rows (which keep
 * progress under 0.98 so they stay in Continue Reading).
 */
export function isProgressFinished(progress: ProgressLike | null | undefined): boolean {
  return !!progress && (progress.progress >= FINISHED_PROGRESS || !!progress.caughtUp || !!progress.finished);
}

/**
 * Marked chapters plus the progress chapter once it is finished. The reader
 * finishing a chapter and the mark being written are not one step (and older
 * builds never wrote marks at all), so a finished progress row counts too.
 */
export function effectiveReadIds<T extends ChapterLike>(
  chapters: readonly T[],
  readIds: ReadonlySet<string>,
  progress: ProgressLike | null | undefined,
): Set<string> {
  const out = new Set(readIds);
  if (isProgressFinished(progress)) {
    const chapter = findProgressChapter(chapters, progress);
    if (chapter) out.add(chapter.id);
  }
  // An Up next row names the chapter it moved on from.
  if (progress?.upNext && progress.finishedChapterId && chapters.some((c) => c.id === progress.finishedChapterId)) {
    out.add(progress.finishedChapterId);
  }
  return out;
}

export type ResumeKind = 'start' | 'continue' | 'next' | 'caught-up';

export interface ResumeTarget<T extends ChapterLike = ChapterLike> {
  /**
   * start: nothing read yet, open the first chapter.
   * continue: a chapter is part-read; open it at `page`.
   * next: the next unread chapter after the last one read.
   * caught-up: everything after the last read chapter is read; `chapter` is
   * the newest, for a re-read.
   */
  kind: ResumeKind;
  chapter: T | null;
  /** 1-based page to open `chapter` on. */
  page: number;
}

/**
 * Where Start / Continue should open.
 *
 * The bug this fixes: finishing a chapter used to turn the button back into
 * "Start reading" at chapter 0, because the progress row of a finished chapter
 * is no longer "active". Now a finished chapter moves you on to the next
 * unread one.
 *
 * Rules, in order:
 *  1. A part-read chapter (progress row, not finished, not marked read) that
 *     is not behind the last read chapter: continue it at its page. That is
 *     where you stopped, and where the Continue Reading row also points.
 *  2. Otherwise, the first unread chapter after the last read one ("next").
 *     A part-read chapter BEHIND marks you made later (you marked ahead with
 *     "Mark previous as read") does not drag you back.
 *  3. Nothing after the last read chapter is unread: caught up.
 *  4. Nothing read and nothing part-read: start at the first chapter.
 */
export function resolveResume<T extends ChapterLike>(
  chaptersAsc: readonly T[],
  readIds: ReadonlySet<string>,
  progress: ProgressLike | null | undefined,
): ResumeTarget<T> {
  if (!chaptersAsc.length) return { kind: 'start', chapter: null, page: 1 };
  const read = effectiveReadIds(chaptersAsc, readIds, progress);
  let lastRead = -1;
  chaptersAsc.forEach((c, i) => { if (read.has(c.id)) lastRead = i; });

  const current = progress && progress.progress > 0 && !isProgressFinished(progress)
    ? findProgressChapter(chaptersAsc, progress)
    : null;
  if (current && !read.has(current.id)) {
    const at = chaptersAsc.indexOf(current);
    if (at >= lastRead) {
      // An Up next row is a chapter not opened yet: "next", from page 1.
      return progress!.upNext
        ? { kind: 'next', chapter: current, page: 1 }
        : { kind: 'continue', chapter: current, page: Math.max(1, Math.floor(progress!.page) || 1) };
    }
  }

  if (lastRead < 0) return { kind: 'start', chapter: chaptersAsc[0], page: 1 };
  for (let i = lastRead + 1; i < chaptersAsc.length; i++) {
    if (!read.has(chaptersAsc[i].id)) return { kind: 'next', chapter: chaptersAsc[i], page: 1 };
  }
  return { kind: 'caught-up', chapter: chaptersAsc[chaptersAsc.length - 1], page: 1 };
}

/**
 * Ids to mark read when history predates the marks: every chapter before the
 * progress chapter, and that chapter too if it is finished. Someone on
 * chapter 120 has, for every purpose a list or an unread count cares about,
 * read 1–119; leaving those unread showed "119 unread" on a series they are
 * caught up on. Empty when there is no progress or its chapter is not in the
 * list.
 */
export function seedReadIdsFromProgress<T extends ChapterLike>(
  chaptersAsc: readonly T[],
  progress: ProgressLike | null | undefined,
): string[] {
  const chapter = findProgressChapter(chaptersAsc, progress);
  if (!chapter) return [];
  const at = chaptersAsc.indexOf(chapter);
  const ids = chaptersAsc.slice(0, at).map((c) => c.id);
  if (isProgressFinished(progress)) ids.push(chapter.id);
  return ids;
}

/**
 * "Mark previous as read": every chapter before this one in reading order,
 * not including it (Mihon's meaning).
 */
export function previousChapterIds<T extends ChapterLike>(chaptersAsc: readonly T[], chapterId: string): string[] {
  const at = chaptersAsc.findIndex((c) => c.id === chapterId);
  return at <= 0 ? [] : chaptersAsc.slice(0, at).map((c) => c.id);
}

/** Chapters in the list not marked read. */
export function countUnread<T extends ChapterLike>(chapters: readonly T[], readIds: ReadonlySet<string>): number {
  let n = 0;
  for (const c of chapters) if (!readIds.has(c.id)) n++;
  return n;
}

/**
 * How far into this chapter the reader is, 0–100, when it is the part-read
 * progress chapter; null otherwise (unread, finished, or another chapter).
 */
export function chapterReadPercent(chapter: ChapterLike, progress: ProgressLike | null | undefined): number | null {
  if (!progress || isProgressFinished(progress) || progress.upNext || progress.progress <= 0) return null;
  const matches = chapter.id === progress.chapterId ||
    (typeof progress.chapterNumber === 'number' && progress.chapterNumber > 0 && chapter.number === progress.chapterNumber);
  if (!matches) return null;
  const pct = Math.round(Math.max(0, Math.min(1, progress.progress)) * 100);
  return Math.max(1, pct);
}

/** Milliseconds since the epoch for a chapter date (atsu sends ms, scrapers ISO strings), or 0. */
export function chapterTime(value: string | number | null | undefined): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const asNumber = /^\d{10,}$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : 0;
}

/** Released within NEW_CHAPTER_WINDOW_MS (and not dated in the future by a skewed clock). */
export function isNewChapter(chapter: ChapterLike, now = Date.now()): boolean {
  const at = chapterTime(chapter.createdAt);
  return at > 0 && at <= now + 60 * 60 * 1000 && now - at < NEW_CHAPTER_WINDOW_MS;
}

/** The newest chapter by number, with its date when the source gives one. */
export function latestChapter<T extends ChapterLike>(chaptersAsc: readonly T[]): T | null {
  return chaptersAsc.length ? chaptersAsc[chaptersAsc.length - 1] : null;
}

/** atsu spells Korean webtoons 'Manwha'; every screen should say 'Manhwa'. */
export function displayMangaType(type: string | null | undefined): string {
  const t = String(type ?? '').trim();
  if (/^manwha$/i.test(t)) return 'Manhwa';
  if (/^oel$/i.test(t)) return 'OEL';
  return t;
}
