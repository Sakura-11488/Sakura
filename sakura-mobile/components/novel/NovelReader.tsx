import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  StatusBar,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { BlurView } from 'expo-blur';
import {
  fetchNovelChapterListFor,
  fetchNovelChapterPage,
  peekNovelChapterList,
  peekNovelChapterPage,
  prefetchNovelChapterPage,
  type AllNovelChapter,
  type NovelChapterPage,
} from '@/lib/allnovel';
import { upsertReadingActivity, endReadingActivity } from '@/lib/reading-activity';
import {
  getAllNovelProgressEntries,
  getNovelReadProgress,
  setNovelReadProgress,
  type NovelProgress,
} from '@/lib/reader-progress';
import { recordReadingEvent } from '@/lib/gamification';
import { getOfflineNovelChapterContent } from '@/lib/novel-offline';
import { useTheme } from '@/lib/theme';
import { onTap as withTapSound } from '@/lib/sound';
import ReaderAskSheet from '@/components/reader/ReaderAskSheet';
import { buildReaderContext } from '@/lib/ai-context';
import { useWallet } from '@/lib/wallet/context';
import { chapterTitleFromPath, cleanChapterText, countWords, detectTextDirection } from '@/lib/novel-text';
import {
  anchorAtY,
  formatTimeLeft,
  nextReadingSpeed,
  paragraphTops,
  progressForAnchor,
  readingLineY,
  resolveResumeTarget,
  scrollYForLine,
  wordsRemaining,
  yForAnchor,
  type ParagraphAnchor,
  type ResumeTarget,
  type StoredAnchor,
} from '@/lib/novel-reader-position';
import {
  buildChapterReadState,
  findChapterNeighbours,
  seriesPathFromChapterPath,
  sortChaptersForReading,
  type ChapterReadState,
} from '@/lib/novel-navigation';
import {
  getNovelAnchor,
  getNovelReaderPrefsSnapshot,
  loadNovelReaderPrefs,
  novelColumn,
  novelFontFamily,
  peekNovelAnchor,
  resolveNovelReaderPalette,
  saveNovelAnchor,
  subscribeNovelReaderPrefs,
  updateNovelReaderPrefs,
  type NovelReaderPalette,
  type NovelReaderPrefs,
} from '@/lib/novel-reader-prefs';
import NovelReaderSettingsSheet from './NovelReaderSettingsSheet';
import NovelChapterDrawer from './NovelChapterDrawer';
import TapSurface from './TapSurface';
import {
  defaultTapZones,
  fullscreenSupported,
  prefersReducedMotion,
  useFlushOnBackground,
  useFullscreen,
  useKeepScreenAwake,
  useReaderKeys,
  type ReaderKeyAction,
} from './reader-platform';
import NovelReadAloud, { cancelReadAloudContinuation, readAloudSupported, type ReadAloudHandle } from './NovelReadAloud';

// ─── Icons ────────────────────────────────────────────────────────────────────

function Icon({ d, color, size = 22, stroke = 2 }: { d: string; color: string; size?: number; stroke?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
const ICONS = {
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  speaker: 'M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
};

/** "reincarnation-of-x.html" → "Reincarnation Of X", for titles nobody passed in. */
function prettifySeries(path: string): string {
  const slug = String(path ?? '').split('/').filter(Boolean)[0] ?? '';
  return slug
    .replace(/\.html?$/i, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const NO_PARAGRAPHS: string[] = [];
const SAVE_IDLE_MS = 1_500;
const SAVE_MAX_WAIT_MS = 8_000;
const PREFETCH_AT = 0.4;
/** Scroll gaps longer than this are a break, not reading time. */
const ACTIVE_GAP_MS = 60_000;

// ─── Paragraph ────────────────────────────────────────────────────────────────

const Paragraph = memo(function Paragraph({
  index,
  text,
  style,
  onMeasured,
  highlighted,
  highlightColor,
  hyphenate,
}: {
  index: number;
  text: string;
  style: TextStyle;
  onMeasured: (index: number, height: number) => void;
  highlighted: boolean;
  highlightColor: string;
  hyphenate: boolean;
}) {
  const onLayout = useCallback((e: LayoutChangeEvent) => onMeasured(index, e.nativeEvent.layout.height), [index, onMeasured]);
  return (
    <Text
      onLayout={onLayout}
      style={[style, highlighted && { backgroundColor: highlightColor }]}
      android_hyphenationFrequency={hyphenate ? 'normal' : 'none'}
    >
      {text}
    </Text>
  );
});

// ─── Reader ───────────────────────────────────────────────────────────────────

export interface NovelReaderProps {
  chapterPath: string;
  /** `o` route param: a 0–1 progress hint (legacy pixel values are ignored). */
  resumeParam?: string;
  novelTitleParam?: string;
  coverParam?: string;
  chapterTitleParam?: string;
  /** `novelPath` route param: the series (detail page) path. */
  seriesPathParam?: string;
  onOpenChapter: (target: { path: string; title?: string; seriesPath?: string; novelTitle?: string; cover?: string }) => void;
  onExit: (seriesPath?: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; page: NovelChapterPage; titleHint?: string }
  | { status: 'error' };

/**
 * One chapter of a novel. Mounted with key={chapterPath}, so moving to another
 * chapter starts from clean state (no position, timers or measurements leak
 * from the previous chapter) while the stack does not grow.
 *
 * Position: paragraph anchor + text-based progress (lib/novel-reader-position.ts).
 * Saving: on idle (1.5 s after scrolling stops, at most every 8 s while it
 * continues), on chapter change and exit, and when the app/tab is hidden. The
 * old reader wrote progress — and dismissed and re-posted the Android reading
 * notification — on every 24 px of scroll: 62 writes in one second of
 * scrolling, each re-rendering every mounted screen that lists progress.
 */
export default function NovelReader({
  chapterPath,
  resumeParam,
  novelTitleParam,
  coverParam,
  chapterTitleParam,
  seriesPathParam,
  onOpenChapter,
  onExit,
}: NovelReaderProps) {
  const isWeb = Platform.OS === 'web';
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { isDark: appIsDark } = useTheme();
  const { address } = useWallet();
  const scrollRef = useRef<ScrollView>(null);

  // ── Preferences ──
  const [prefs, setPrefs] = useState<NovelReaderPrefs>(getNovelReaderPrefsSnapshot);
  // Web reads preferences synchronously; native waits for the file so the
  // chapter is never laid out once in default type and again in the user's.
  const [prefsReady, setPrefsReady] = useState(isWeb);
  const beginReanchorRef = useRef<() => void>(() => {});
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => {
    const unsubscribe = subscribeNovelReaderPrefs((next) => {
      const prev = prefsRef.current;
      // Capture the paragraph being read BEFORE the new type reflows the
      // chapter; a theme or speed change moves nothing, so it is left alone.
      if (prev.font !== next.font || prev.fontSize !== next.fontSize || prev.lineHeight !== next.lineHeight || prev.margin !== next.margin || prev.justify !== next.justify) {
        beginReanchorRef.current();
      }
      setPrefs(next);
    });
    void loadNovelReaderPrefs().then((p) => {
      setPrefs(p);
      setPrefsReady(true);
    });
    return unsubscribe;
  }, []);
  const changePrefs = useCallback((patch: Partial<NovelReaderPrefs>) => {
    updateNovelReaderPrefs(patch);
  }, []);
  const palette: NovelReaderPalette = resolveNovelReaderPalette(prefs.theme, appIsDark);
  const tapZones = prefs.tapZones ?? defaultTapZones();

  // ── Saved position (shared progress row + local paragraph anchor) ──
  const [persisted, setPersisted] = useState<NovelProgress | null | undefined>(undefined);
  const [storedAnchor, setStoredAnchor] = useState<StoredAnchor | null | undefined>(() => (isWeb ? peekNovelAnchor(chapterPath) : undefined));
  useEffect(() => {
    let active = true;
    void getNovelReadProgress(chapterPath).then((row) => active && setPersisted(row ?? null)).catch(() => active && setPersisted(null));
    void getNovelAnchor(chapterPath).then((row) => active && setStoredAnchor(row ?? null)).catch(() => active && setStoredAnchor(null));
    return () => {
      active = false;
    };
  }, [chapterPath]);

  // ── Chapter text ──
  const [load, setLoad] = useState<LoadState>(() => {
    const page = peekNovelChapterPage(chapterPath);
    return page?.text ? { status: 'ready', page, titleHint: chapterTitleParam || page.title } : { status: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (load.status === 'ready' && attempt === 0) return;
    let cancelled = false;
    if (!chapterPath) {
      setLoad({ status: 'error' });
      return;
    }
    setLoad({ status: 'loading' });
    (async () => {
      const series = seriesPathParam || seriesPathFromChapterPath(chapterPath);
      // A downloaded chapter opens with no network at all, whichever screen opened it.
      const offline = await getOfflineNovelChapterContent(series, chapterPath).catch(() => null);
      if (cancelled) return;
      if (offline?.trim()) {
        setLoad({ status: 'ready', page: { path: chapterPath, text: offline }, titleHint: chapterTitleParam });
        return;
      }
      try {
        const page = await fetchNovelChapterPage(chapterPath);
        if (cancelled) return;
        setLoad(page?.text ? { status: 'ready', page, titleHint: chapterTitleParam || page.title } : { status: 'error' });
      } catch {
        if (!cancelled) setLoad({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // load is intentionally not a dependency: this effect produces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterPath, attempt]);

  const page = load.status === 'ready' ? load.page : null;
  // Cleaned once per load with the title known at that moment: re-cleaning
  // when the chapter list arrives could change the paragraph count under the
  // reader's saved position.
  const clean = useMemo(() => (page ? cleanChapterText(page.text, load.status === 'ready' ? load.titleHint : undefined) : null), [page, load]);
  const paragraphs = clean?.paragraphs ?? NO_PARAGRAPHS;
  const lengths = useMemo(() => paragraphs.map((p) => p.length), [paragraphs]);
  const words = useMemo(() => paragraphs.map((p) => countWords(p)), [paragraphs]);
  const totalWordsRef = useRef(0);
  totalWordsRef.current = words.reduce((a, b) => a + b, 0);
  const direction = useMemo(() => detectTextDirection(paragraphs.slice(0, 3).join(' ')), [paragraphs]);

  // ── Series, chapter list, neighbours ──
  const persistedSeries = persisted?.novelSeriesPath;
  const seriesPath = useMemo(() => {
    if (seriesPathParam) return seriesPathParam;
    if (page?.novelPath) return page.novelPath;
    // reader-progress falls back to "slug" (no .html) when nobody told it the
    // series; that is not a detail path for novelfull chapters.
    if (persistedSeries && (!/\.html?$/i.test(chapterPath) || /\.html?$/i.test(persistedSeries))) return persistedSeries;
    return seriesPathFromChapterPath(chapterPath);
  }, [seriesPathParam, page?.novelPath, persistedSeries, chapterPath]);

  const [chapters, setChapters] = useState<AllNovelChapter[] | null>(() => {
    const cached = peekNovelChapterList(seriesPathParam || seriesPathFromChapterPath(chapterPath));
    return cached ? sortChaptersForReading(cached) : null;
  });
  const [chaptersError, setChaptersError] = useState(false);
  const [chaptersAttempt, setChaptersAttempt] = useState(0);
  const novelIdHint = page?.novelId;
  const contentReady = load.status === 'ready';
  useEffect(() => {
    if (!seriesPath || !contentReady) return;
    const cached = peekNovelChapterList(seriesPath);
    if (cached) {
      setChapters(sortChaptersForReading(cached));
      return;
    }
    let active = true;
    setChaptersError(false);
    // After the text is on screen: the list (up to ~600 KB for long novels)
    // must never compete with the chapter itself.
    const timer = setTimeout(() => {
      fetchNovelChapterListFor(seriesPath, novelIdHint)
        .then((list) => active && setChapters(sortChaptersForReading(list)))
        .catch(() => active && setChaptersError(true));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [seriesPath, novelIdHint, contentReady, chaptersAttempt]);

  const nav = useMemo(() => findChapterNeighbours(chapters ?? [], chapterPath), [chapters, chapterPath]);
  const prevTarget = nav.prev ?? (page?.prevPath ? { path: page.prevPath, name: chapterTitleFromPath(page.prevPath), chapterNumber: 0 } : null);
  const nextTarget = nav.next ?? (page?.nextPath ? { path: page.nextPath, name: chapterTitleFromPath(page.nextPath), chapterNumber: 0 } : null);
  const chaptersSettled = chapters != null || chaptersError;

  const novelTitle =
    novelTitleParam ||
    page?.novelTitle ||
    (persisted?.title && persisted.title !== persisted.chapterLabel ? persisted.title : '') ||
    prettifySeries(seriesPath);
  const chapterTitle =
    chapterTitleParam ||
    page?.title ||
    nav.current?.name ||
    clean?.heading ||
    chapterTitleFromPath(chapterPath) ||
    'Chapter';
  const cover = coverParam || persisted?.cover || undefined;

  // ── Layout metrics ──
  const fontSize = prefs.fontSize;
  const lineHeightPx = Math.round(fontSize * prefs.lineHeight);
  const gap = Math.round(fontSize * 0.85);
  const column = novelColumn(prefs.margin, windowWidth);
  // The largest top inset seen, not the current one: the status bar hides with
  // the reader's bars on native, which can shrink insets.top (Android, iPhones
  // without a notch), and the text must not jump each time the bars toggle.
  const maxTopInset = useRef(0);
  maxTopInset.current = Math.max(maxTopInset.current, insets.top);
  const padTop = maxTopInset.current + (isWeb ? 84 : 72);
  // Clears the footer bar, so the end-of-chapter card is never under it.
  const padBottom = insets.bottom + 100;
  const fontFamily = novelFontFamily(prefs.font);
  const bodyStyle = useMemo<TextStyle>(
    () => ({
      fontFamily,
      fontSize,
      lineHeight: lineHeightPx,
      color: palette.text,
      marginBottom: gap,
      textAlign: prefs.justify ? 'justify' : direction === 'rtl' ? 'right' : 'left',
      writingDirection: direction,
      ...(isWeb && prefs.justify ? ({ hyphens: 'auto' } as object) : null),
    }),
    [fontFamily, fontSize, lineHeightPx, palette.text, gap, prefs.justify, direction, isWeb],
  );

  // ── Geometry & position (refs: scroll must not re-render the chapter) ──
  const geo = useRef({ heights: [] as number[], measured: 0, headerH: -1, viewportH: 0, contentH: 0, scrollY: 0 });
  const topsRef = useRef<number[] | null>(null);
  const restoredRef = useRef(false);
  const [revealed, setRevealed] = useState(false);
  const anchorRef = useRef<ParagraphAnchor>({ index: 0, offset: 0 });
  const progressRef = useRef(0);
  /**
   * Whether the position has changed since it was restored. Until it has,
   * there is nothing new to save — and saving anyway was harmful: a finished
   * chapter re-opens at the top, so merely opening one (a mis-tap in the
   * contents, a peek at a passage) and leaving overwrote its 100% with 0%,
   * and its read mark disappeared from the chapter lists.
   */
  const movedRef = useRef(false);
  const anchorLog = useRef<{ anchor: ParagraphAnchor; at: number }[]>([]);
  const reanchorRef = useRef<ParagraphAnchor | null>(null);
  const reanchorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState({ percent: 0, timeLeft: '' });
  const scrollDir = useRef({ lastY: 0, down: 0, up: 0 });
  const statusRef = useRef(status);
  statusRef.current = status;

  // Sized during render, not in an effect: on web the first measurements can
  // arrive before passive effects run, and a measurement dropped here is never
  // re-sent (the browser only reports size changes).
  const geoFor = useRef<string[] | null>(null);
  if (geoFor.current !== paragraphs) {
    geoFor.current = paragraphs;
    geo.current.heights = new Array(paragraphs.length).fill(-1);
    geo.current.measured = 0;
    topsRef.current = null;
  }

  const getTops = useCallback(() => {
    if (!topsRef.current) {
      const g = geo.current;
      topsRef.current = paragraphTops(g.heights.map((h) => Math.max(0, h)), gap, padTop + Math.max(0, g.headerH));
    }
    return topsRef.current;
  }, [gap, padTop]);
  useEffect(() => {
    topsRef.current = null;
  }, [gap, padTop]);

  const updateStatus = useCallback(
    (anchor: ParagraphAnchor, progress: number) => {
      const percent = Math.round(progress * 100);
      const timeLeft = formatTimeLeft(wordsRemaining(anchor, words), prefsRef.current.wpm);
      const prev = statusRef.current;
      if (prev.percent !== percent || prev.timeLeft !== timeLeft) {
        statusRef.current = { percent, timeLeft };
        setStatus({ percent, timeLeft });
      }
    },
    [words],
  );

  const scrollToY = useCallback((y: number, animated = false) => {
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: animated && !prefersReducedMotion() });
  }, []);

  /** Jump (not animate) to an anchor; returns the scroll offset used. */
  const scrollToAnchor = useCallback(
    (anchor: ParagraphAnchor) => {
      const g = geo.current;
      const line = yForAnchor(anchor, getTops(), g.heights);
      const y = scrollYForLine(line, g.viewportH, g.contentH);
      scrollToY(y);
      // A jump we made is not the reader scrolling forward: keep the bars as they are.
      scrollDir.current = { lastY: y, down: 0, up: 0 };
      return y;
    },
    [getTops, scrollToY],
  );

  // ── Restore ──
  const targetRef = useRef<ResumeTarget | null>(null);
  // Assigned once scheduleSave exists (declared further down).
  const scheduleSaveRef = useRef<() => void>(() => {});
  const tryRestore = useCallback(() => {
    if (restoredRef.current || !paragraphs.length) return;
    const g = geo.current;
    if (persisted === undefined || storedAnchor === undefined) return;
    if (g.measured < paragraphs.length || g.headerH < 0 || g.contentH <= 0 || g.viewportH <= 0) return;
    const target =
      targetRef.current ??
      resolveResumeTarget({
        param: resumeParam,
        persisted: persisted ? { progress: persisted.progress, updatedAt: persisted.updatedAt } : null,
        stored: storedAnchor,
        paragraphCount: paragraphs.length,
        lengths,
      });
    targetRef.current = target;
    let anchor = target.kind === 'anchor' ? target.anchor : { index: 0, offset: 0 };
    if (target.kind === 'anchor') scrollToAnchor(anchor);
    else scrollToY(0);
    restoredRef.current = true;
    let progress = target.kind === 'anchor' ? progressForAnchor(anchor, lengths) : 0;
    if (g.contentH <= g.viewportH) {
      // The whole chapter fits on screen: it has been read as soon as it is shown.
      anchor = { index: paragraphs.length - 1, offset: 1 };
      progress = 1;
      movedRef.current = true;
    }
    anchorRef.current = anchor;
    progressRef.current = progress;
    startProgress.current = progress;
    anchorLog.current = [{ anchor, at: Date.now() }];
    updateStatus(anchor, progress);
    if (progress >= 1) scheduleSaveRef.current();
    setRevealed(true);
  }, [paragraphs.length, persisted, storedAnchor, resumeParam, lengths, scrollToAnchor, scrollToY, updateStatus]);

  useEffect(() => {
    tryRestore();
  }, [tryRestore]);
  // Never leave the page invisible if a measurement never arrives: fall back
  // to the scroll fraction, which is what the text progress approximates.
  useEffect(() => {
    if (!contentReady || revealed) return;
    const t = setTimeout(() => {
      if (restoredRef.current) return;
      const g = geo.current;
      const target = resolveResumeTarget({
        param: resumeParam,
        persisted: persisted ? { progress: persisted.progress, updatedAt: persisted.updatedAt } : null,
        stored: storedAnchor ?? null,
        paragraphCount: paragraphs.length,
        lengths,
      });
      if (target.kind === 'anchor') {
        const p = progressForAnchor(target.anchor, lengths);
        scrollToY(p * Math.max(0, g.contentH - g.viewportH));
        anchorRef.current = target.anchor;
        progressRef.current = p;
      }
      restoredRef.current = true;
      setRevealed(true);
    }, 900);
    return () => clearTimeout(t);
  }, [contentReady, revealed, resumeParam, persisted, storedAnchor, paragraphs.length, lengths, scrollToY]);

  // ── Re-anchoring after font, spacing, margin or window changes ──
  const stableAnchor = useCallback((): ParagraphAnchor => {
    // A layout change can emit a scroll event (the browser clamps scrollTop)
    // before the new sizes are reported; skip anchors from the last ~2 frames.
    const cutoff = Date.now() - 60;
    const log = anchorLog.current;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].at <= cutoff) return log[i].anchor;
    return log[0]?.anchor ?? anchorRef.current;
  }, []);

  const runReanchor = useCallback(() => {
    reanchorTimer.current = null;
    const target = reanchorRef.current;
    const g = geo.current;
    if (!target) return;
    if (g.measured < g.heights.length || g.headerH < 0) {
      reanchorTimer.current = setTimeout(runReanchor, 60);
      return;
    }
    scrollToAnchor(target);
    anchorRef.current = target;
    anchorLog.current = [{ anchor: target, at: Date.now() }];
    // Let the scroll we just caused settle before scroll events count again.
    setTimeout(() => {
      reanchorRef.current = null;
    }, 50);
  }, [scrollToAnchor]);

  const scheduleReanchor = useCallback(() => {
    if (!restoredRef.current) return;
    if (!reanchorRef.current) reanchorRef.current = stableAnchor();
    if (reanchorTimer.current) clearTimeout(reanchorTimer.current);
    reanchorTimer.current = setTimeout(runReanchor, 90);
  }, [runReanchor, stableAnchor]);
  beginReanchorRef.current = scheduleReanchor;

  useEffect(() => () => {
    if (reanchorTimer.current) clearTimeout(reanchorTimer.current);
  }, []);

  const onParagraphMeasured = useCallback(
    (index: number, height: number) => {
      const g = geo.current;
      if (index >= g.heights.length) return;
      const prev = g.heights[index];
      if (prev === height) return;
      if (prev < 0) g.measured++;
      g.heights[index] = height;
      topsRef.current = null;
      if (restoredRef.current) scheduleReanchor();
      else tryRestore();
    },
    [scheduleReanchor, tryRestore],
  );

  const onHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      if (h === geo.current.headerH) return;
      geo.current.headerH = h;
      topsRef.current = null;
      if (restoredRef.current) scheduleReanchor();
      else tryRestore();
    },
    [scheduleReanchor, tryRestore],
  );

  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      if (h === geo.current.contentH) return;
      geo.current.contentH = h;
      if (restoredRef.current) {
        if (reanchorRef.current) scheduleReanchor();
      } else tryRestore();
    },
    [scheduleReanchor, tryRestore],
  );

  const onViewportLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      if (h === geo.current.viewportH) return;
      geo.current.viewportH = h;
      if (restoredRef.current) scheduleReanchor();
      else tryRestore();
    },
    [scheduleReanchor, tryRestore],
  );

  // ── Saving ──
  const meta = useRef({ novelTitle, chapterTitle, cover, seriesPath, count: paragraphs.length });
  meta.current = { novelTitle, chapterTitle, cover, seriesPath, count: paragraphs.length };
  const lastSaved = useRef<{ progress: number; index: number; offset: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPendingAt = useRef(0);

  const saveNow = useCallback(
    (urgent = false) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      firstPendingAt.current = 0;
      if (!restoredRef.current || !meta.current.count || !movedRef.current) return;
      const anchor = anchorRef.current;
      const progress = progressRef.current;
      const prev = lastSaved.current;
      if (prev && Math.abs(prev.progress - progress) < 0.001 && prev.index === anchor.index && Math.abs(prev.offset - anchor.offset) < 0.01) return;
      lastSaved.current = { progress, index: anchor.index, offset: anchor.offset };
      const m = meta.current;
      void setNovelReadProgress(chapterPath, {
        // Kept for older readers of this row; nothing restores from it now.
        offsetY: Math.round(geo.current.scrollY),
        progress,
        title: m.novelTitle || undefined,
        cover: m.cover,
        chapterLabel: m.chapterTitle,
        novelSeriesPath: m.seriesPath,
      });
      saveNovelAnchor(chapterPath, { index: anchor.index, offset: anchor.offset, count: m.count, progress }, urgent);
    },
    [chapterPath],
  );

  const scheduleSave = useCallback(() => {
    if (!restoredRef.current) return;
    const now = Date.now();
    if (!firstPendingAt.current) firstPendingAt.current = now;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const wait = Math.max(0, Math.min(SAVE_IDLE_MS, firstPendingAt.current + SAVE_MAX_WAIT_MS - now));
    saveTimer.current = setTimeout(() => saveNow(false), wait);
  }, [saveNow]);

  scheduleSaveRef.current = scheduleSave;
  useFlushOnBackground(() => saveNow(true));

  // ── Controls ──
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsRef = useRef(true);
  const setControls = useCallback((visible: boolean) => {
    if (controlsRef.current === visible) return;
    controlsRef.current = visible;
    setControlsVisible(visible);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const sheetOpen = settingsOpen || tocOpen || askOpen;

  const { noteActivity } = useKeepScreenAwake(isWeb && prefs.keepAwake);
  const lastActivity = useRef(0);

  // ── Reading-speed learning (see nextReadingSpeed) ──
  const activeMs = useRef(0);
  const lastSampleAt = useRef(0);
  const startProgress = useRef<number | null>(null);

  // ── Prefetch the next chapter so "Next" opens instantly ──
  const prefetched = useRef(false);
  const maybePrefetch = useCallback(
    (progress: number) => {
      if (prefetched.current || progress < PREFETCH_AT || !nextTarget) return;
      prefetched.current = true;
      prefetchNovelChapterPage(nextTarget.path);
    },
    [nextTarget],
  );

  // ── Read aloud (web) ──
  const readAloudRef = useRef<ReadAloudHandle>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const followSpeech = useRef(true);
  /** Until when scroll events come from read-aloud following, not from the reader. */
  const followScrollUntil = useRef(0);

  // ── Auto-scroll ──
  // A frame loop that advances its own float position (scrollTop rounds to
  // device pixels, so re-reading it would stall slow speeds). If the reader
  // scrolls by hand meanwhile, the loop adopts the new place and carries on.
  const [autoScroll, setAutoScroll] = useState<'off' | 'running' | 'paused'>('off');
  const autoPos = useRef(0);
  useEffect(() => {
    if (autoScroll !== 'running') return;
    let raf = 0;
    let last = 0;
    autoPos.current = geo.current.scrollY;
    const step = (t: number) => {
      const g = geo.current;
      if (last) {
        const dt = Math.min(0.1, (t - last) / 1000);
        if (Math.abs(g.scrollY - autoPos.current) > 48) autoPos.current = g.scrollY;
        autoPos.current += prefsRef.current.autoScrollSpeed * dt;
        const max = Math.max(0, g.contentH - g.viewportH);
        if (autoPos.current >= max) {
          scrollRef.current?.scrollTo({ y: max, animated: false });
          setAutoScroll('off');
          return;
        }
        scrollRef.current?.scrollTo({ y: autoPos.current, animated: false });
      }
      last = t;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoScroll]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      const g = geo.current;
      const y = contentOffset.y;
      g.scrollY = y;
      if (layoutMeasurement?.height) g.viewportH = layoutMeasurement.height;
      if (contentSize?.height) g.contentH = contentSize.height;
      if (!restoredRef.current || reanchorRef.current) return;

      // Bars: hide while reading forward, show on a deliberate scroll back or at the end.
      const d = scrollDir.current;
      const dy = y - d.lastY;
      d.lastY = y;
      // Our own restore/re-anchor jumps set lastY to their target, so they read as ~0 here.
      if (Math.abs(dy) > 1) movedRef.current = true;
      const max = Math.max(0, g.contentH - g.viewportH);
      if (dy > 0) {
        d.down += dy;
        d.up = 0;
      } else if (dy < 0) {
        d.up -= dy;
        d.down = 0;
      }
      if (!sheetOpen) {
        if (y >= max - 24) setControls(true);
        else if (d.down > 48 && y > 140) setControls(false);
        else if (d.up > 36) setControls(true);
      }

      const line = readingLineY(y, g.viewportH, g.contentH);
      const anchor = anchorAtY(line, getTops(), g.heights);
      const progress = progressForAnchor(anchor, lengths);
      anchorRef.current = anchor;
      progressRef.current = progress;
      const log = anchorLog.current;
      log.push({ anchor, at: Date.now() });
      if (log.length > 6) log.shift();
      updateStatus(anchor, progress);
      scheduleSave();
      maybePrefetch(progress);
      const now = Date.now();
      const sinceLast = now - lastSampleAt.current;
      if (lastSampleAt.current && sinceLast < ACTIVE_GAP_MS) activeMs.current += sinceLast;
      lastSampleAt.current = now;
      if (now - lastActivity.current > 5_000) {
        lastActivity.current = now;
        noteActivity();
      }
      // A manual scroll stops read-aloud from yanking the page back.
      if (speakingIndex != null && Math.abs(dy) > 4 && now > followScrollUntil.current) followSpeech.current = false;
    },
    [getTops, lengths, updateStatus, scheduleSave, maybePrefetch, noteActivity, setControls, sheetOpen, speakingIndex],
  );

  // ── Paging ──
  const pageBy = useCallback(
    (direction: 1 | -1) => {
      const g = geo.current;
      const bars = controlsRef.current ? 120 + insets.top + insets.bottom : 0;
      const step = Math.max(120, g.viewportH - bars - lineHeightPx * 2.5);
      scrollToY(g.scrollY + direction * step, true);
      noteActivity();
    },
    [insets.bottom, insets.top, lineHeightPx, scrollToY, noteActivity],
  );

  const goToChapter = useCallback(
    (target: { path: string; name?: string } | null) => {
      if (!target) return;
      saveNow(true);
      readAloudRef.current?.stop();
      onOpenChapter({
        path: target.path,
        title: target.name || undefined,
        seriesPath: meta.current.seriesPath,
        novelTitle: meta.current.novelTitle,
        cover: meta.current.cover,
      });
    },
    [onOpenChapter, saveNow],
  );

  const atEnd = () => {
    const g = geo.current;
    return g.scrollY >= Math.max(0, g.contentH - g.viewportH) - 4;
  };

  const onTapSurface = useCallback(
    (xf: number) => {
      if (sheetOpen) return;
      noteActivity();
      if (autoScroll === 'running') {
        // Tapping the page is how you stop a moving page.
        setAutoScroll('paused');
        setControls(true);
        return;
      }
      if (tapZones && xf < 0.28) pageBy(-1);
      else if (tapZones && xf > 0.72) pageBy(1);
      else setControls(!controlsRef.current);
    },
    [sheetOpen, tapZones, pageBy, setControls, noteActivity, autoScroll],
  );

  const startAutoScroll = useCallback(() => {
    readAloudRef.current?.stop();
    setSettingsOpen(false);
    setControls(false);
    setAutoScroll('running');
  }, [setControls]);

  useReaderKeys((action: ReaderKeyAction) => {
    if (sheetOpen) return false;
    const g = geo.current;
    switch (action) {
      case 'page-down':
        if (atEnd() && nextTarget) goToChapter(nextTarget);
        else pageBy(1);
        return;
      case 'page-up':
        pageBy(-1);
        return;
      case 'line-down':
        scrollToY(g.scrollY + lineHeightPx * 3, true);
        return;
      case 'line-up':
        scrollToY(g.scrollY - lineHeightPx * 3, true);
        return;
      case 'top':
        scrollToY(0, true);
        return;
      case 'bottom':
        scrollToY(g.contentH, true);
        return;
      case 'next-chapter':
        if (!nextTarget) return false;
        goToChapter(nextTarget);
        return;
      case 'prev-chapter':
        if (!prevTarget) return false;
        goToChapter(prevTarget);
        return;
      case 'toggle-controls':
        setControls(!controlsRef.current);
        return;
      case 'auto-scroll':
        if (autoScroll === 'running') setAutoScroll('paused');
        else startAutoScroll();
        return;
    }
  }, contentReady);

  const fullscreen = useFullscreen();

  // ── Reading activity (Android notification / iOS Live Activity) ──
  const percentBucket = Math.floor(status.percent / 5);
  useEffect(() => {
    if (!revealed || !contentReady) return;
    const p = statusRef.current.percent / 100;
    upsertReadingActivity(
      { title: novelTitle || 'Novel Reader', subtitle: chapterTitle || 'Reading chapter', progressText: `${Math.round(p * 100)}%`, progressPercent: p, kind: 'novel' },
      `sakura://novel/read?path=${encodeURIComponent(chapterPath)}&o=${p.toFixed(3)}`,
    );
  }, [percentBucket, revealed, contentReady, novelTitle, chapterTitle, chapterPath]);

  // ── Leaving the reader ──
  // A pending "read aloud into the next chapter" belongs to this book only.
  const exit = useCallback(() => {
    cancelReadAloudContinuation();
    onExit(meta.current.seriesPath);
  }, [onExit]);
  const everReady = useRef(false);
  const readyNow = contentReady && prefsReady && paragraphs.length > 0;
  if (readyNow) everReady.current = true;
  const failed = load.status === 'error' || (contentReady && paragraphs.length === 0);
  useEffect(() => {
    if (failed) cancelReadAloudContinuation();
  }, [failed]);

  // ── Leaving this chapter: final save, gamification, end the activity ──
  const openedAt = useRef(Date.now());
  useEffect(
    () => () => {
      // Left before this chapter could be shown (e.g. Back while the next
      // chapter was loading): do not let a later chapter start talking.
      if (!everReady.current) cancelReadAloudContinuation();
      saveNow(true);
      endReadingActivity();
      if (startProgress.current != null) {
        const wordsRead = Math.max(0, progressRef.current - startProgress.current) * totalWordsRef.current;
        const learned = nextReadingSpeed(prefsRef.current.wpm, wordsRead, activeMs.current);
        if (learned != null && learned !== prefsRef.current.wpm) updateNovelReaderPrefs({ wpm: learned });
      }
      const series = meta.current.seriesPath || chapterPath;
      const progress = progressRef.current;
      if (meta.current.count) {
        void recordReadingEvent({
          kind: 'novel',
          contentId: series,
          chapterId: chapterPath,
          seriesId: series,
          progress,
          dwellMs: Date.now() - openedAt.current,
          completed: progress >= 0.9,
        });
      }
    },
    // Mounted per chapter (key), so this runs exactly once on the way out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Read marks for the contents drawer ──
  const [readState, setReadState] = useState<ChapterReadState | null>(null);
  useEffect(() => {
    if (!tocOpen) return;
    let active = true;
    const base = seriesPath.replace(/\/$/, '');
    const slug = base.replace(/\.html?$/i, '');
    void getAllNovelProgressEntries().then((rows) => {
      if (!active) return;
      setReadState(
        buildChapterReadState(rows, (row) => {
          const s = (row.novelSeriesPath || '').replace(/\/$/, '');
          return s === base || s === slug || row.path.startsWith(`${slug}/`);
        }),
      );
    });
    return () => {
      active = false;
    };
  }, [tocOpen, seriesPath]);

  // ── Ask Sakura ──
  const [allowSpoilers, setAllowSpoilers] = useState(false);
  const aiContext = useMemo(
    () =>
      buildReaderContext({
        medium: 'novel',
        seriesId: seriesPath || undefined,
        seriesTitle: novelTitle || undefined,
        chapterId: chapterPath || undefined,
        chapterLabel: chapterTitle || undefined,
        // The ordered list is known now, so the position is too.
        chapterNumber: nav.index >= 0 ? nav.index + 1 : null,
        totalChapters: chapters?.length ?? null,
        allowSpoilers,
      }),
    [seriesPath, novelTitle, chapterPath, chapterTitle, nav.index, chapters?.length, allowSpoilers],
  );

  // ── Read aloud follows the spoken paragraph ──
  const onSpeakParagraph = useCallback(
    (index: number | null) => {
      setSpeakingIndex(index);
      if (index != null) setAutoScroll('off');
      if (index == null) {
        followSpeech.current = true;
        return;
      }
      if (!followSpeech.current) return;
      const g = geo.current;
      const tops = getTops();
      if (index >= tops.length) return;
      const top = tops[index];
      const bottom = top + Math.max(0, g.heights[index]);
      const viewTop = g.scrollY + (controlsRef.current ? 90 : 24);
      const viewBottom = g.scrollY + g.viewportH - (controlsRef.current ? 110 : 40);
      if (top < viewTop || bottom > viewBottom) {
        followScrollUntil.current = Date.now() + 900;
        scrollToY(top - g.viewportH * 0.25, true);
      }
    },
    [getTops, scrollToY],
  );
  // Start reading aloud from the first paragraph whose start is on screen.
  const speechStartIndex = useCallback(() => {
    const g = geo.current;
    const top = g.scrollY + (controlsRef.current ? 90 : 24);
    const a = anchorAtY(top, getTops(), g.heights);
    return a.offset > 0.02 ? Math.min(g.heights.length - 1, a.index + 1) : a.index;
  }, [getTops]);

  // ── Animated bars ──
  const headerStyle = useAnimatedStyle(() => ({
    opacity: withTiming(controlsVisible ? 1 : 0, { duration: 180 }),
    transform: [{ translateY: withTiming(controlsVisible ? 0 : -70, { duration: 200 }) }],
  }));
  const footerStyle = useAnimatedStyle(() => ({
    opacity: withTiming(controlsVisible ? 1 : 0, { duration: 180 }),
    transform: [{ translateY: withTiming(controlsVisible ? 0 : 90, { duration: 200 }) }],
  }));

  // ── Render ──
  const position = nav.index >= 0 ? `Ch ${(nav.index + 1).toLocaleString()} of ${nav.total.toLocaleString()}` : '';
  const statusText = [position, `${status.percent}%`, status.timeLeft].filter(Boolean).join(' · ');
  const iconColor = palette.text;
  // Phones are short of header room, and their browsers already go full
  // screen as the bars hide; the button earns its place on wider screens.
  const showFullscreen = isWeb && windowWidth >= 480 && fullscreenSupported();
  const canReadAloud = readAloudSupported();
  const ready = readyNow;
  const error = failed;
  const pageStyle = {
    width: '100%' as const,
    maxWidth: column.maxWidth,
    alignSelf: 'center' as const,
    paddingHorizontal: column.padding,
    paddingTop: padTop,
    paddingBottom: padBottom,
  };
  const wide = windowWidth > 760;

  return (
    <View style={[s.root, { backgroundColor: palette.bg }]}>
      {!isWeb ? (
        <StatusBar hidden={!controlsVisible && ready} animated showHideTransition="fade" barStyle={palette.isDark ? 'light-content' : 'dark-content'} />
      ) : null}

      {ready ? (
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={32}
          showsVerticalScrollIndicator={false}
          onLayout={onViewportLayout}
          onContentSizeChange={onContentSizeChange}
          style={{ opacity: revealed ? 1 : 0 }}
          accessibilityLabel={`${chapterTitle}`}
        >
          <TapSurface onTap={onTapSurface} windowWidth={windowWidth} style={pageStyle}>
            <View onLayout={onHeaderLayout} style={[s.chapterHead, { paddingBottom: Math.max(24, gap * 1.6) }]}>
              <Text style={[s.eyebrow, { color: palette.accent }]} numberOfLines={1}>
                {(novelTitle || 'Sakura').toUpperCase()}
              </Text>
              <Text
                accessibilityRole="header"
                style={[s.chapterTitle, { color: palette.text, fontFamily: novelFontFamily('serif'), fontSize: wide ? 31 : 25, lineHeight: wide ? 40 : 33 }]}
              >
                {chapterTitle}
              </Text>
              {clean?.credits.length ? (
                <Text style={[s.credits, { color: palette.muted }]}>{clean.credits.join('  ·  ')}</Text>
              ) : null}
              <View style={[s.headRule, { backgroundColor: palette.rule }]} />
            </View>

            {paragraphs.map((text, i) => (
              <Paragraph
                key={i}
                index={i}
                text={text}
                style={bodyStyle}
                onMeasured={onParagraphMeasured}
                highlighted={speakingIndex === i}
                highlightColor={palette.rule}
                hyphenate={prefs.justify}
              />
            ))}

            {/* End of chapter: the next step is right here, not on another screen. */}
            <View style={[s.endCard, { borderColor: palette.rule, backgroundColor: palette.card }]}>
              <Text style={[s.endEyebrow, { color: palette.accent }]}>END OF CHAPTER{position ? ` · ${position.toUpperCase()}` : ''}</Text>
              {nextTarget ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Next chapter: ${nextTarget.name || 'next'}`}
                  onPress={withTapSound(() => goToChapter(nextTarget))}
                  style={[s.endPrimary, { backgroundColor: palette.accent }]}
                  activeOpacity={0.85}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.endPrimaryLabel, { color: palette.bg }]}>Next chapter</Text>
                    {nextTarget.name ? (
                      <Text numberOfLines={1} style={[s.endPrimaryTitle, { color: palette.bg }]}>
                        {nextTarget.name}
                      </Text>
                    ) : null}
                  </View>
                  <Icon d={ICONS.next} color={palette.bg} />
                </TouchableOpacity>
              ) : !chaptersSettled ? (
                <View style={s.endWaiting}>
                  <ActivityIndicator color={palette.accent} />
                  <Text style={[s.endNote, { color: palette.muted }]}>Finding the next chapter…</Text>
                </View>
              ) : (
                <Text style={[s.endNote, { color: palette.text }]}>You are all caught up. New chapters will appear on the book page.</Text>
              )}
              <View style={s.endRow}>
                {prevTarget ? (
                  <TouchableOpacity accessibilityRole="button" onPress={withTapSound(() => goToChapter(prevTarget))} style={[s.endSecondary, { borderColor: palette.rule }]}>
                    <Text style={[s.endSecondaryText, { color: palette.text }]}>‹ Previous</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity accessibilityRole="button" onPress={() => setTocOpen(true)} style={[s.endSecondary, { borderColor: palette.rule }]}>
                  <Text style={[s.endSecondaryText, { color: palette.text }]}>Contents</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" onPress={withTapSound(exit)} style={[s.endSecondary, { borderColor: palette.rule }]}>
                  <Text style={[s.endSecondaryText, { color: palette.text }]}>Back to book</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TapSurface>
        </ScrollView>
      ) : error ? (
        <View style={[s.center, { paddingHorizontal: 26, paddingTop: insets.top + 60 }]}>
          <Text style={[s.errorTitle, { color: palette.text, fontFamily: novelFontFamily('serif') }]}>This chapter is unavailable.</Text>
          <Text style={[s.errorBody, { color: palette.muted }]}>Try loading it again, or return to the novel to choose another chapter.</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <TouchableOpacity accessibilityRole="button" onPress={() => setAttempt((a) => a + 1)} style={[s.errorBtn, { backgroundColor: palette.accent }]}>
              <Text style={{ color: palette.bg, fontSize: 14, fontWeight: '700' }}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" onPress={exit} style={[s.errorBtn, { borderWidth: 1, borderColor: palette.rule }]}>
              <Text style={{ color: palette.text, fontSize: 14, fontWeight: '600' }}>Back to book</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={[s.center, { paddingTop: insets.top }]} accessibilityLabel="Loading chapter" aria-busy>
          <ActivityIndicator size="large" color={palette.accent} />
          <Text style={[s.loadingText, { color: palette.muted }]} numberOfLines={2}>
            {chapterTitle}
          </Text>
        </View>
      )}

      {/* Thin progress line that stays when the bars are hidden. */}
      {ready && !controlsVisible ? (
        <View pointerEvents="none" style={[s.hairline, { bottom: insets.bottom }]}>
          <View style={{ width: `${status.percent}%`, height: '100%', backgroundColor: palette.accent, opacity: 0.7 }} />
        </View>
      ) : null}

      {/* Header */}
      <Animated.View style={[s.header, headerStyle]} pointerEvents={controlsVisible ? 'box-none' : 'none'}>
        <BlurView intensity={80} tint={palette.isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.bg, opacity: 0.72 }]} />
        <View style={[s.headerRow, { paddingTop: insets.top + 6 }, isWeb && { maxWidth: 1100, width: '100%', alignSelf: 'center', paddingHorizontal: wide ? 28 : 10 }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to novel" onPress={withTapSound(exit)} style={s.iconBtn}>
            <Icon d={ICONS.back} color={iconColor} />
          </TouchableOpacity>
          <View style={s.headerTitles}>
            <Text style={[s.headerNovel, { color: palette.muted }]} numberOfLines={1}>
              {novelTitle}
            </Text>
            <Text style={[s.headerChapter, { color: palette.text }]} numberOfLines={1}>
              {chapterTitle}
            </Text>
          </View>
          {canReadAloud && ready ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Read aloud" onPress={() => readAloudRef.current?.toggle()} style={s.iconBtn}>
              <Icon d={ICONS.speaker} color={speakingIndex != null ? palette.accent : iconColor} size={21} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Contents" onPress={() => setTocOpen(true)} style={s.iconBtn}>
            <Icon d={ICONS.list} color={iconColor} size={21} />
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Text and display settings" onPress={() => setSettingsOpen(true)} style={s.iconBtn}>
            <Text style={[s.aa, { color: iconColor, fontFamily: novelFontFamily('serif') }]}>Aa</Text>
          </TouchableOpacity>
          {showFullscreen ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={fullscreen.active ? 'Exit full screen' : 'Full screen'} onPress={fullscreen.toggle} style={s.iconBtn}>
              <Icon d={fullscreen.active ? ICONS.shrink : ICONS.expand} color={iconColor} size={19} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity accessibilityRole="button" onPress={withTapSound(() => setAskOpen(true))} style={[s.askBtn, { backgroundColor: palette.accent }]} accessibilityLabel="Ask about this chapter">
            <Text style={[s.askText, { color: palette.bg }]}>Ask</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Footer */}
      <Animated.View style={[s.footer, footerStyle]} pointerEvents={controlsVisible ? 'box-none' : 'none'}>
        <BlurView intensity={80} tint={palette.isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.bg, opacity: 0.72 }]} />
        <View style={[s.progressTrack, { backgroundColor: palette.rule }]}>
          <View style={{ width: `${status.percent}%`, height: '100%', backgroundColor: palette.accent }} />
        </View>
        <View style={[s.footerRow, { paddingBottom: insets.bottom + 8 }, isWeb && { maxWidth: 760, width: '100%', alignSelf: 'center' }]}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={prevTarget ? `Previous chapter: ${prevTarget.name || ''}` : 'No previous chapter'}
            accessibilityState={{ disabled: !prevTarget }}
            disabled={!prevTarget}
            onPress={withTapSound(() => goToChapter(prevTarget))}
            style={[s.navBtn, !prevTarget && s.dim]}
          >
            <Icon d={ICONS.back} color={iconColor} size={20} />
            {windowWidth >= 420 ? <Text style={[s.navText, { color: iconColor }]}>Prev</Text> : null}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Contents. ${statusText}`}
            onPress={() => setTocOpen(true)}
            style={s.footerCenter}
          >
            <Text style={[s.footerStatus, { color: palette.text }]} numberOfLines={1}>
              {ready ? statusText : ' '}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={nextTarget ? `Next chapter: ${nextTarget.name || ''}` : 'No next chapter'}
            accessibilityState={{ disabled: !nextTarget }}
            disabled={!nextTarget}
            onPress={withTapSound(() => goToChapter(nextTarget))}
            style={[s.navBtn, !nextTarget && s.dim]}
          >
            {windowWidth >= 420 ? <Text style={[s.navText, { color: iconColor }]}>Next</Text> : null}
            <Icon d={ICONS.next} color={iconColor} size={20} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {autoScroll !== 'off' && ready ? (
        <View
          style={[s.autoBar, { bottom: controlsVisible ? insets.bottom + 72 : insets.bottom + 14, backgroundColor: palette.card, borderColor: palette.rule }]}
          accessibilityLabel="Auto-scroll"
        >
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={autoScroll === 'running' ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            onPress={() => {
              if (autoScroll === 'running') setAutoScroll('paused');
              else {
                setControls(false);
                setAutoScroll('running');
              }
            }}
            style={[s.autoPlay, { backgroundColor: palette.accent }]}
          >
            <Text style={[s.autoGlyph, { color: palette.bg }]}>{autoScroll === 'running' ? '❚❚' : '▶'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Slower"
            disabled={prefs.autoScrollSpeed <= 10}
            onPress={() => changePrefs({ autoScrollSpeed: prefs.autoScrollSpeed - 10 })}
            style={[s.autoBtn, prefs.autoScrollSpeed <= 10 && s.dim]}
          >
            <Text style={[s.autoGlyph, { color: palette.text }]}>−</Text>
          </TouchableOpacity>
          <Text style={[s.autoSpeed, { color: palette.text }]} accessibilityLabel={`Speed ${Math.round(prefs.autoScrollSpeed / 10)} of 20`}>
            Speed {Math.round(prefs.autoScrollSpeed / 10)}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Faster"
            disabled={prefs.autoScrollSpeed >= 200}
            onPress={() => changePrefs({ autoScrollSpeed: prefs.autoScrollSpeed + 10 })}
            style={[s.autoBtn, prefs.autoScrollSpeed >= 200 && s.dim]}
          >
            <Text style={[s.autoGlyph, { color: palette.text }]}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Stop auto-scroll" onPress={() => setAutoScroll('off')} style={s.autoBtn}>
            <Text style={[s.autoGlyph, { color: palette.text }]}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {canReadAloud && ready ? (
        <NovelReadAloud
          ref={readAloudRef}
          paragraphs={paragraphs}
          palette={palette}
          rate={prefs.ttsRate}
          onRateChange={(ttsRate) => changePrefs({ ttsRate })}
          startIndex={speechStartIndex}
          onParagraph={onSpeakParagraph}
          onChapterEnd={() => (nextTarget ? goToChapter(nextTarget) : undefined)}
          hasNextChapter={!!nextTarget}
          title={`${novelTitle} — ${chapterTitle}`}
          bottomOffset={controlsVisible ? insets.bottom + 72 : insets.bottom + 14}
        />
      ) : null}

      <NovelReaderSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        prefs={prefs}
        tapZonesDefault={defaultTapZones()}
        palette={palette}
        appIsDark={appIsDark}
        onChange={changePrefs}
        onStartAutoScroll={startAutoScroll}
      />
      <NovelChapterDrawer
        visible={tocOpen}
        onClose={() => setTocOpen(false)}
        palette={palette}
        novelTitle={novelTitle}
        chapters={chapters}
        error={chaptersError}
        onRetry={() => setChaptersAttempt((a) => a + 1)}
        currentPath={chapterPath}
        currentProgress={status.percent / 100}
        readState={readState}
        onSelect={(chapter) => {
          setTocOpen(false);
          if (chapter.path !== chapterPath) goToChapter(chapter);
        }}
      />
      <ReaderAskSheet
        visible={askOpen}
        onClose={() => setAskOpen(false)}
        context={aiContext}
        walletAddress={address ?? undefined}
        allowSpoilers={allowSpoilers}
        onChangeAllowSpoilers={setAllowSpoilers}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
  errorTitle: { fontSize: 25, textAlign: 'center' },
  errorBody: { fontSize: 13, lineHeight: 21, textAlign: 'center', maxWidth: 380 },
  errorBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 999 },
  chapterHead: { marginBottom: 0 },
  eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: '700', marginBottom: 12 },
  chapterTitle: { fontWeight: '400' },
  credits: { fontSize: 12, marginTop: 10, fontStyle: 'italic' },
  headRule: { height: 1, marginTop: 22 },
  endCard: { marginTop: 28, borderRadius: 18, borderWidth: 1, padding: 18, gap: 14 },
  endEyebrow: { fontSize: 10, letterSpacing: 1.4, fontWeight: '700' },
  endPrimary: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18, minHeight: 56 },
  endPrimaryLabel: { fontSize: 15, fontWeight: '800' },
  endPrimaryTitle: { fontSize: 12, marginTop: 2, opacity: 0.85 },
  endWaiting: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 },
  endNote: { fontSize: 14, lineHeight: 21 },
  endRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  endSecondary: { borderWidth: 1, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 16, minHeight: 42, justifyContent: 'center' },
  endSecondaryText: { fontSize: 13, fontWeight: '600' },
  hairline: { position: 'absolute', left: 0, right: 0, height: 2, zIndex: 5 },
  header: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, overflow: 'hidden' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8, gap: 2 },
  headerTitles: { flex: 1, minWidth: 0, paddingHorizontal: 6 },
  headerNovel: { fontSize: 11, fontWeight: '600' },
  headerChapter: { fontSize: 14, fontWeight: '700' },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  aa: { fontSize: 18 },
  askBtn: { marginLeft: 4, paddingHorizontal: 13, height: 32, borderRadius: 16, justifyContent: 'center' },
  askText: { fontSize: 13, fontWeight: '700' },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10, overflow: 'hidden' },
  progressTrack: { height: 2, width: '100%' },
  footerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, gap: 4 },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 44, height: 44, paddingHorizontal: 8, justifyContent: 'center' },
  navText: { fontSize: 13, fontWeight: '600' },
  dim: { opacity: 0.3 },
  footerCenter: { flex: 1, minWidth: 0, height: 44, alignItems: 'center', justifyContent: 'center' },
  footerStatus: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  autoBar: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  autoPlay: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  autoBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  autoGlyph: { fontSize: 16, fontWeight: '700' },
  autoSpeed: { fontSize: 13, fontWeight: '700', minWidth: 70, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
