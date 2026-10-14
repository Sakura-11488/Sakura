import { Platform } from 'react-native';
import { readStore, writeStore } from '@/lib/kv-store';
import type { StoredAnchor } from '@/lib/novel-reader-position';

/**
 * Novel reader preferences and per-chapter paragraph anchors.
 *
 * Font size and theme used to be plain useState with fixed defaults, so every
 * chapter and every reload reset them (live: Night + A+ twice came back as
 * Light at 17 px), and the reader ignored the app's dark mode entirely —
 * opening a chapter from a dark detail page flashed a bright #fcf6f8 page.
 *
 * Stored through lib/kv-store (localStorage on web, a file on native). On web
 * the first read is synchronous (see getNovelReaderPrefsSnapshot) so the
 * reader's first frame already has the right theme instead of flashing the
 * default and repainting.
 */

export type NovelReaderFont = 'serif' | 'sans' | 'system';
export type NovelReaderThemeId = 'auto' | 'light' | 'sepia' | 'dark' | 'black';
export type NovelReaderMargin = 'narrow' | 'normal' | 'wide';

export interface NovelReaderPrefs {
  font: NovelReaderFont;
  /** px, 12–30 */
  fontSize: number;
  /** multiple of fontSize, 1.3–2.2 */
  lineHeight: number;
  margin: NovelReaderMargin;
  justify: boolean;
  theme: NovelReaderThemeId;
  /** Tap the left/right edge to turn a page. null = automatic (touch screens only). */
  tapZones: boolean | null;
  /** Web: hold a screen wake lock while reading. Native keeps its own behaviour. */
  keepAwake: boolean;
  /** Read-aloud speed (Web Speech rate), 0.5–2. */
  ttsRate: number;
  /** Auto-scroll speed in px per second, 10–200. */
  autoScrollSpeed: number;
  /** Learned reading speed (words per minute) for the time-left estimate. */
  wpm: number;
}

export const NOVEL_READER_DEFAULTS: NovelReaderPrefs = {
  font: 'serif',
  fontSize: Platform.OS === 'web' ? 19 : 18,
  lineHeight: 1.7,
  margin: 'normal',
  justify: false,
  theme: 'auto',
  tapZones: null,
  keepAwake: true,
  ttsRate: 1,
  autoScrollSpeed: 40,
  wpm: 230,
};

export const FONT_SIZE_RANGE = { min: 12, max: 30 } as const;
export const LINE_HEIGHT_RANGE = { min: 1.3, max: 2.2 } as const;

const FONTS: NovelReaderFont[] = ['serif', 'sans', 'system'];
const THEMES: NovelReaderThemeId[] = ['auto', 'light', 'sepia', 'dark', 'black'];
const MARGINS: NovelReaderMargin[] = ['narrow', 'normal', 'wide'];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Accept anything (old versions, hand-edited storage) and return a valid object. */
export function normalizeNovelReaderPrefs(raw: unknown): NovelReaderPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = NOVEL_READER_DEFAULTS;
  return {
    font: FONTS.includes(r.font as NovelReaderFont) ? (r.font as NovelReaderFont) : d.font,
    fontSize: Math.round(clamp(num(r.fontSize, d.fontSize), FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max)),
    lineHeight: Math.round(clamp(num(r.lineHeight, d.lineHeight), LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max) * 100) / 100,
    margin: MARGINS.includes(r.margin as NovelReaderMargin) ? (r.margin as NovelReaderMargin) : d.margin,
    justify: typeof r.justify === 'boolean' ? r.justify : d.justify,
    theme: THEMES.includes(r.theme as NovelReaderThemeId) ? (r.theme as NovelReaderThemeId) : d.theme,
    tapZones: typeof r.tapZones === 'boolean' ? r.tapZones : null,
    keepAwake: typeof r.keepAwake === 'boolean' ? r.keepAwake : d.keepAwake,
    ttsRate: Math.round(clamp(num(r.ttsRate, d.ttsRate), 0.5, 2) * 100) / 100,
    autoScrollSpeed: Math.round(clamp(num(r.autoScrollSpeed, d.autoScrollSpeed), 10, 200)),
    wpm: Math.round(clamp(num(r.wpm, d.wpm), 120, 600)),
  };
}

// ─── Themes ──────────────────────────────────────────────────────────────────

export interface NovelReaderPalette {
  id: Exclude<NovelReaderThemeId, 'auto'>;
  label: string;
  bg: string;
  text: string;
  muted: string;
  accent: string;
  /** Hairlines and card fills, already alpha-blended for this background. */
  rule: string;
  card: string;
  isDark: boolean;
}

export const NOVEL_READER_PALETTES: Record<NovelReaderPalette['id'], NovelReaderPalette> = {
  light: { id: 'light', label: 'Light', bg: '#FBF7F5', text: '#2D2229', muted: '#7C6B75', accent: '#A9497A', rule: '#A9497A26', card: '#F3E9EE', isDark: false },
  sepia: { id: 'sepia', label: 'Sepia', bg: '#F4ECDC', text: '#3F2F22', muted: '#7E6A54', accent: '#9A5634', rule: '#9A563426', card: '#EBDFCB', isDark: false },
  dark: { id: 'dark', label: 'Dark', bg: '#1E1A20', text: '#E8DFE5', muted: '#A99BA4', accent: '#E6A5BE', rule: '#E6A5BE26', card: '#2A242C', isDark: true },
  // OLED: true black saves power on OLED screens and has no glow at night.
  black: { id: 'black', label: 'Black', bg: '#000000', text: '#CFC6CB', muted: '#8C8389', accent: '#E6A5BE', rule: '#E6A5BE22', card: '#141114', isDark: true },
};

/** 'auto' follows the app's light/dark setting. */
export function resolveNovelReaderPalette(theme: NovelReaderThemeId, appIsDark: boolean): NovelReaderPalette {
  if (theme === 'auto') return NOVEL_READER_PALETTES[appIsDark ? 'dark' : 'light'];
  return NOVEL_READER_PALETTES[theme] ?? NOVEL_READER_PALETTES.light;
}

// ─── Typography ──────────────────────────────────────────────────────────────

/** Font family for the platform. Web gets full fallback stacks so a missing face never drops to Times. */
export function novelFontFamily(font: NovelReaderFont, os: string = Platform.OS): string | undefined {
  if (os === 'web') {
    if (font === 'serif') return 'Charter, "Iowan Old Style", Georgia, "Noto Serif", "Times New Roman", serif';
    if (font === 'sans') return '"Source Sans 3", "Helvetica Neue", Arial, "Noto Sans", sans-serif';
    return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  }
  if (font === 'serif') return os === 'ios' ? 'Georgia' : 'serif';
  if (font === 'sans') return os === 'ios' ? 'Helvetica Neue' : 'sans-serif';
  return undefined; // The OS UI font.
}

/** Horizontal padding and, on wide screens, the text column width. */
export function novelColumn(margin: NovelReaderMargin, windowWidth: number): { maxWidth: number; padding: number } {
  const narrowScreen = windowWidth < 600;
  if (margin === 'narrow') return { maxWidth: 860, padding: narrowScreen ? 14 : 28 };
  if (margin === 'wide') return { maxWidth: 600, padding: narrowScreen ? 34 : 48 };
  return { maxWidth: 720, padding: narrowScreen ? 22 : 40 };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const PREFS_FILE = 'sakura_novel_reader_prefs.json';
const ANCHORS_FILE = 'sakura_novel_anchors.json';
/** Mirrors kv-store's web key prefix so the first read can be synchronous. */
const WEB_KEY_PREFIX = 'sakura_store_';
const MAX_ANCHORS = 300;

let prefs: NovelReaderPrefs | null = null;
let prefsLoad: Promise<NovelReaderPrefs> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(p: NovelReaderPrefs) => void>();

function readWebSync(name: string): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(`${WEB_KEY_PREFIX}${name}`) : null;
  } catch {
    return null;
  }
}

function parse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Current preferences without waiting. On web this is exact from the first
 * call; on native it is the defaults until loadNovelReaderPrefs resolves (a
 * file read), after which subscribers receive the stored values.
 */
export function getNovelReaderPrefsSnapshot(): NovelReaderPrefs {
  if (prefs) return prefs;
  if (Platform.OS === 'web') {
    prefs = normalizeNovelReaderPrefs(parse(readWebSync(PREFS_FILE)));
    return prefs;
  }
  return NOVEL_READER_DEFAULTS;
}

export function loadNovelReaderPrefs(): Promise<NovelReaderPrefs> {
  if (prefs) return Promise.resolve(prefs);
  if (!prefsLoad) {
    prefsLoad = readStore(PREFS_FILE)
      .then((raw) => {
        // A save that happened while the file was loading wins.
        if (!prefs) prefs = normalizeNovelReaderPrefs(parse(raw));
        listeners.forEach((fn) => fn(prefs!));
        return prefs!;
      })
      .catch(() => {
        prefs = prefs ?? NOVEL_READER_DEFAULTS;
        return prefs;
      });
  }
  return prefsLoad;
}

export function updateNovelReaderPrefs(patch: Partial<NovelReaderPrefs>): NovelReaderPrefs {
  const next = normalizeNovelReaderPrefs({ ...getNovelReaderPrefsSnapshot(), ...patch });
  prefs = next;
  listeners.forEach((fn) => fn(next));
  // Coalesce slider-style bursts (A+ A+ A+) into one write.
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeStore(PREFS_FILE, JSON.stringify(prefs));
  }, 250);
  return next;
}

export function subscribeNovelReaderPrefs(fn: (p: NovelReaderPrefs) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ─── Paragraph anchors ───────────────────────────────────────────────────────
//
// lib/reader-progress.ts owns the shared progress row (it feeds Continue
// Reading and cloud sync) and its writer keeps a fixed set of fields, so the
// precise paragraph anchor lives here, keyed by chapter path. The shared
// `progress` value is text-based too (see lib/novel-reader-position.ts), so
// another device can still find the same paragraph from it alone.

type AnchorMap = Record<string, StoredAnchor>;
let anchors: AnchorMap | null = null;
let anchorsLoad: Promise<AnchorMap> | null = null;
let anchorTimer: ReturnType<typeof setTimeout> | null = null;

function loadAnchors(): Promise<AnchorMap> {
  if (anchors) return Promise.resolve(anchors);
  if (!anchorsLoad) {
    const sync = parse(readWebSync(ANCHORS_FILE));
    if (sync && typeof sync === 'object') {
      anchors = sync as AnchorMap;
      return Promise.resolve(anchors);
    }
    anchorsLoad = readStore(ANCHORS_FILE)
      .then((raw) => {
        const parsed = parse(raw);
        anchors = { ...(parsed && typeof parsed === 'object' ? (parsed as AnchorMap) : {}), ...(anchors ?? {}) };
        return anchors;
      })
      .catch(() => (anchors = anchors ?? {}));
  }
  return anchorsLoad;
}

export async function getNovelAnchor(chapterPath: string): Promise<StoredAnchor | null> {
  if (!chapterPath) return null;
  const map = await loadAnchors();
  const row = map[chapterPath];
  if (!row || !Number.isFinite(row.index) || !Number.isFinite(row.offset)) return null;
  return row;
}

/** Synchronous peek for web's first frame; null on native until loaded. */
export function peekNovelAnchor(chapterPath: string): StoredAnchor | null {
  if (!anchors) {
    const sync = parse(readWebSync(ANCHORS_FILE));
    if (sync && typeof sync === 'object') anchors = sync as AnchorMap;
  }
  return anchors?.[chapterPath] ?? null;
}

export function saveNovelAnchor(chapterPath: string, anchor: Omit<StoredAnchor, 'savedAt'>, flushNow = false) {
  if (!chapterPath) return;
  void loadAnchors().then((map) => {
    map[chapterPath] = { ...anchor, savedAt: Date.now() };
    // Keep the newest few hundred; older chapters fall back to shared progress.
    const keys = Object.keys(map);
    if (keys.length > MAX_ANCHORS) {
      keys
        .sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0))
        .slice(0, keys.length - MAX_ANCHORS)
        .forEach((k) => delete map[k]);
    }
    if (anchorTimer) clearTimeout(anchorTimer);
    const write = () => {
      anchorTimer = null;
      void writeStore(ANCHORS_FILE, JSON.stringify(map));
    };
    if (flushNow) write();
    else anchorTimer = setTimeout(write, 400);
  });
}
