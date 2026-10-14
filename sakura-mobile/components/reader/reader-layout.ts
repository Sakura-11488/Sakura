/**
 * Pure geometry and input mapping for the page reader (app/chapter/[id].tsx).
 *
 * Kept free of React and react-native so the parts that decide where a page
 * lands — which is what "resume on page 60" and "don't stretch a strip to
 * 2000 px" both come down to — can be tested on their own.
 */

/** Fallback page aspect (height/width) until anything better is known. */
export const DEFAULT_PAGE_RATIO = 1.5;
/** Above this a page is a webtoon strip, which 'fit height' would shrink to a sliver. */
export const STRIP_RATIO = 2.2;
/** Fixed so getItemLayout can count on it. */
export const MARKER_HEIGHT = 64;
export const PAGE_GAP_PX = 12;
/** Webtoon end-of-chapter card height (the list footer). */
export const END_CARD_HEIGHT = 300;
/** Header spacer kept above the first row when an earlier chapter exists. */
export const LIST_HEADER_HEIGHT = 48;

export type PageFit = 'width' | 'height' | 'original';

/** What is known about one page's image: its aspect and, when known, natural width. */
export interface PageSize {
  /** height / width */
  ratio: number;
  /** Natural pixel width, when the source or the decoded image said. */
  width?: number;
}

export function isUsableRatio(ratio: unknown): ratio is number {
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0.05 && ratio < 100;
}

/** Median of the usable ratios, or null when there are none. */
export function medianRatio(ratios: Iterable<number | undefined | null>): number | null {
  const values: number[] = [];
  for (const r of ratios) if (isUsableRatio(r)) values.push(r);
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Width of the reading column. `maxWidth` at or beyond `noCapAt` means no cap.
 * Never wider than the window, never below 1 px (a 0-wide list divides by zero
 * further down).
 */
export function columnWidth(windowWidth: number, maxWidth: number, noCapAt: number): number {
  const cap = maxWidth >= noCapAt ? Number.POSITIVE_INFINITY : maxWidth;
  return Math.max(1, Math.floor(Math.min(windowWidth, cap)));
}

/**
 * The box one page is drawn in, in webtoon (vertical) mode.
 *
 *  - width:    fill the column.
 *  - height:   a whole page on one screen, for manga pages read vertically.
 *              Strips taller than STRIP_RATIO keep the column width — fitting
 *              a 690x13915 strip to a 900 px screen would make it 45 px wide.
 *  - original: the image's own pixels when known, never wider than the window.
 */
export function webtoonPageBox(args: {
  ratio: number;
  naturalWidth?: number;
  fit: PageFit;
  columnW: number;
  windowW: number;
  windowH: number;
}): { width: number; height: number } {
  const { ratio, naturalWidth, fit, columnW, windowW, windowH } = args;
  let width = columnW;
  if (fit === 'height' && ratio <= STRIP_RATIO && windowH > 0) {
    width = Math.min(columnW, windowH / ratio);
  } else if (fit === 'original' && naturalWidth && naturalWidth > 0) {
    width = Math.min(naturalWidth, windowW);
  }
  width = Math.max(1, Math.round(width));
  return { width, height: Math.max(1, Math.round(width * ratio)) };
}

/**
 * The ratio to lay a page out with: its own when known, else the median of
 * its chapter's known pages (a chapter's slices usually share one width, so
 * this is close), else the median of everything known, else 1.5.
 */
export function estimatedRatio(
  own: number | undefined,
  chapterMedian: number | null | undefined,
  sessionMedian: number | null | undefined,
): number {
  if (isUsableRatio(own)) return own;
  if (isUsableRatio(chapterMedian)) return chapterMedian;
  if (isUsableRatio(sessionMedian)) return sessionMedian;
  return DEFAULT_PAGE_RATIO;
}

export interface ListLayout {
  lengths: number[];
  offsets: number[];
  total: number;
}

/**
 * Prefix sums for FlatList.getItemLayout. Offsets start after the list header,
 * because VirtualizedList adds nothing for the header itself: an offset that
 * ignored it would land every jump that many pixels short.
 */
export function buildListLayout(lengths: number[], headerLength = 0): ListLayout {
  const offsets = new Array<number>(lengths.length);
  let at = headerLength;
  for (let i = 0; i < lengths.length; i += 1) {
    offsets[i] = at;
    at += lengths[i];
  }
  return { lengths, offsets, total: at };
}

/**
 * Index of the row containing `offset` (binary search over the prefix sums).
 * Offsets inside the header count as the first row, past the end as the last.
 */
export function rowAtOffset(layout: ListLayout, offset: number): number {
  const { offsets } = layout;
  if (offsets.length === 0) return -1;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where a scroll offset sits in a layout: the row under it and how far into
 * that row (0 at its top, below 1). A re-layout that scales rows — a new
 * width, a rotation — keeps the reader on the same spot of the same page by
 * landing at that row's new offset plus the same fraction of its new length.
 * Null for an empty layout. Offsets inside the header count as row 0's top.
 */
export function layoutAnchor(layout: ListLayout, offset: number): { index: number; fraction: number } | null {
  const index = rowAtOffset(layout, offset);
  if (index < 0) return null;
  const length = layout.lengths[index] ?? 0;
  if (!(length > 0)) return { index, fraction: 0 };
  const fraction = (offset - layout.offsets[index]) / length;
  return { index, fraction: Math.min(0.999, Math.max(0, fraction)) };
}

/**
 * How many pages past the one on screen to download ahead. Data saver keeps
 * exactly one: enough that the next turn is not a spinner, no bulk download
 * of pages that may never be read.
 */
export function lookAheadCount(mode: 'page' | 'scroll', dataSaver: boolean): number {
  if (dataSaver) return 1;
  return mode === 'scroll' ? 5 : 3;
}

/** URLs of the next `count` page rows after `fromRow`, spilling into the next resident chapter. */
export function lookAheadUrls(
  rows: ReadonlyArray<{ kind: string; url?: string }>,
  fromRow: number,
  count: number,
): string[] {
  const out: string[] = [];
  for (let i = Math.max(0, fromRow + 1); i < rows.length && out.length < count; i += 1) {
    const row = rows[i];
    if (row.kind === 'page' && row.url) out.push(row.url);
  }
  return out;
}

/** Auto-scroll speed per level, in px per second. Level 1 is a slow read of dense text. */
const AUTO_SCROLL_PX_PER_S = [40, 70, 110, 160, 240];
export function autoScrollPxPerSecond(level: number): number {
  const i = Math.min(AUTO_SCROLL_PX_PER_S.length, Math.max(1, Math.round(level))) - 1;
  return AUTO_SCROLL_PX_PER_S[i];
}

export type TapZoneSetting = 'auto' | 'inverted' | 'off';
export type TapZoneAction = 'prev' | 'next' | 'center';

/**
 * What a tap or click at `x` does in paged mode: outer thirds turn the page,
 * the middle is left to the overlay gesture. In right-to-left reading the next
 * page is on the left, so 'auto' follows the direction; 'inverted' is for
 * readers whose thumb expects the opposite.
 */
export function tapZoneAction(x: number, width: number, rtl: boolean, setting: TapZoneSetting): TapZoneAction {
  if (setting === 'off' || !(width > 0)) return 'center';
  const third = width / 3;
  const side: 'left' | 'right' | null = x < third ? 'left' : x > width - third ? 'right' : null;
  if (!side) return 'center';
  const forwardIsLeft = rtl !== (setting === 'inverted');
  return (side === 'left') === forwardIsLeft ? 'next' : 'prev';
}

export type ReaderKeyAction =
  | 'line-down'
  | 'line-up'
  | 'screen-down'
  | 'screen-up'
  | 'next-page'
  | 'prev-page'
  | 'next-chapter'
  | 'prev-chapter'
  | 'first-page'
  | 'last-page'
  | 'fullscreen'
  | 'escape';

/**
 * Desktop keyboard map. Paged mode turns pages with the arrows (mirrored for
 * right-to-left, like the pages themselves); webtoon mode scrolls with
 * ↑/↓/Space/PageUp/PageDown and uses ←/→ for chapters, since there is no
 * horizontal axis to move along. Anything with Ctrl/Cmd/Alt is left to the
 * browser (Cmd+← is Back, Ctrl+F is Find).
 */
export function readerKeyAction(
  e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  mode: 'page' | 'scroll',
  rtl: boolean,
): ReaderKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const paged = mode === 'page';
  const forward = paged ? 'next-page' : 'next-chapter';
  const backward = paged ? 'prev-page' : 'prev-chapter';
  switch (e.key) {
    case 'ArrowDown':
    case 'j':
    case 'J':
      return paged ? 'next-page' : 'line-down';
    case 'ArrowUp':
    case 'k':
    case 'K':
      return paged ? 'prev-page' : 'line-up';
    case ' ':
    case 'Spacebar':
      if (e.shiftKey) return paged ? 'prev-page' : 'screen-up';
      return paged ? 'next-page' : 'screen-down';
    case 'PageDown':
      return paged ? 'next-page' : 'screen-down';
    case 'PageUp':
      return paged ? 'prev-page' : 'screen-up';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return paged && rtl ? backward : forward;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return paged && rtl ? forward : backward;
    case 'Home':
      return 'first-page';
    case 'End':
      return 'last-page';
    case 'n':
    case 'N':
    case ']':
      return 'next-chapter';
    case 'p':
    case 'P':
    case '[':
      return 'prev-chapter';
    case 'f':
    case 'F':
      return 'fullscreen';
    case 'Escape':
      return 'escape';
    default:
      return null;
  }
}
