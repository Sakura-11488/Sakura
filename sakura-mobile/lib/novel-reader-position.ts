/**
 * Where the reader is in a chapter, independent of pixels.
 *
 * The novel reader used to save a raw scroll offset. The same chapter is
 * 11,021 px tall on a desktop and 17,507 px on a phone, and pressing A+ twice
 * grew it from 11,021 to 15,416 px, so a saved offset of 3,000 meant 27% on one
 * device, 17% on another and 25% after a font change. Positions are now a
 * paragraph index plus how far through that paragraph, and the shared 0–1
 * `progress` is the fraction of the chapter's TEXT before that point, which is
 * the same number on every device and at every font size.
 *
 * The anchored point is a "reading line" that slides from the top of the
 * viewport (at the start of the chapter) to the bottom (at the end):
 *
 *   line = scrollY + viewportH × scrollY / (contentH − viewportH)
 *
 * which simplifies to line = scrollY × contentH / maxScroll. At the top of the
 * chapter it is 0, at the bottom it is the end of the text, so progress runs
 * smoothly from 0 to 1 — a top-of-screen anchor would stall at ~90% and jump.
 * It also means the old scroll fraction (offsetY / maxScroll) is exactly the
 * line's fraction of the content, which is how legacy entries migrate.
 *
 * Pure functions, unit-tested in test/novel-reader.test.mjs.
 */

export interface ParagraphAnchor {
  /** Paragraph index (0-based). */
  index: number;
  /** 0–1 position inside that paragraph. */
  offset: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** prefix[i] = sum of values[0..i-1]; length n + 1. */
export function prefixSums(values: readonly number[]): number[] {
  const out = new Array<number>(values.length + 1);
  out[0] = 0;
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i] + Math.max(0, values[i] || 0);
  return out;
}

/**
 * Paragraph tops from heights alone.
 *
 * Built from sizes, never from measured positions: on web, onLayout is driven
 * by a ResizeObserver, which reports a paragraph whose SIZE changed but not one
 * that merely moved. Summing heights stays correct either way.
 */
export function paragraphTops(heights: readonly number[], gap: number, origin = 0): number[] {
  const tops = new Array<number>(heights.length);
  let y = origin;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += Math.max(0, heights[i] || 0) + gap;
  }
  return tops;
}

/** Last index whose value is <= y (binary search); -1 when y is before the first. */
function floorIndex(sorted: readonly number[], y: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= y) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function anchorAtY(y: number, tops: readonly number[], heights: readonly number[]): ParagraphAnchor {
  const n = tops.length;
  if (n === 0) return { index: 0, offset: 0 };
  const i = floorIndex(tops, y);
  if (i < 0) return { index: 0, offset: 0 };
  const h = Math.max(1, heights[i] || 0);
  // In the gap below paragraph i: count it as finished.
  return { index: i, offset: clamp01((y - tops[i]) / h) };
}

export function yForAnchor(anchor: ParagraphAnchor, tops: readonly number[], heights: readonly number[]): number {
  const n = tops.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.floor(anchor.index || 0)));
  return tops[i] + clamp01(anchor.offset) * Math.max(0, heights[i] || 0);
}

export function maxScroll(viewportH: number, contentH: number): number {
  return Math.max(0, contentH - viewportH);
}

/** The anchored line for a scroll position (see the file comment). */
export function readingLineY(scrollY: number, viewportH: number, contentH: number): number {
  const max = maxScroll(viewportH, contentH);
  if (max <= 0) return contentH; // Everything fits on screen: the chapter is in view.
  const s = Math.min(max, Math.max(0, scrollY));
  return (s * contentH) / max;
}

/** Inverse of readingLineY. */
export function scrollYForLine(lineY: number, viewportH: number, contentH: number): number {
  const max = maxScroll(viewportH, contentH);
  if (max <= 0 || contentH <= 0) return 0;
  return Math.min(max, Math.max(0, (lineY * max) / contentH));
}

/** Fraction of the chapter's characters before the anchor. */
export function progressForAnchor(anchor: ParagraphAnchor, lengths: readonly number[]): number {
  const n = lengths.length;
  if (n === 0) return 0;
  const sums = prefixSums(lengths);
  const total = sums[n];
  if (total <= 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.floor(anchor.index || 0)));
  return clamp01((sums[i] + clamp01(anchor.offset) * Math.max(0, lengths[i] || 0)) / total);
}

export function anchorForProgress(progress: number, lengths: readonly number[]): ParagraphAnchor {
  const n = lengths.length;
  if (n === 0) return { index: 0, offset: 0 };
  const sums = prefixSums(lengths);
  const total = sums[n];
  if (total <= 0) return { index: 0, offset: 0 };
  const target = clamp01(progress) * total;
  if (target >= total) return { index: n - 1, offset: 1 };
  let i = floorIndex(sums.slice(0, n), target);
  if (i < 0) i = 0;
  const len = Math.max(1, lengths[i] || 0);
  return { index: i, offset: clamp01((target - sums[i]) / len) };
}

/** Words after the anchor, for "~6 min left". */
export function wordsRemaining(anchor: ParagraphAnchor, words: readonly number[]): number {
  const n = words.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.floor(anchor.index || 0)));
  let rest = Math.max(0, words[i] || 0) * (1 - clamp01(anchor.offset));
  for (let k = i + 1; k < n; k++) rest += Math.max(0, words[k] || 0);
  return Math.round(rest);
}

export function formatTimeLeft(words: number, wpm: number): string {
  const rate = Number.isFinite(wpm) && wpm > 0 ? wpm : 230;
  const minutes = words / rate;
  if (words <= 0) return '';
  if (minutes < 1) return '< 1 min left';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min left`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

/** A locally saved anchor, with what it needs to stay trustworthy. */
export interface StoredAnchor extends ParagraphAnchor {
  /** Paragraph count when saved: a different count means the text changed. */
  count: number;
  /** The progress value saved alongside it. */
  progress: number;
  savedAt: number;
}

export type ResumeTarget =
  | { kind: 'top' }
  | { kind: 'anchor'; anchor: ParagraphAnchor; source: 'anchor' | 'progress' | 'param' };

/**
 * Where to open a chapter.
 *
 * - `param` is the `o` route parameter. Callers pass a 0–1 progress, except
 *   app/reading-history.tsx, which passes the legacy pixel offset (e.g.
 *   "3000"). The old reader clamped that to 1 and opened at the END of the
 *   chapter, so any value above 1 is treated as "no hint" and the saved
 *   position is used instead.
 * - A local paragraph anchor wins when it is at least as new as the shared
 *   progress row and the paragraph count still matches; otherwise the shared
 *   progress (which may have come from another device) is converted.
 * - A finished chapter (>= 98%) opened again starts from the top, since
 *   landing on the end-of-chapter card is never what someone re-opening it wants.
 */
export function resolveResumeTarget(input: {
  param?: string | null;
  persisted?: { progress: number; updatedAt: number } | null;
  stored?: StoredAnchor | null;
  paragraphCount: number;
  lengths: readonly number[];
}): ResumeTarget {
  const { persisted, stored, paragraphCount, lengths } = input;
  const raw = input.param == null || input.param === '' ? NaN : Number(input.param);
  const paramProgress = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
  const finished = (p: number) => p >= 0.98;

  const storedUsable =
    !!stored &&
    stored.count === paragraphCount &&
    (!persisted || stored.savedAt >= (persisted.updatedAt || 0) - 5_000);

  if (storedUsable && stored) {
    // A param that disagrees a lot with the anchor came from somewhere newer
    // (a deep link or another device); otherwise the anchor is more precise.
    if (paramProgress == null || Math.abs(paramProgress - stored.progress) < 0.03) {
      if (finished(stored.progress)) return { kind: 'top' };
      return { kind: 'anchor', anchor: { index: stored.index, offset: stored.offset }, source: 'anchor' };
    }
  }

  const progress = paramProgress ?? persisted?.progress ?? 0;
  if (!(progress > 0.001) || finished(progress)) return { kind: 'top' };
  return {
    kind: 'anchor',
    anchor: anchorForProgress(progress, lengths),
    source: paramProgress != null ? 'param' : 'progress',
  };
}

/**
 * Learn the reader's own speed for "~6 min left".
 *
 * Called when a chapter is left, with the words advanced through and the
 * ACTIVE time (gaps of a minute or more without scrolling are not counted, so
 * a phone left on the table does not make someone a slow reader). Sessions
 * too short to mean anything, and implausible rates from skimming, are
 * ignored; otherwise the stored speed moves 30% of the way toward this
 * session's, so one odd chapter cannot swing it.
 */
export function nextReadingSpeed(currentWpm: number, wordsRead: number, activeMs: number): number | null {
  const minutes = activeMs / 60_000;
  if (!(minutes >= 1) || !(wordsRead >= 150)) return null;
  const session = wordsRead / minutes;
  if (session < 80 || session > 900) return null;
  const base = Number.isFinite(currentWpm) && currentWpm > 0 ? currentWpm : 230;
  return Math.round(Math.min(600, Math.max(120, base * 0.7 + session * 0.3)));
}
