import { readStore, writeStore } from '@/lib/kv-store';

/**
 * Display preferences for the page reader (manga, manhwa and comics share it).
 *
 * One small JSON record in kv-store rather than a SecureStore key each, as the
 * older reader switches in lib/settings.ts are: these change together from one
 * sheet, the reader needs all of them before it lays out its first page (a
 * fit-width change after landing moves the page you resumed on), and
 * SecureStore on web is a shim over the same localStorage anyway.
 *
 * Kept in memory once read, so every reader open after the first starts with
 * the right layout synchronously (getReaderPrefsSnapshot) instead of
 * rendering with defaults for a frame and then re-laying out.
 */

export type ReaderPageFit = 'width' | 'height' | 'original';
export type ReaderBackground = 'black' | 'gray' | 'white';
/** Paged-mode click/tap zones. 'auto' follows the reading direction. */
export type ReaderTapZones = 'auto' | 'inverted' | 'off';

export interface ReaderPrefs {
  /**
   * How a page is sized in webtoon mode. 'width' fills the reading column,
   * 'height' fits a whole page on screen (manga pages; long strips stay on
   * width, see webtoonPageBox), 'original' shows the image's own pixels.
   */
  pageFit: ReaderPageFit;
  /**
   * Widest the reading column may grow, in CSS px. Only bites on screens
   * wider than it: a 690 px manhwa strip drawn 1440 px wide shows one speech
   * bubble per screen. READER_MAX_WIDTH_MAX means no cap.
   */
  maxWidth: number;
  background: ReaderBackground;
  /** A thin gap between webtoon pages, for chapters that are separate pages. */
  pageGap: boolean;
  /** 0.3–1. Below 1 a black layer dims the page (in-app, not the backlight). */
  brightness: number;
  /** Stop the screen sleeping while the reader is open. */
  keepAwake: boolean;
  /** Webtoon auto-scroll speed, 1 (slow) to 5 (fast). */
  autoScrollSpeed: number;
  tapZones: ReaderTapZones;
}

export const READER_MAX_WIDTH_MIN = 360;
export const READER_MAX_WIDTH_MAX = 1600;
export const READER_MAX_WIDTH_STEP = 40;
export const READER_BRIGHTNESS_MIN = 0.3;
export const AUTO_SCROLL_SPEEDS = 5;

/**
 * 720 px is about what WEBTOON's own desktop viewer uses (measured 700 px on a
 * 1440 px window) and keeps a 690–900 px source strip at or near 1:1. On a
 * phone the screen is narrower than this, so the default changes nothing there.
 */
export const DEFAULT_READER_PREFS: Readonly<ReaderPrefs> = Object.freeze({
  pageFit: 'width',
  maxWidth: 720,
  background: 'black',
  pageGap: false,
  brightness: 1,
  keepAwake: true,
  autoScrollSpeed: 2,
  tapZones: 'auto',
});

const FILE = 'sakura_reader_prefs.json';

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Any stored or patched value, made safe. Unknown keys are dropped. */
export function sanitizeReaderPrefs(raw: unknown): ReaderPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_READER_PREFS;
  const width = clampNumber(r.maxWidth, READER_MAX_WIDTH_MIN, READER_MAX_WIDTH_MAX, d.maxWidth);
  return {
    pageFit: pick(r.pageFit, ['width', 'height', 'original'] as const, d.pageFit),
    // Snapped to the slider's step so a stored value always matches a stop.
    maxWidth: Math.round(width / READER_MAX_WIDTH_STEP) * READER_MAX_WIDTH_STEP,
    background: pick(r.background, ['black', 'gray', 'white'] as const, d.background),
    pageGap: typeof r.pageGap === 'boolean' ? r.pageGap : d.pageGap,
    brightness: Math.round(clampNumber(r.brightness, READER_BRIGHTNESS_MIN, 1, d.brightness) * 100) / 100,
    keepAwake: typeof r.keepAwake === 'boolean' ? r.keepAwake : d.keepAwake,
    autoScrollSpeed: Math.round(clampNumber(r.autoScrollSpeed, 1, AUTO_SCROLL_SPEEDS, d.autoScrollSpeed)),
    tapZones: pick(r.tapZones, ['auto', 'inverted', 'off'] as const, d.tapZones),
  };
}

let current: ReaderPrefs | null = null;
let loading: Promise<ReaderPrefs> | null = null;
let writing: Promise<unknown> = Promise.resolve();
const listeners = new Set<(prefs: ReaderPrefs) => void>();

/** What the reader should lay out with right now: the stored prefs once read, else defaults. */
export function getReaderPrefsSnapshot(): ReaderPrefs {
  return current ?? { ...DEFAULT_READER_PREFS };
}

export function readerPrefsLoaded(): boolean {
  return current !== null;
}

export function loadReaderPrefs(): Promise<ReaderPrefs> {
  if (current) return Promise.resolve(current);
  if (loading) return loading;
  loading = (async () => {
    let parsed: unknown = null;
    try {
      const raw = await readStore(FILE);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // A corrupt record must never stop a chapter opening; defaults it is.
    }
    // A write that landed while the read was out wins over what was read.
    if (!current) current = sanitizeReaderPrefs(parsed);
    loading = null;
    return current;
  })();
  return loading;
}

/**
 * Change some prefs. Listeners hear the new value at once (the reader
 * re-lays out under the user's finger); the write follows, chained so a fast
 * run of slider steps lands in order.
 */
export async function updateReaderPrefs(patch: Partial<ReaderPrefs>): Promise<ReaderPrefs> {
  const base = current ?? (await loadReaderPrefs());
  const next = sanitizeReaderPrefs({ ...base, ...patch });
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch {
      // One broken listener must not stop the others or the write.
    }
  }
  const snapshot = JSON.stringify(next);
  writing = writing.then(() => writeStore(FILE, snapshot)).catch(() => undefined);
  await writing;
  return next;
}

export function subscribeReaderPrefs(fn: (prefs: ReaderPrefs) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
