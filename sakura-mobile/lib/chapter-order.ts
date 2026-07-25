import type { MangaChapter } from '@/lib/manga';

/**
 * Chapter ordering helpers.
 *
 * Ported from the legacy web reader's src/lib/chapter-order.ts, adapted to the
 * mobile `MangaChapter` shape: no volume field, `number` is already numeric,
 * `createdAt` stands in for `publishAt`, `pageCount` for `pages`.
 *
 * Reader navigation must run on reading order, not raw API order, because the
 * sources disagree: `fetchMangaChapters` returns ascending, `fetchComicChapters`
 * returns whatever the upstream listed (newest first), and the manhwa proxy
 * returns ascending with synthesised gaps. Some sources also return duplicate
 * numbers from different uploads. Normalising here is what lets "next chapter"
 * mean the same thing everywhere.
 */

function chapterNumber(chapter: MangaChapter): number | null {
  const n = chapter.number;
  return Number.isFinite(n) ? n : null;
}

function publishTime(chapter: MangaChapter): number {
  const t = Date.parse(chapter.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

function chapterKey(chapter: MangaChapter): string {
  const number = chapterNumber(chapter);
  // Unnumbered specials collapse onto their own id so they are never merged
  // with each other.
  return number == null ? `id:${chapter.id}` : `num:${number}`;
}

export function compareChaptersByReadingOrder(a: MangaChapter, b: MangaChapter): number {
  const an = chapterNumber(a);
  const bn = chapterNumber(b);
  if (an != null || bn != null) {
    if (an == null) return -1;
    if (bn == null) return 1;
    if (an !== bn) return an - bn;
  }
  // Stable fallback for special/unnumbered chapters.
  return publishTime(a) - publishTime(b);
}

function pickBetterDuplicate(
  existing: MangaChapter,
  candidate: MangaChapter,
  currentChapterId?: string | null,
): MangaChapter {
  // If the reader is currently on one of the duplicate uploads, keep that one so
  // its index is findable and navigation never routes through the other copy.
  if (currentChapterId) {
    if (candidate.id === currentChapterId) return candidate;
    if (existing.id === currentChapterId) return existing;
  }
  // Prefer the upload that actually has pages, then more pages, then newest.
  const existingPages = existing.pageCount || 0;
  const candidatePages = candidate.pageCount || 0;
  if (candidatePages !== existingPages) {
    return candidatePages > existingPages ? candidate : existing;
  }
  return publishTime(candidate) > publishTime(existing) ? candidate : existing;
}

/** Dedupe by chapter number and sort into reading order. */
export function normalizeChaptersForReading(
  chapters: MangaChapter[],
  currentChapterId?: string | null,
): MangaChapter[] {
  const byKey = new Map<string, MangaChapter>();
  for (const chapter of chapters) {
    if (!chapter?.id) continue;
    const key = chapterKey(chapter);
    const existing = byKey.get(key);
    byKey.set(key, existing ? pickBetterDuplicate(existing, chapter, currentChapterId) : chapter);
  }
  return [...byKey.values()].sort(compareChaptersByReadingOrder);
}

export interface ChapterNeighbors {
  current: MangaChapter | null;
  next: MangaChapter | null;
  prev: MangaChapter | null;
  ordered: MangaChapter[];
  /** Index of `current` within `ordered`, or -1 when it isn't present. */
  index: number;
}

export function getChapterNeighbors(
  chapters: MangaChapter[],
  currentChapterId: string,
): ChapterNeighbors {
  const ordered = normalizeChaptersForReading(chapters, currentChapterId);
  const index = ordered.findIndex((chapter) => chapter.id === currentChapterId);
  if (index < 0) return { current: null, next: null, prev: null, ordered, index };
  return {
    current: ordered[index],
    next: index < ordered.length - 1 ? ordered[index + 1] : null,
    prev: index > 0 ? ordered[index - 1] : null,
    ordered,
    index,
  };
}
