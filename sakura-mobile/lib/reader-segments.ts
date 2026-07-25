/**
 * The reader's page model once a session can hold more than one chapter.
 *
 * Everything here is pure so the reader screen keeps only the wiring. The
 * shapes exist to solve specific problems that appear the moment a second
 * chapter joins the list:
 *
 *  - Row ids must be globally unique. Pages used to be keyed `page-${i}`, which
 *    collides across chapters and quietly corrupts `keyExtractor`, expo-image's
 *    `recyclingKey` and the measured aspect-ratio cache — the same index in two
 *    chapters would share a cached height and recycle each other's bitmaps.
 *  - Progress, the page counter and gamification are all per chapter, so a
 *    segment has to remember which chapter a row belongs to rather than the
 *    list computing it from a flat index.
 *  - Rows are ALWAYS in reading order. Right-to-left is applied by mirroring
 *    the list, never by reversing the array: reversal would flip the whole
 *    book rather than each chapter, and it would invert append/prepend so that
 *    "next chapter" became a prepend — putting the risky index-shifting path on
 *    the common direction for manga readers.
 */

export interface ReaderPage {
  /** `${chapterId}#${pageIndex}` — unique across the whole session. */
  id: string;
  kind: 'page';
  url: string;
  chapterId: string;
  /** 0-based index within its own chapter, not within the flattened list. */
  pageIndex: number;
}

export interface ChapterMarker {
  /** `${chapterId}#marker` */
  id: string;
  kind: 'marker';
  chapterId: string;
  label: string;
}

export type ReaderRow = ReaderPage | ChapterMarker;

export interface ChapterSegment {
  chapterId: string;
  chapterNumber: number;
  chapterLabel: string;
  /** Index into the normalised chapter list; drives neighbour lookups. */
  orderIndex: number;
  origin: 'offline' | 'network';
  pages: ReaderPage[];
}

/** Row index range a chapter occupies in the flattened list, inclusive. */
export interface SegmentBound {
  start: number;
  end: number;
  /** Row index of this chapter's first *page*, skipping its marker. */
  firstPage: number;
}

export function buildSegment(args: {
  chapterId: string;
  chapterNumber: number;
  chapterLabel: string;
  orderIndex: number;
  origin: 'offline' | 'network';
  urls: string[];
}): ChapterSegment {
  const { chapterId, chapterNumber, chapterLabel, orderIndex, origin, urls } = args;
  return {
    chapterId,
    chapterNumber,
    chapterLabel,
    orderIndex,
    origin,
    pages: urls
      .filter(Boolean)
      .map((url, pageIndex) => ({
        id: `${chapterId}#${pageIndex}`,
        kind: 'page' as const,
        url,
        chapterId,
        pageIndex,
      })),
  };
}

/** Segments sorted into reading order. Callers should keep them sorted. */
export function sortSegments(segments: ChapterSegment[]): ChapterSegment[] {
  return [...segments].sort((a, b) => a.orderIndex - b.orderIndex);
}

/**
 * Flatten segments into the list's row array.
 *
 * `showMarkers` is false in paged mode on purpose. `getItemLayout` there
 * assumes every row is exactly one screen wide, and a shorter divider row would
 * silently desynchronise every offset after it — snapping, jumps and the page
 * counter all drift. Paged mode signals a boundary through the header instead.
 * No marker is emitted before the first segment; a divider at the very top of
 * the session reads as a header, not a boundary.
 */
export function flattenSegments(segments: ChapterSegment[], showMarkers: boolean): ReaderRow[] {
  const rows: ReaderRow[] = [];
  segments.forEach((segment, i) => {
    if (showMarkers && i > 0) {
      rows.push({
        id: `${segment.chapterId}#marker`,
        kind: 'marker',
        chapterId: segment.chapterId,
        label: segment.chapterLabel,
      });
    }
    rows.push(...segment.pages);
  });
  return rows;
}

export function segmentBounds(rows: ReaderRow[]): Record<string, SegmentBound> {
  const bounds: Record<string, SegmentBound> = {};
  rows.forEach((row, index) => {
    const existing = bounds[row.chapterId];
    if (!existing) {
      bounds[row.chapterId] = {
        start: index,
        end: index,
        firstPage: row.kind === 'page' ? index : -1,
      };
      return;
    }
    existing.end = index;
    if (existing.firstPage < 0 && row.kind === 'page') existing.firstPage = index;
  });
  return bounds;
}

/** Row index of a given page within a chapter, or -1 if it isn't resident. */
export function rowIndexFor(
  bounds: Record<string, SegmentBound>,
  chapterId: string,
  pageIndex: number,
): number {
  const bound = bounds[chapterId];
  if (!bound || bound.firstPage < 0) return -1;
  const index = bound.firstPage + pageIndex;
  return index >= bound.firstPage && index <= bound.end ? index : -1;
}

export function findSegment(
  segments: ChapterSegment[],
  chapterId: string,
): ChapterSegment | undefined {
  return segments.find((s) => s.chapterId === chapterId);
}

/**
 * Drop segments furthest from the one being read, keeping the active chapter
 * and its immediate neighbours.
 *
 * Evicts from the END of the array in preference to the front. Removing a
 * leading segment shifts every row index exactly as a prepend does, so it needs
 * the same scroll compensation; dropping from the far end is free. Only when
 * everything resident sits behind the reader is a front drop unavoidable, and
 * the caller must compensate for that case.
 */
export function pruneSegments(
  segments: ChapterSegment[],
  activeChapterId: string,
  maxResident: number,
): { kept: ChapterSegment[]; droppedFromFront: number } {
  if (segments.length <= maxResident) return { kept: segments, droppedFromFront: 0 };

  const sorted = sortSegments(segments);
  const activeIdx = sorted.findIndex((s) => s.chapterId === activeChapterId);
  if (activeIdx < 0) return { kept: segments, droppedFromFront: 0 };

  let start = 0;
  let end = sorted.length - 1;
  let droppedFromFront = 0;

  while (end - start + 1 > maxResident) {
    const behind = activeIdx - start;
    const ahead = end - activeIdx;
    // Never evict the active chapter or the one on either side of it.
    if (ahead > 1 && ahead >= behind) {
      end -= 1;
    } else if (behind > 1) {
      start += 1;
      droppedFromFront += 1;
    } else {
      break;
    }
  }

  return { kept: sorted.slice(start, end + 1), droppedFromFront };
}

/** How many chapters stay in memory. Bounds the array; expo-image bounds bitmaps. */
export const MAX_RESIDENT_SEGMENTS = 6;
/** Chapters kept behind the reader once it has moved on. */
export const MAX_BEHIND = 1;
