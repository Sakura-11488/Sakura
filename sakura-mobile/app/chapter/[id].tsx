import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, StatusBar, ActivityIndicator, InteractionManager, Platform, AppState, Animated, useWindowDimensions, type ViewToken, type NativeSyntheticEvent, type NativeScrollEvent, type GestureResponderEvent } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Colors, Radius, FontSize, FontWeight } from '@/constants/theme';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import {
  loadChapterPages,
  fetchReaderChapterList,
  prefetchChapterPages,
  getRememberedPageSizes,
  rememberPageSizes,
  type LoadedChapterPages,
  type PageSizeHint,
} from '@/lib/chapter-pages';
import { warmReaderImage } from '@/components/reader/warm-reader-image';
import { setReaderLookAhead, clearReaderLookAhead } from '@/components/reader/reader-prefetch';
import { useReaderKeepAwake } from '@/components/reader/useReaderKeepAwake';
import ChapterEndCard from '@/components/reader/ChapterEndCard';
import {
  END_CARD_HEIGHT,
  LIST_HEADER_HEIGHT,
  MARKER_HEIGHT,
  PAGE_GAP_PX,
  autoScrollPxPerSecond,
  buildListLayout,
  columnWidth,
  estimatedRatio,
  isUsableRatio,
  lookAheadCount,
  lookAheadUrls,
  medianRatio,
  layoutAnchor,
  readerKeyAction,
  tapZoneAction,
  webtoonPageBox,
  type ListLayout,
  type PageSize,
} from '@/components/reader/reader-layout';
import {
  getReaderPrefsSnapshot,
  loadReaderPrefs,
  readerPrefsLoaded,
  subscribeReaderPrefs,
  updateReaderPrefs,
  READER_MAX_WIDTH_MAX,
  READER_MAX_WIDTH_MIN,
  type ReaderPrefs,
} from '@/lib/reader-prefs';
import { markChapterRead } from '@/lib/chapter-read-state';
import { getOfflineMangaPageUris } from '@/lib/manga-offline';
import { getScrapedOfflinePageUris } from '@/lib/scraped-offline';
import { isOnline } from '@/lib/use-online';
import type { MangaChapter } from '@/lib/manga';
import {
  buildSegment,
  flattenSegments,
  segmentBounds,
  findSegment,
  rowIndexFor,
  pruneSegments,
  MAX_RESIDENT_SEGMENTS,
  type ChapterSegment,
  type ReaderRow,
} from '@/lib/reader-segments';
import { upsertReadingActivity, endReadingActivity } from '@/lib/reading-activity';
import { AppSettings } from '@/lib/settings';
import { setMangaReadProgress, type UpNextChapter } from '@/lib/reader-progress';
import { recordReadingEvent } from '@/lib/gamification';
import EmptyState from '@/components/ui/EmptyState';
import ReaderSettingsSheet from '@/components/reader/ReaderSettingsSheet';
import ReaderAskSheet from '@/components/reader/ReaderAskSheet';
import { buildReaderContext, mediumFromSource } from '@/lib/ai-context';
import ReaderChapterBar from '@/components/reader/ReaderChapterBar';
import ReaderPageImage from '@/components/reader/ReaderPageImage';
import { onTap, playTap } from '@/lib/sound';
import { useWallet } from '@/lib/wallet/context';
import { checkPassStatus, formatPassTimeRemaining, type PassStatus } from '@/lib/wallet/pass';

// Window size comes from useWindowDimensions inside the component. It used to
// be read once here at module load, so resizing a browser window, rotating a
// tablet or unfolding a foldable never re-laid the reader out — and on a wide
// desktop window every page was drawn at the full window width.
//
// Page heights: a manga page is ~1.5 tall per unit of width, but manhwa strips
// run 3–20, so each page is laid out at its own ratio once known — from the
// source (atsu states sizes), from an earlier visit (lib/chapter-pages
// remembers measured sizes), or measured as it loads — and until then at the
// chapter's median (components/reader/reader-layout).

const BACKGROUNDS: Record<ReaderPrefs['background'], string> = {
  black: '#000000',
  gray: '#26262B',
  white: '#FFFFFF',
};
/** Ignore a "tap" that moved this far: it was a swipe. */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 350;
/** After a touch, wheel or key, auto-scroll waits this long before going on. */
const AUTO_SCROLL_RESUME_MS = 1500;
/** A restore (resume, seek, mode switch) stops re-landing after this long. */
const RESTORE_MAX_MS = 6000;

/** Web: F toggles fullscreen on the whole document (the reader is full-window). */
function toggleFullscreen() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
      else doc.webkitExitFullscreen?.();
    } else if (root.requestFullscreen) {
      void root.requestFullscreen().catch(() => undefined);
    } else {
      root.webkitRequestFullscreen?.();
    }
  } catch {
    // Fullscreen refused (iframe without allowfullscreen, iOS Safari): ignore.
  }
}

/** The browser's own data-saver signal, on top of the app's Data saver switch. */
function browserSaveData(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}
/** Window for the reader's double tap. Long enough to be unhurried, short
 *  enough that two unrelated taps a beat apart don't count as one gesture. */
const DOUBLE_TAP_MS = 300;
/** Idle time before the reader's overlay fades itself out. Measured from the
 *  last interaction, never from when it appeared, so reaching for the back
 *  button keeps it alive. Short enough to stay out of the way; survivable only
 *  because the timer restarts on every touch and a touch during the fade
 *  cancels it outright. */
const AUTO_HIDE_MS = 2000;
const UI_FADE_MS = 200;
/** How long after a jump reading-credit stays suppressed. Wide enough to outlive
 *  the webtoon settle path (a 350ms retry plus viewability's minimum view). */
const SEEK_GUARD_MS = 900;
/** Scroll distance that counts as "reading resumed" rather than finger drift. */
const SCROLL_HIDE_PX = 12;
/**
 * How far through a chapter (by page) the next chapter's page list is
 * prefetched when continuous reading is off. Matches the point at which
 * continuous reading attaches a network chapter (onViewableItemsChanged).
 */
const NEXT_CHAPTER_PREFETCH_AT = 0.6;

/**
 * The downloaded copy of a chapter, or null — never the network. For the two
 * decisions that must not wait on (or be fooled by) a request: whether a
 * gated chapter needs a pass check, and what a failed Retry falls back to.
 */
async function downloadedPages(
  contentId: string,
  chapterId: string,
  source: string | undefined,
): Promise<string[] | null> {
  const adapter = getScrapedAdapter(source);
  const uris = adapter
    ? await getScrapedOfflinePageUris(adapter.key, contentId, chapterId).catch(() => null)
    : await getOfflineMangaPageUris(contentId, chapterId).catch(() => null);
  return uris?.length ? uris : null;
}

const BackIcon = () => (
  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke={Colors.white} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const GateLockIcon = () => (
  <Svg width={34} height={34} viewBox="0 0 24 24" fill="none">
    <Path
      d="M6 10V8a6 6 0 1 1 12 0v2M5 10h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"
      stroke="#7B79E8"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export default function ChapterReader() {
  const { id, p, title, cover, chapter, offline, source, gated } = useLocalSearchParams<{
    id: string;
    p?: string;
    title?: string;
    cover?: string;
    chapter?: string;
    offline?: string;
    source?: string;
    gated?: string;
  }>();
  // Droplet-scraped sources: no atsu offline store, no pass-gating.
  const adapter = getScrapedAdapter(source);
  const isExternal = adapter !== null;
  // Separate from isExternal: suppresses the surfaces an adult read must leave
  // untouched — reading progress, history and lock-screen activity. Manhwa is
  // scraped but SFW, so it belongs in all of them.
  const isAdult = adapter?.adult === true;
  const isGated = gated === '1' && !isExternal;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { address } = useWallet();
  const { width: winW, height: winH } = useWindowDimensions();

  // Display preferences. The snapshot is synchronous once read this session,
  // so the first layout already has the right width; until the first read
  // completes the page list waits (it is a localStorage / file read).
  const [prefs, setPrefs] = useState<ReaderPrefs>(getReaderPrefsSnapshot);
  const [prefsReady, setPrefsReady] = useState(readerPrefsLoaded);
  useEffect(() => {
    let alive = true;
    void loadReaderPrefs().then((loaded) => {
      if (!alive) return;
      setPrefs(loaded);
      setPrefsReady(true);
    });
    const unsubscribe = subscribeReaderPrefs((next) => {
      if (alive) setPrefs(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const changePrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    void updateReaderPrefs(patch);
  }, []);

  // Settings → Data saver (it used to be a switch nothing read), or the
  // browser's own Save-Data. Cuts look-ahead to one page and skips warming
  // the next chapter's images.
  const [dataSaver, setDataSaver] = useState(browserSaveData);
  useEffect(() => {
    let alive = true;
    AppSettings.getDataSaver()
      .then((on) => {
        if (alive) setDataSaver(on || browserSaveData());
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // expo-router keeps this screen mounted under whatever is pushed on top
  // (the pass screen, a chat), so document-level listeners and the wake lock
  // must stand down while it is not the screen in front.
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  // For callbacks held in refs or created before these are known.
  const dataSaverRef = useRef(dataSaver);
  dataSaverRef.current = dataSaver;
  const winWRef = useRef(winW);
  winWRef.current = winW;

  const [accessChecked, setAccessChecked] = useState(!isGated);
  const [hasAccess, setHasAccess] = useState(!isGated);
  const [passExpiry, setPassExpiry] = useState<Date | null>(null);
  const flatListRef = useRef<FlatList<ReaderRow>>(null);
  const didInitialScroll = useRef(false);
  // One entry per chapter resident in this session, always in reading order.
  const [segments, setSegments] = useState<ChapterSegment[]>([]);
  // The series' full chapter list, normalised. Empty means continuous reading
  // is simply off and the reader behaves exactly as it always did.
  const [orderedChapters, setOrderedChapters] = useState<MangaChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageLoadError, setPageLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  /* The overlay starts HIDDEN and is only ever summoned by a double tap.
     A reader opens a chapter to read it, not to look at chrome, and anything
     that appears on entry has to be waited out over the first page. */
  /** Drives pointerEvents, and deliberately lags the fade — see hideUI. */
  const [uiInteractive, setUiInteractive] = useState(false);
  /** The truth about visibility, for timers and callbacks that can't see state. */
  const uiVisibleRef = useRef(false);
  /** Same fact as uiVisibleRef, in state, because web's fade is a rendered
   *  opacity rather than an animated one. Flips immediately on show/hide —
   *  unlike uiInteractive, which deliberately lags the fade-out. */
  const [uiShown, setUiShown] = useState(false);
  // Which chapter the reader is looking at right now — not necessarily the one
  // the route was opened on, once reading has crossed a boundary.
  const [activeChapterId, setActiveChapterId] = useState('');
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [visiblePageIds, setVisiblePageIds] = useState<Set<string>>(() => new Set());
  const [readingMode, setReadingMode] = useState<'page' | 'scroll'>('scroll');
  const [readDirection, setReadDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [continuous, setContinuous] = useState(true);
  const [continuousBack, setContinuousBack] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // What is known about each page's image, by row id: its ratio (height/width)
  // and natural width. Seeded from the source's stated sizes and from sizes
  // remembered on an earlier visit, then filled in as each image loads.
  const [pageSizes, setPageSizes] = useState<Record<string, PageSize>>({});
  /**
   * The chapter whose end card is on screen (the last one in the session), or
   * null. A chapter id rather than a flag: when continuous reading appends the
   * next chapter the card moves away without a scroll event, and a bare
   * "at the end" left over from before would then credit the chapter that was
   * just appended as read. Mirrored in a ref for callbacks.
   */
  const [endReachedFor, setEndReachedFor] = useState<string | null>(null);
  const atEndRef = useRef(false);

  /**
   * Overlay fade, on React Native's own Animated rather than Reanimated.
   *
   * A cross-fade of one value does not need the UI thread, so this uses RN's
   * Animated rather than Reanimated — which also removes the file's only
   * Reanimated dependency, and sidesteps Reanimated's rule that one animated
   * style may not drive two components (the two overlays fade together).
   */
  const uiOpacity = useRef(new Animated.Value(0)).current;
  const uiFadeRef = useRef<Animated.CompositeAnimation | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** >0 means something is holding the overlay open. A COUNTER, not a boolean:
   *  a slider drag and the settings modal can overlap. */
  const uiHoldRef = useRef(0);
  /** The bottom overlay's DOM node on web, so a double click aimed at its
   *  controls isn't also read as "dismiss the overlay". */
  const overlayHostRef = useRef<{ contains(n: Node): boolean } | null>(null);
  /** Lets onScroll, declared far above hideUI, dismiss the overlay without a
   *  use-before-declaration dependency. Assigned in the auto-hide block. */
  const hideUIRef = useRef<() => void>(() => {});
  /** A drag the USER started, as opposed to any programmatic scroll. */
  const userDragRef = useRef(false);
  const dragStartOffsetRef = useRef(0);
  /** Set for a beat around any slider seek or chapter-button press, so a jump
   *  can't be mistaken for having read the pages it skipped. */
  const seekingRef = useRef(false);
  const seekGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Measured sizes per chapter, index-aligned, waiting to be remembered. */
  const measuredRef = useRef<Map<string, Array<PageSizeHint | null>>>(new Map());
  const rememberTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushMeasured = useCallback(() => {
    if (rememberTimerRef.current) {
      clearTimeout(rememberTimerRef.current);
      rememberTimerRef.current = null;
    }
    const contentId = mangaIdRef.current;
    if (!contentId) return;
    for (const [chapterId, sizes] of measuredRef.current) {
      rememberPageSizes(sourceRef.current, contentId, chapterId, sizes);
    }
    measuredRef.current.clear();
  }, []);

  const handlePageLoad = useCallback((page: { id: string; chapterId: string; pageIndex: number }, width?: number, height?: number) => {
    if (!width || !height) return;
    const ratio = height / width;
    if (!isUsableRatio(ratio)) return;
    setPageSizes((prev) => {
      const existing = prev[page.id];
      // Only re-render when the size meaningfully changes.
      if (existing && Math.abs(existing.ratio - ratio) < 0.01 && existing.width === width) return prev;
      return { ...prev, [page.id]: { ratio, width } };
    });
    // Remember it for the next open of this chapter (see rememberPageSizes).
    const list = measuredRef.current.get(page.chapterId) ?? [];
    list[page.pageIndex] = { width, height };
    measuredRef.current.set(page.chapterId, list);
    if (!rememberTimerRef.current) rememberTimerRef.current = setTimeout(flushMeasured, 2000);
  }, [flushMeasured]);

  /**
   * Lay pages out at their known sizes before any image loads: the source's
   * stated sizes first (atsu), then sizes remembered from an earlier visit.
   * Measured sizes already in state win over both.
   */
  const seedPageSizes = useCallback(
    (chapterId: string, count: number, ...lists: Array<ReadonlyArray<PageSizeHint | null> | null | undefined>) => {
      const seed: Record<string, PageSize> = {};
      for (let i = 0; i < count; i += 1) {
        for (const list of lists) {
          const hint = list?.[i];
          if (hint && hint.width > 0 && hint.height > 0) {
            seed[`${chapterId}#${i}`] = { ratio: hint.height / hint.width, width: hint.width };
            break;
          }
        }
      }
      if (Object.keys(seed).length > 0) setPageSizes((prev) => ({ ...seed, ...prev }));
    },
    [],
  );

  const tildeIdx = (id || '').indexOf('~');
  const mangaId = tildeIdx >= 0 ? id!.slice(0, tildeIdx) : '';
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // The chapter the route opened on. Deliberately never reassigned: it is a
  // dependency of the load effect, so making it follow the reader would re-fire
  // that effect at every boundary and wipe the session back to one chapter.
  const entryChapterId = tildeIdx >= 0 ? id!.slice(tildeIdx + 1) : '';
  const parsedRequested = Number(p);
  const requestedPage = Number.isFinite(parsedRequested) && parsedRequested > 0 ? parsedRequested : 1;
  // Declared here rather than beside the other display strings because the page
  // load effect lists it as a dependency, and a dependency array is evaluated
  // during render — a later `const` would be in its temporal dead zone.
  const routeChapterLabel =
    typeof chapter === 'string' && chapter
      ? chapter
      : entryChapterId
        ? `Chapter ${entryChapterId}`
        : 'Chapter';

  useEffect(() => {
    AppSettings.getMangaReadingMode()
      .then((mode) => setReadingMode(mode === 'page' ? 'page' : 'scroll'))
      .catch(() => setReadingMode('scroll'));
    AppSettings.getReadDirection()
      .then((direction) => setReadDirection(direction === 'rtl' ? 'rtl' : 'ltr'))
      .catch(() => setReadDirection('ltr'));
    AppSettings.getReaderContinuous()
      .then(setContinuous)
      .catch(() => setContinuous(true));
    AppSettings.getReaderContinuousBack()
      .then(setContinuousBack)
      .catch(() => setContinuousBack(true));
  }, []);

  // Read from the neighbour loaders, which are ref-held and can't see state.
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const continuousBackRef = useRef(continuousBack);
  // Backward flow additionally requires forward flow to be on: "continuous
  // reading off" should mean off in both directions.
  continuousBackRef.current = continuous && continuousBack;

  const isRtlPageMode = readingMode === 'page' && readDirection === 'rtl';

  // Rows are ALWAYS in reading order; right-to-left is a visual mirror applied
  // at render time (see the scaleX transforms below). The list used to reverse
  // the array instead, which cannot survive a second chapter: it would reverse
  // the whole book rather than each chapter, and it would swap the meaning of
  // append and prepend so "next chapter" became the index-shifting path.
  const rows = useMemo(
    // Dividers only in webtoon mode — getItemLayout in paged mode assumes every
    // row is exactly one screen wide, and a shorter row desynchronises it.
    () => flattenSegments(segments, readingMode === 'scroll'),
    [segments, readingMode],
  );
  const bounds = useMemo(() => segmentBounds(rows), [rows]);
  const activeSegment = useMemo(
    () => findSegment(segments, activeChapterId) ?? segments[0],
    [segments, activeChapterId],
  );
  const activeTotalPages = activeSegment?.pages.length ?? 0;
  // Whether an earlier chapter exists that backward flow could pull in. Drives
  // the header spacer; no spacer at the true start of a series.
  const hasPrevChapter =
    continuous &&
    continuousBack &&
    segments.length > 0 &&
    Math.min(...segments.map((s) => s.orderIndex)) > 0;

  const [askOpen, setAskOpen] = useState(false);
  /** Per-session, deliberately not persisted: "show me spoilers" is a decision
   *  about one conversation, and defaulting it back to safe every time the
   *  reader opens is the failure worth having. */
  const [allowSpoilers, setAllowSpoilers] = useState(false);

  const mangaTitle = typeof title === 'string' ? title : 'Manga';
  // Progress keeps the stored title when the route has none (a notification
  // or a shared link opens the reader without one) instead of renaming the
  // series "Manga" in Continue Reading.
  const progressTitle = typeof title === 'string' ? title : '';
  const mangaCover = typeof cover === 'string' ? cover : undefined;
  // Label of the chapter actually on screen. Falls back to the route's label,
  // which is only correct while the reader is still on the chapter it opened.
  // Declared up here because effects below list it as a dependency, and
  // dependency arrays are evaluated during render.
  const chapterLabel = activeSegment?.chapterLabel ?? routeChapterLabel;

  // Assigned during render so the useRef-held viewability callback — which
  // cannot close over state — always reads current values.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Pass gating — verify entitlement before loading the latest chapters.
  useEffect(() => {
    if (!isGated) {
      setHasAccess(true);
      setAccessChecked(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPageLoadError(null);
    setAccessChecked(false);
    (async () => {
      // A chapter already on this device opens without the check. Getting it
      // here required access (the manga page hides Download on locked rows
      // without a pass), and checkPassStatus needs the network — so a
      // downloaded gated chapter used to be locked exactly when it was most
      // needed, offline. The manga page and Downloads apply the same rule
      // before navigating; this covers every other way in.
      if (await downloadedPages(mangaId, entryChapterId, source)) {
        if (!cancelled) {
          setHasAccess(true);
          setAccessChecked(true);
        }
        return;
      }
      if (!address) {
        if (!cancelled) {
          setHasAccess(false);
          setAccessChecked(true);
        }
        return;
      }
      const status = await checkPassStatus(address).catch((): PassStatus => ({ valid: false }));
      if (cancelled) return;
      setHasAccess(status.valid);
      if (status.valid && status.expiresAt) setPassExpiry(status.expiresAt);
      setAccessChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [isGated, address, mangaId, entryChapterId, source]);

  // Re-check when returning from the pass purchase screen.
  useFocusEffect(
    useCallback(() => {
      if (!isGated || hasAccess || !address) return;
      checkPassStatus(address)
        .then((status) => {
          if (status.valid) {
            setHasAccess(true);
            if (status.expiresAt) setPassExpiry(status.expiresAt);
          }
        })
        .catch(() => {});
    }, [isGated, hasAccess, address]),
  );

  useEffect(() => {
    if (!mangaId || !entryChapterId) {
      setLoading(false);
      return;
    }
    if (isGated && !hasAccess) {
      // Don't fetch gated pages until the pass is verified.
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      // Read alongside the page list (a local read), so the first layout
      // already has every page's height and the resume lands exactly.
      const rememberedSizes = getRememberedPageSizes(source, mangaId, entryChapterId).catch(() => null);
      try {
        // Offline is resolved per chapter inside loadChapterPages by asking the
        // store, so the route's `offline` param is no longer consulted here.
        // That also means a chapter opened from Continue Reading — which never
        // passes the param — now reads from disk instead of refetching.
        //
        // Retry goes to the network on purpose: it is how a damaged download
        // gets replaced. But with no network that only threw the downloaded
        // copy away and turned "Retry" into a guaranteed failure, so offline
        // the copy stays preferred — and when a deliberate network retry
        // fails, the copy still beats an error.
        const preferOffline = loadAttempt === 0 || !isOnline();
        let loaded: LoadedChapterPages;
        try {
          loaded = await loadChapterPages({
            contentId: mangaId,
            chapterId: entryChapterId,
            source,
            preferOffline,
          });
        } catch (error) {
          const local = preferOffline ? null : await downloadedPages(mangaId, entryChapterId, source);
          if (!local) throw error;
          loaded = { urls: local, origin: 'offline' };
        }
        if (!preferOffline && loaded.urls.length === 0) {
          const local = await downloadedPages(mangaId, entryChapterId, source);
          if (local) loaded = { urls: local, origin: 'offline' };
        }
        const { urls, origin } = loaded;
        const remembered = await rememberedSizes;
        if (cancelled) return;
        seedPageSizes(entryChapterId, urls.length, loaded.sizes, remembered);
        // Opening a chapter always resets the session to just that chapter;
        // neighbours are attached afterwards as the reader approaches them.
        setSegments([
          buildSegment({
            chapterId: entryChapterId,
            // Placeholders: the route carries an opaque chapter id, so the real
            // number and position aren't known until the chapter list resolves.
            // The reconcile effect below fills them in. Nothing may infer a
            // neighbour from orderIndex before then.
            chapterNumber: Number(entryChapterId) || 0,
            chapterLabel: routeChapterLabel,
            orderIndex: 0,
            origin,
            urls,
          }),
        ]);
        setActiveChapterId(entryChapterId);
      } catch (error) {
        if (!cancelled) {
          setSegments([]);
          setPageLoadError(error instanceof Error ? error.message : 'The chapter source is unavailable.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mangaId, entryChapterId, source, routeChapterLabel, isGated, hasAccess, loadAttempt, seedPageSizes]);

  /**
   * Web gets its fade from a CSS transition on a state-driven opacity.
   *
   * A plain opacity plus `transition` is what a browser is good at, and it means
   * the committed style reaches its final value immediately rather than being
   * interpolated frame by frame — so the overlay still ends up in the right
   * state on a page that is throttled or not compositing. Native keeps the
   * Animated value.
   *
   * The two are mutually exclusive rather than layered: an Animated.Value and a
   * CSS opacity in the same style array leaves the animated node writing the
   * element's opacity on web regardless of array order, which cancels out the
   * transition.
   */
  const overlayFadeStyle = useMemo(
    () =>
      Platform.OS === 'web'
        ? ({
            opacity: uiShown ? 1 : 0,
            transitionProperty: 'opacity',
            transitionDuration: `${UI_FADE_MS}ms`,
          } as never)
        : ({ opacity: uiOpacity } as never),
    [uiShown, uiOpacity],
  );

  const fadeUiTo = useCallback(
    (to: 0 | 1) => {
      uiFadeRef.current?.stop();
      uiFadeRef.current = Animated.timing(uiOpacity, {
        toValue: to,
        duration: UI_FADE_MS,
        // Opacity is native-drivable. Not on web: the fade there is CSS
        // (overlayFadeStyle), and asking for the native driver only logged a
        // "native animated module is missing" warning the first time it faded.
        useNativeDriver: Platform.OS !== 'web',
      });
      uiFadeRef.current.start();
    },
    [uiOpacity],
  );

  useEffect(() => {
    if (loading || activeTotalPages === 0) return;
    // Adult reading is never surfaced in Continue Reading or lock-screen
    // activity (it would leak past the settings toggle and the reopen path has
    // no source). Scraped-but-SFW sources like manhwa are surfaced normally.
    if (isAdult) return;
    const pageNumber = activePageIndex + 1;
    const total = activeTotalPages;
    upsertReadingActivity(
      {
        title: 'Manga Reader',
        subtitle: chapterLabel,
        progressText: `${pageNumber}/${total}`,
        progressPercent: total > 0 ? pageNumber / total : 0,
        kind: 'manga',
      },
      // Deep-links back to the chapter being read, which may not be the one the
      // route was opened on.
      mangaId && activeChapterId
        ? `sakura://chapter/${mangaId}~${activeChapterId}?p=${pageNumber}` +
          (source ? `&source=${source}` : '')
        : undefined,
    );
  }, [
    activeChapterId,
    activePageIndex,
    activeTotalPages,
    chapterLabel,
    mangaId,
    loading,
    isAdult,
    source,
  ]);

  useEffect(() => {
    // Only when the route itself changes — never when a neighbouring chapter
    // joins the session, which would re-run the initial jump mid-read.
    didInitialScroll.current = false;
  }, [mangaId, entryChapterId]);

  const snapRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (snapRestoreTimerRef.current) clearTimeout(snapRestoreTimerRef.current);
    },
    [],
  );
  /**
   * Whether the list is still given initialScrollIndex (see the FlatList).
   * react-native-web's VirtualizedList skips recomputing which rows to render
   * whenever initialScrollIndex is set and the scroll offset is exactly 0 —
   * it takes that as "the initial scroll has not happened yet". So after a
   * resume at page 30, Home (or the slider to page 1, or a chapter button
   * opening the next chapter at its top) scrolled to 0 and kept rendering
   * only pages 29–30: a black screen until the reader scrolled. A jump to
   * offset 0 therefore drops the prop first; by then it has done its job.
   */
  const [initialIndexLive, setInitialIndexLive] = useState(true);
  const initialIndexLiveRef = useRef(true);
  const releaseInitialIndex = useCallback(() => {
    if (!initialIndexLiveRef.current) return;
    initialIndexLiveRef.current = false;
    setInitialIndexLive(false);
  }, []);
  /** A row's offset and length along the scroll axis; assigned once the layout is known (below). */
  const rowSpanRef = useRef<(index: number) => { offset: number; length: number }>((index) => ({
    offset: index * winW,
    length: winW,
  }));

  /**
   * Scroll to a flattened row index. No RTL mapping — the list is mirrored.
   * `fraction` (webtoon only) lands that far into the row rather than at its
   * top, so a re-layout can put the reader back mid-page.
   */
  const jumpToRow = useCallback(
    (rowIndex: number, animated = false, fraction = 0) => {
      const total = rowsRef.current.length;
      if (total === 0) return;
      const index = Math.min(Math.max(rowIndex, 0), total - 1);
      const span = rowSpanRef.current(index);
      const target = readingMode === 'page' ? winW * index : span.offset + Math.max(0, fraction) * span.length;
      if (target < 1) releaseInitialIndex();
      if (readingMode === 'page') {
        // Uniform page width, so offset math is exact.
        const offset = winW * index;
        const node =
          Platform.OS === 'web'
            ? ((flatListRef.current as unknown as { getScrollableNode?: () => unknown } | null)?.getScrollableNode?.() as
                | HTMLElement
                | undefined)
            : undefined;
        if (node?.style && Math.abs(node.scrollLeft - offset) > winW * 1.5) {
          // A far jump on web (End, the slider, a resume): the list scrolls
          // with CSS `scroll-snap-type: x mandatory`, and the snap points are
          // only the pages actually rendered — the target is not, yet. The
          // browser snapped back to the nearest rendered page, so End from
          // page 1 landed on page 11. Snapping is suspended until the pages
          // around the target have rendered, then the landing is repeated.
          node.style.scrollSnapType = 'none';
          flatListRef.current?.scrollToOffset({ offset, animated: false });
          if (snapRestoreTimerRef.current) clearTimeout(snapRestoreTimerRef.current);
          snapRestoreTimerRef.current = setTimeout(() => {
            snapRestoreTimerRef.current = null;
            node.style.scrollSnapType = '';
            flatListRef.current?.scrollToOffset({ offset, animated: false });
          }, 300);
          return;
        }
        flatListRef.current?.scrollToOffset({ offset, animated });
      } else {
        // Webtoon rows have their own heights, but getItemLayout knows every
        // one of them (measured, stated by the source, remembered, or the
        // chapter's median), so this is a direct jump: rows in between never
        // mount, and nothing is downloaded on the way.
        if (fraction > 0) flatListRef.current?.scrollToOffset({ offset: target, animated });
        else flatListRef.current?.scrollToIndex({ index, animated });
      }
    },
    [readingMode, winW, releaseInitialIndex],
  );

  /**
   * Scroll to a page within a specific chapter.
   *
   * Anchoring on chapter + page rather than a flat index is what lets a restore
   * survive a neighbouring chapter being attached mid-flight; a raw index would
   * point somewhere else the moment the list grew.
   */
  const jumpToChapterPage = useCallback(
    (chapterId: string, pageIndex: number, animated = false): boolean => {
      const rowIndex = rowIndexFor(boundsRef.current, chapterId, pageIndex);
      if (rowIndex < 0) return false;
      jumpToRow(rowIndex, animated);
      setActiveChapterId(chapterId);
      setActivePageIndex(pageIndex);
      return true;
    },
    [jumpToRow],
  );

  const initialTarget = Math.min(Math.max(requestedPage - 1, 0), Math.max(activeTotalPages - 1, 0));
  /** The list's initialScrollIndex, fixed when the list first renders (see the FlatList). */
  const initialRowRef = useRef<number | null>(null);
  useEffect(() => {
    if (loading || rows.length === 0 || didInitialScroll.current) return;
    const target = initialTarget;
    requestAnimationFrame(() => {
      // Latch only on SUCCESS. The chapter buttons replace the route without
      // unmounting, so this effect fires once while the old chapter is still the
      // only resident one: rowIndexFor returns -1 for the new chapter, the jump
      // is a no-op, and latching anyway meant the new chapter was never scrolled
      // to at all — the list kept its native offset across the data swap, so
      // "next chapter" from page 30 of 40 opened the next one near its end.
      if (jumpToChapterPage(entryChapterId, target, false)) {
        didInitialScroll.current = true;
        // Webtoon rows not measured yet are laid out at an estimate. Hold the
        // landing on the target while the rows around it load and correct
        // their heights; the reader's first touch, wheel or key releases it.
        if (readingMode === 'scroll' && target > 0) {
          pendingRestoreRef.current = { chapterId: entryChapterId, page: target, tries: 0, startedAt: Date.now() };
        }
      }
    });
  }, [loading, initialTarget, rows.length, entryChapterId, jumpToChapterPage, readingMode]);

  // Load the series' chapter list so the reader knows what comes next. Falls
  // back to the offline manifest, which is what makes continuous reading work
  // in airplane mode — the whole point of "if you have them downloaded you
  // shouldn't even notice you're in the next chapter".
  useEffect(() => {
    if (!mangaId || !entryChapterId) return;
    let cancelled = false;
    fetchReaderChapterList(source, mangaId, entryChapterId)
      .then((list) => {
        if (!cancelled) setOrderedChapters(list);
      })
      .catch(() => {
        // No list means no continuity; the single-chapter reader still works.
        if (!cancelled) setOrderedChapters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mangaId, entryChapterId, source]);

  const orderedChaptersRef = useRef(orderedChapters);
  orderedChaptersRef.current = orderedChapters;

  const residentKey = segments.map((segment) => segment.chapterId).join('|');
  // Place the resident segments within the series once the list arrives.
  //
  // The entry segment is built as soon as its pages load, which is before the
  // chapter list resolves, so its orderIndex starts as a placeholder. Anything
  // that reasons about position — segment sorting, eviction, and whether an
  // earlier chapter exists — needs the real index, not the placeholder. Also
  // adopts the list's real chapter number and title, since the route only
  // carries an opaque id.
  useEffect(() => {
    if (orderedChapters.length === 0) return;
    setSegments((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next = prev.map((segment) => {
        const at = orderedChapters.findIndex((c) => c.id === segment.chapterId);
        if (at < 0) return segment;
        const chapter = orderedChapters[at];
        // A route without a `chapter` param (a notification, a shared link,
        // Continue from an older build) labels the chapter by its opaque id,
        // "Chapter PwTgD1Gh"; the list's number reads better, and that label
        // is what progress and Continue Reading store.
        const placeholder = segment.chapterLabel === `Chapter ${segment.chapterId}`;
        const label =
          chapter.title || (placeholder && Number.isFinite(chapter.number) ? `Chapter ${chapter.number}` : segment.chapterLabel);
        if (at === segment.orderIndex && label === segment.chapterLabel && Object.is(chapter.number, segment.chapterNumber)) {
          return segment;
        }
        changed = true;
        return {
          ...segment,
          orderIndex: at,
          chapterNumber: chapter.number,
          chapterLabel: label,
        };
      });
      return changed ? next.sort((a, b) => a.orderIndex - b.orderIndex) : prev;
    });
    // Also when the resident chapters change, not only the list: with the
    // chapter list served from cache and the page list from the network, the
    // list now often arrives FIRST, and the entry chapter kept its
    // placeholder position and label for the whole session.
  }, [orderedChapters, residentKey]);
  /** Chapters currently being fetched, so proximity and onEndReached don't race. */
  const loadingNeighborRef = useRef<Set<string>>(new Set());

  /**
   * Attach the next chapter to the end of the session.
   *
   * Append only, for now: adding to the end leaves every existing row index
   * untouched, whereas prepending shifts them all and needs scroll
   * compensation. Reading forward is also the overwhelmingly common direction.
   */
  const ensureNextChapter = useCallback(async () => {
    const list = orderedChaptersRef.current;
    if (list.length === 0) return;
    const resident = segmentsRef.current;
    if (resident.length === 0) return;

    if (!continuousRef.current) return;
    // Resolve position by chapter id, never by the stored orderIndex. The entry
    // segment is created before the chapter list has loaded, so its index is a
    // placeholder until reconciled — trusting it appended the series' second
    // chapter after whatever you actually opened.
    const positions = resident
      .map((s) => list.findIndex((c) => c.id === s.chapterId))
      .filter((i) => i >= 0);
    if (positions.length === 0) return; // this chapter isn't in the list; don't guess
    const lastOrderIndex = Math.max(...positions);
    const next = list[lastOrderIndex + 1];
    if (!next) return; // end of the series
    if (resident.some((s) => s.chapterId === next.id)) return;
    if (loadingNeighborRef.current.has(next.id)) return;
    loadingNeighborRef.current.add(next.id);

    try {
      const [{ urls, origin, sizes }, remembered] = await Promise.all([
        loadChapterPages({ contentId: mangaId, chapterId: next.id, source }),
        getRememberedPageSizes(source, mangaId, next.id).catch(() => null),
      ]);
      if (urls.length === 0) return;
      // Warm the first few images so the boundary doesn't arrive as blank
      // space. Not under data saver: look-ahead reaches them one page early.
      if (!dataSaverRef.current && origin === 'network') {
        urls.slice(0, 3).forEach((u) => warmReaderImage(u));
      }
      seedPageSizes(next.id, urls.length, sizes, remembered);
      setSegments((prev) => {
        if (prev.some((s) => s.chapterId === next.id)) return prev;
        return [
          ...prev,
          buildSegment({
            chapterId: next.id,
            chapterNumber: next.number,
            chapterLabel: next.title || `Chapter ${next.number}`,
            orderIndex: lastOrderIndex + 1,
            origin,
            urls,
          }),
        ];
      });
    } catch {
      // Leave the boundary as a hard stop; the reader still works.
    } finally {
      loadingNeighborRef.current.delete(next.id);
    }
  }, [mangaId, source, seedPageSizes]);

  const ensureNextRef = useRef(ensureNextChapter);
  ensureNextRef.current = ensureNextChapter;

  // ── Backward continuity ────────────────────────────────────────────────
  //
  // Prepending is the dangerous direction. Appending leaves every existing row
  // index alone; inserting at the front shifts all of them, and the list will
  // happily keep its scroll offset — which now points at completely different
  // content. The mitigations, in order of how much work they do:
  //
  //   1. Only ever prepend while the reader is at rest. This is the big one. It
  //      converts the worst failure (a jump under a moving thumb) into the mild
  //      one (the previous chapter isn't ready the instant you reach the top),
  //      which is just today's behaviour.
  //   2. maintainVisibleContentPosition — reliable on iOS, best-effort on Android.
  //   3. An explicit compensating scroll for Android, run after layout settles.
  //   4. A header spacer, so the top is never at true offset 0 and the insert
  //      never fights an overscroll bounce.
  /** How close to the top counts as "about to need the previous chapter". */
  const NEAR_TOP_PX = 400;
  const scrollOffsetRef = useRef(0);
  const isScrollingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrependRef = useRef(false);
  /** True between a prepend and its compensating scroll landing. */
  const anchorPendingRef = useRef(false);
  const firstVisibleIdRef = useRef<string | null>(null);

  const settleScroll = useCallback(() => {
    isScrollingRef.current = false;
    userDragRef.current = false;
    if (pendingPrependRef.current) {
      pendingPrependRef.current = false;
      void ensurePrevRef.current();
    }
  }, []);

  /** The list's viewport and content length along its scroll axis. */
  const listMetricsRef = useRef({ view: 0, content: 0 });
  /**
   * Is the end card (the list footer) at least half on screen? That is the
   * one reliable "read to the end" signal: a short last page is never the top
   * visible row, so page numbers alone can miss it. Run on scroll, and on
   * layout and content changes for a chapter short enough not to scroll.
   */
  const updateEndReached = useCallback(() => {
    const { view, content } = listMetricsRef.current;
    const footerLen = readingMode === 'page' ? view : END_CARD_HEIGHT;
    const nowAtEnd = content > 0 && view > 0 && scrollOffsetRef.current + view >= content - footerLen / 2;
    const last = segmentsRef.current[segmentsRef.current.length - 1]?.chapterId ?? null;
    atEndRef.current = nowAtEnd;
    setEndReachedFor((prev) => {
      const next = nowAtEnd ? last : null;
      return prev === next ? prev : next;
    });
  }, [readingMode]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const paged = readingMode === 'page';
      scrollOffsetRef.current = paged ? contentOffset.x : contentOffset.y;
      isScrollingRef.current = true;
      if (contentSize && layoutMeasurement) {
        listMetricsRef.current = {
          view: paged ? layoutMeasurement.width : layoutMeasurement.height,
          content: paged ? contentSize.width : contentSize.height,
        };
        updateEndReached();
      }
      // Reading has genuinely resumed — dismiss the overlay. Gated on BOTH a
      // real user drag and a real distance: onScroll fires for every
      // programmatic scroll too (the seek itself, the initial restore, prepend
      // compensation, every runPendingRestore retry), and an 8px finger drift
      // inside a tap must not dismiss a bar that was just revealed.
      if (
        userDragRef.current &&
        uiVisibleRef.current &&
        Math.abs(scrollOffsetRef.current - dragStartOffsetRef.current) > SCROLL_HIDE_PX
      ) {
        // Through a ref, not a dependency: hideUI is declared far below and
        // naming it here would be a use-before-declaration error.
        hideUIRef.current();
      }
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      // Momentum events don't fire for a slow drag that simply stops, so treat
      // a short gap with no scroll events as "at rest" too.
      idleTimerRef.current = setTimeout(settleScroll, 120);
    },
    [readingMode, settleScroll, updateEndReached],
  );

  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (pointerOffTimerRef.current) clearTimeout(pointerOffTimerRef.current);
      if (seekGuardRef.current) clearTimeout(seekGuardRef.current);
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    },
    [],
  );

  const ensurePrevChapter = useCallback(async () => {
    if (!continuousBackRef.current) return;
    const list = orderedChaptersRef.current;
    const resident = segmentsRef.current;
    if (list.length === 0 || resident.length === 0) return;

    // By id, for the same reason as ensureNextChapter above.
    const positions = resident
      .map((s) => list.findIndex((c) => c.id === s.chapterId))
      .filter((i) => i >= 0);
    if (positions.length === 0) return;
    const firstOrderIndex = Math.min(...positions);
    const prev = list[firstOrderIndex - 1];
    if (!prev) return; // start of the series
    if (resident.some((s) => s.chapterId === prev.id)) return;
    if (loadingNeighborRef.current.has(prev.id)) return;
    loadingNeighborRef.current.add(prev.id);

    try {
      const [{ urls, origin, sizes }, remembered] = await Promise.all([
        loadChapterPages({ contentId: mangaId, chapterId: prev.id, source }),
        getRememberedPageSizes(source, mangaId, prev.id).catch(() => null),
      ]);
      if (urls.length === 0) return;

      // Re-check at insert time, not just at request time: the fetch may have
      // taken long enough for the reader to start moving again.
      if (isScrollingRef.current) {
        pendingPrependRef.current = true;
        return;
      }

      const anchorId = firstVisibleIdRef.current;
      const offsetBefore = scrollOffsetRef.current;
      const insertedRows = urls.length + (readingMode === 'scroll' ? 1 : 0); // +1 divider

      anchorPendingRef.current = true;
      seedPageSizes(prev.id, urls.length, sizes, remembered);
      setSegments((prevSegments) => {
        if (prevSegments.some((s) => s.chapterId === prev.id)) return prevSegments;
        return [
          buildSegment({
            chapterId: prev.id,
            chapterNumber: prev.number,
            chapterLabel: prev.title || `Chapter ${prev.number}`,
            orderIndex: firstOrderIndex - 1,
            origin,
            urls,
          }),
          ...prevSegments,
        ];
      });

      // Compensate after the new rows have actually been laid out.
      requestAnimationFrame(() => {
        InteractionManager.runAfterInteractions(() => {
          try {
            if (readingMode === 'page') {
              // Uniform width, so the correction is exact.
              flatListRef.current?.scrollToOffset({
                offset: offsetBefore + insertedRows * winWRef.current,
                animated: false,
              });
            } else if (Platform.OS !== 'ios' && anchorId) {
              // Variable heights: re-anchor on the row that was on screen.
              //
              // Everywhere except iOS, which is the only platform where
              // maintainVisibleContentPosition actually holds the position —
              // it is unreliable on Android and is a no-op on web, where it is
              // not implemented at all. Gating this to Android left web with no
              // compensation whatsoever, so a prepend simply yanked the page
              // upward mid-read.
              //
              // Landing the anchor at the top of the viewport is a bounded
              // correction, not an exact one: it can shift by however far that
              // row had already been scrolled past.
              const index = rowsRef.current.findIndex((r) => r.id === anchorId);
              if (index >= 0) {
                flatListRef.current?.scrollToIndex({
                  index,
                  animated: false,
                  viewPosition: 0,
                });
              }
            }
          } catch {
            // Leave the position as-is rather than throwing mid-scroll.
          } finally {
            anchorPendingRef.current = false;
          }
        });
      });
    } catch {
      // Leave the top as a hard stop.
    } finally {
      loadingNeighborRef.current.delete(prev.id);
    }
  }, [mangaId, source, readingMode, seedPageSizes]);

  const ensurePrevRef = useRef(ensurePrevChapter);
  ensurePrevRef.current = ensurePrevChapter;

  // ── Eviction ───────────────────────────────────────────────────────────
  //
  // The arrays themselves are cheap — a segment is URL strings plus a float per
  // page — so this is a backstop, not the main memory lever. What actually
  // bounds memory is mounted images, handled by removeClippedSubviews plus a
  // smaller windowSize in webtoon mode, with expo-image's own cache under that.
  //
  // Only runs when it cannot be felt: the reader must be at rest and settled on
  // one chapter for a moment. pruneSegments drops from the far end in
  // preference to the front, because removing a leading segment shifts every
  // row index exactly as a prepend does.
  useEffect(() => {
    if (segments.length <= MAX_RESIDENT_SEGMENTS || !activeChapterId) return;
    const timer = setTimeout(() => {
      if (isScrollingRef.current || anchorPendingRef.current) return;
      setSegments((prev) => {
        const { kept, droppedFromFront } = pruneSegments(
          prev,
          activeChapterId,
          MAX_RESIDENT_SEGMENTS,
        );
        // A front drop would need the same compensation as a prepend. Rather
        // than risk a jump for a few kilobytes, skip it and try again later —
        // by then the reader has usually moved on and the far end is droppable.
        if (droppedFromFront > 0) return prev;
        return kept.length === prev.length ? prev : kept;
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [segments.length, activeChapterId]);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    // Reads refs only: this callback is held in a useRef and can never see
    // fresh state through a closure.
    const visibleIds = new Set<string>();
    for (const item of viewableItems) {
      const visibleRow = item.index == null ? undefined : rowsRef.current[item.index];
      if (visibleRow?.kind === 'page') visibleIds.add(visibleRow.id);
    }
    setVisiblePageIds((previous) => previous.size === visibleIds.size
      && [...visibleIds].every((pageId) => previous.has(pageId)) ? previous : visibleIds);
    const first = viewableItems.find((v) => v.index != null);
    const index = Number(first?.index ?? -1);
    if (index < 0) return;
    const row = rowsRef.current[index];
    if (!row) return;

    // The row to re-anchor on if a chapter gets prepended.
    firstVisibleIdRef.current = row.id;

    // While a compensating scroll is in flight the visible rows are transient;
    // reading them would reassign the active chapter to whatever the list
    // happened to be showing mid-correction.
    if (anchorPendingRef.current) return;

    setActiveChapterId(row.chapterId);
    // A divider is the top row only once the previous chapter's last page has
    // scrolled away, so it means "the start of this chapter". Setting page 0
    // here, rather than leaving the old chapter's index in place, keeps the
    // pair consistent: chapter 13 with chapter 12's page 29 read as "past the
    // end of 13", which would have marked 13 finished on arrival.
    setActivePageIndex(row.kind === 'page' ? row.pageIndex : 0);

    if (!continuousRef.current) return;

    // Start fetching the next chapter before the reader reaches the boundary,
    // so it is already in place by the time they scroll into it. An offline
    // chapter loads instantly, so it can wait until much later.
    const segment = segmentsRef.current.find((s) => s.chapterId === row.chapterId);
    if (segment && segment.pages.length > 0 && row.kind === 'page') {
      const through = (row.pageIndex + 1) / segment.pages.length;
      const threshold = segment.origin === 'offline' ? 0.85 : 0.6;
      if (through >= threshold) void ensureNextRef.current();
    }

    // Approaching the very top of the session: pull in the previous chapter.
    // ensurePrevChapter defers itself if the reader is still moving.
    //
    // Measured in pixels, not row index. A webtoon page is several screens
    // tall and the viewability threshold is deliberately low, so the topmost
    // row stays "viewable" long after it has been scrolled past — by row index
    // a reader can look near the top while genuinely deep in a chapter, which
    // fired this repeatedly mid-read and yanked the page upward.
    if (scrollOffsetRef.current <= NEAR_TOP_PX) void ensurePrevRef.current();
  }).current;

  // The threshold is a percentage OF THE ITEM, and it has to stay low because
  // webtoon pages are taller than the screen. A manhwa strip at its true aspect
  // ratio is several screens tall, so only ~20-40% of it is ever visible at
  // once — at the old value of 50 it could never become "viewable" at all.
  // onViewableItemsChanged then never fired, the current page stayed at 0, and
  // reads were reported at a few percent progress no matter how long someone
  // scrolled. That silently starved XP, quests and badges, which only award on
  // a read that reaches 90%.
  //
  // minimumViewTime stops a fast fling through the end of one chapter from
  // reporting the next one as "active" for a frame, which would reattribute
  // progress and gamification to a chapter that was never actually read.
  //
  // RN rejects changing this on the fly, so one config serves both modes.
  // Paged mode is unaffected: its pages are exactly one screen, so they clear
  // any threshold.
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 5,
    minimumViewTime: 80,
  }).current;



  // Page counts of chapters whose list was fetched ahead of opening them, so
  // an Up next row can say "Page 1 of 24" rather than guess.
  const [prefetchedPageCounts, setPrefetchedPageCounts] = useState<Record<string, number>>({});
  const lastSegmentId = segments.length > 0 ? segments[segments.length - 1].chapterId : '';
  /**
   * The chapter on screen has been read to its end: its last page is the top
   * row, or the end card is up. Paired with activeSegment so a chapter id
   * from one segment never meets a page index from another.
   */
  const activeFinished =
    activeTotalPages > 0 &&
    !!activeChapterId &&
    activeSegment?.chapterId === activeChapterId &&
    (activePageIndex === activeTotalPages - 1 || endReachedFor === activeChapterId);
  /** What follows the chapter on screen: a chapter, null at the newest, undefined while unknown. */
  const upNext = useMemo((): UpNextChapter | null | undefined => {
    if (orderedChapters.length === 0 || !activeChapterId) return undefined;
    const at = orderedChapters.findIndex((c) => c.id === activeChapterId);
    if (at < 0) return undefined;
    const next = orderedChapters[at + 1];
    if (!next) return null;
    const resident = segments.find((seg) => seg.chapterId === next.id);
    return {
      chapterId: next.id,
      chapterLabel: next.title || `Chapter ${next.number}`,
      chapterNumber: Number.isFinite(next.number) ? next.number : undefined,
      totalPages: resident?.pages.length || prefetchedPageCounts[next.id] || next.pageCount || undefined,
    };
  }, [orderedChapters, activeChapterId, segments, prefetchedPageCounts]);

  useEffect(() => {
    if (!mangaId || !activeChapterId || activeTotalPages === 0) return;
    // Adult reading progress is never persisted (keeps it out of Continue
    // Reading). Manhwa and comics are persisted like ordinary manga.
    if (isAdult) return;
    const page = activePageIndex + 1;
    // A glance at page 1 shouldn't overwrite real progress — but only while
    // still on the chapter the route opened. Once reading has crossed into a
    // new chapter, its page 1 is a genuine position and must be saved at once,
    // or backing out right after a boundary would resume at the old chapter.
    const stillOnEntryChapter = activeChapterId === entryChapterId;
    if (stillOnEntryChapter && page < 2 && activeTotalPages > 3 && !activeFinished) return;
    const t = setTimeout(() => {
      // A finished chapter is saved as its successor ("Up next") or as
      // caught up — never as 100%, which dropped the series from Continue
      // Reading and sent the title page back to "Start reading" from
      // chapter 0 (lib/reader-progress buildMangaProgressRecord).
      void setMangaReadProgress({
        mangaId,
        chapterId: activeChapterId,
        title: progressTitle,
        cover: mangaCover,
        chapterLabel,
        page,
        totalPages: activeTotalPages,
        source: typeof source === 'string' ? source : undefined,
        chapterNumber: activeSegment?.chapterNumber,
        finished: activeFinished,
        next: upNext,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [
    mangaId,
    activeChapterId,
    entryChapterId,
    activePageIndex,
    activeTotalPages,
    progressTitle,
    mangaCover,
    chapterLabel,
    activeSegment?.chapterNumber,
    isAdult,
    source,
    activeFinished,
    upNext,
  ]);

  // Snapshot of what the unmount handler should save, refreshed every render.
  //
  // This has to go through a ref. An unmount effect with an empty dep array
  // closes over the *first* render, where the page list is still empty — so the
  // previous version's `renderedPages.length > 0` was never true and the save
  // silently never ran. That is why backing out of a chapter lost your place.
  // The gamification unmount below already uses this pattern correctly.
  const progressRef = useRef<Parameters<typeof setMangaReadProgress>[0] | null>(null);
  const suppressProgressRef = useRef(false);
  useEffect(() => {
    suppressProgressRef.current = isAdult;
    progressRef.current =
      mangaId && activeChapterId && activeTotalPages > 0
        ? {
            mangaId,
            chapterId: activeChapterId,
            title: progressTitle,
            cover: mangaCover,
            chapterLabel,
            page: activePageIndex + 1,
            totalPages: activeTotalPages,
            source: typeof source === 'string' ? source : undefined,
            chapterNumber: activeSegment?.chapterNumber,
            finished: activeFinished,
            next: upNext,
          }
        : null;
  });

  useEffect(() => {
    return () => {
      clearReaderLookAhead();
      // Never persist 18+ progress or touch the shared reading-activity record
      // (clearing it here would wipe a legitimate manga/comic session).
      if (suppressProgressRef.current) return;
      flushMeasured();
      if (progressRef.current) void setMangaReadProgress(progressRef.current);
      endReadingActivity();
    };
  }, [flushMeasured]);

  // ── Reading gamification: one event per chapter actually read. ──
  //
  // Tracked per chapter rather than once for the whole session. Reading five
  // chapters in one sitting is now normal, and a single exit event would credit
  // the reader for one — losing four chapters of XP and streak progress.
  // Everything is ref-held so the unmount handler can see it.
  type ChapterStat = { startedAt: number; maxPage: number; total: number };
  /**
   * Per-chapter read marks (lib/chapter-read-state), for the series page's
   * read/unread state. Only a chapter read to its end is marked: reading
   * chapter 40 says nothing about 1–39, and a slider scrub to the last page is
   * a skip (callers check jumpSettling, as the XP credit does). Never for 18+:
   * that module ignores it anyway, but the rule is kept here too.
   */
  const readMarkedRef = useRef<Set<string>>(new Set());
  /**
   * A jump (slider, Home/End, a chapter button, Ask) is still landing: what
   * is on screen was arrived at, not read to. seekingRef alone covers only
   * its first SEEK_GUARD_MS, but a webtoon jump keeps re-landing (pending
   * restore, flagged `jump`) until the reader touches the list, and every
   * render in that time used to count the landing page as read — End, then
   * any image load a second later, marked the chapter read and credited it
   * as completed.
   */
  function jumpSettling(): boolean {
    return seekingRef.current || pendingRestoreRef.current?.jump === true;
  }
  /**
   * `chapterId#pageIndex` where the last jump came to rest. Being there does
   * not count toward the chapter; moving on from it (reading) does.
   */
  const jumpLandingRef = useRef<string | null>(null);
  function markFinishedRead(chapterId: string) {
    if (!chapterId || isAdultRef.current || !mangaIdRef.current) return;
    if (readMarkedRef.current.has(chapterId)) return;
    readMarkedRef.current.add(chapterId);
    void markChapterRead(sourceRef.current, mangaIdRef.current, chapterId).catch(() => {
      readMarkedRef.current.delete(chapterId);
    });
  }
  const chapterStatsRef = useRef<Map<string, ChapterStat>>(new Map());
  const emittedRef = useRef<Set<string>>(new Set());
  const isAdultRef = useRef(isAdult);
  isAdultRef.current = isAdult;
  const mangaIdRef = useRef(mangaId);
  mangaIdRef.current = mangaId;

  useEffect(() => {
    if (!activeChapterId || activeTotalPages === 0) return;
    // A slider jump or a chapter button sets activePageIndex directly. This
    // effect has NO dependency array, so it runs on the very next render and
    // would push maxPage straight to `total` — flushGamification then computes
    // progress = 1 and reports `completed`, a full XP and streak credit for a
    // two-second scrub. Guarding onEndReached alone does nothing, because
    // onEndReached is not the path this takes.
    //
    // Nor is the guard's first second enough: once it lapsed, the next render
    // (an image loading near the landing) counted the landing page anyway.
    // So the page a jump lands on stays uncounted until the reader moves off
    // it; reading on from there counts as usual.
    const here = `${activeChapterId}#${activePageIndex}`;
    if (jumpSettling()) jumpLandingRef.current = here;
    else if (jumpLandingRef.current !== null && jumpLandingRef.current !== here) jumpLandingRef.current = null;
    const counts = jumpLandingRef.current === null;
    const stats = chapterStatsRef.current;
    const existing = stats.get(activeChapterId);
    if (!existing) {
      // Started now even when arrived at by a jump (dwell time counts from
      // the chapter opening), but nothing past page 1 counts until read.
      stats.set(activeChapterId, {
        startedAt: Date.now(),
        maxPage: counts ? activePageIndex + 1 : 1,
        total: activeTotalPages,
      });
      return;
    }
    if (!counts) return;
    // Furthest page reached, not the current one — scrolling back up must not
    // reduce how much of the chapter counts as read.
    existing.maxPage = Math.max(existing.maxPage, activePageIndex + 1);
    existing.total = activeTotalPages;
    if (existing.maxPage >= existing.total) markFinishedRead(activeChapterId);
  });

  /**
   * Mark a chapter as read to the end.
   *
   * Viewability alone can't always prove completion — the last page of a short
   * chapter may never become the topmost visible row — but some events are
   * unambiguous: reaching the bottom of the loaded content, or moving on to a
   * later chapter. You cannot arrive at chapter 13 without having finished 12.
   */
  const creditChapterComplete = useCallback((chapterId: string) => {
    const stat = chapterStatsRef.current.get(chapterId);
    if (stat && stat.total > 0) stat.maxPage = stat.total;
    markFinishedRead(chapterId);
  }, []);

  const flushGamification = useCallback((chapterId: string) => {
    if (isAdultRef.current || !mangaIdRef.current || !chapterId) return;
    if (emittedRef.current.has(chapterId)) return;
    const stat = chapterStatsRef.current.get(chapterId);
    if (!stat || stat.total <= 0) return;
    emittedRef.current.add(chapterId);
    const progress = Math.min(1, stat.maxPage / stat.total);
    void recordReadingEvent({
      kind: 'manga',
      contentId: mangaIdRef.current,
      chapterId,
      seriesId: mangaIdRef.current,
      progress,
      dwellMs: Date.now() - stat.startedAt,
      completed: progress >= 0.9,
    });
  }, []);

  // The end card coming into view is the end of the last chapter in the
  // session, read through (a scrub there is a skip: jumpSettling).
  useEffect(() => {
    if (!endReachedFor || jumpSettling()) return;
    creditChapterComplete(endReachedFor);
  }, [endReachedFor, creditChapterComplete]);

  // A chapter appended after the end card was reached pushes the card off
  // screen without any scroll event; forget the stale "at the end".
  useEffect(() => {
    if (endReachedFor && endReachedFor !== lastSegmentId) {
      atEndRef.current = false;
      setEndReachedFor(null);
    }
  }, [endReachedFor, lastSegmentId]);

  // Flush the chapter just left as soon as the reader crosses a boundary, so a
  // long session reports as it goes rather than all at once on exit.
  const prevActiveChapterRef = useRef('');
  useEffect(() => {
    const previous = prevActiveChapterRef.current;
    if (previous && previous !== activeChapterId) {
      // Moving forward is proof the chapter behind you was finished, whatever
      // the viewable rows happened to report.
      const from = segmentsRef.current.find((s) => s.chapterId === previous);
      const to = segmentsRef.current.find((s) => s.chapterId === activeChapterId);
      if (from && to && to.orderIndex > from.orderIndex && !jumpSettling()) {
        creditChapterComplete(previous);
      }
      flushGamification(previous);
    }
    prevActiveChapterRef.current = activeChapterId;
  }, [activeChapterId, flushGamification, creditChapterComplete]);

  useEffect(() => {
    return () => {
      // Whatever chapter is still open on the way out.
      flushGamification(prevActiveChapterRef.current);
    };
  }, [flushGamification]);

  // Switch reading mode in place: remember where you are, flip the mode, then
  // restore that same page once the list has re-laid-out in the new geometry.
  //
  // The restore can't be a fixed timer. Flipping the axis re-lays out every row,
  // and in webtoon mode the target rows have no measured height yet, so a jump
  // fired 120ms later jumps into unmeasured space, falls through to
  // onScrollToIndexFailed, and lands *near* the page you were on rather than on
  // it. Instead, record the target and re-land on it from every layout pass
  // until the geometry settles.
  // The anchor is a chapter plus a page, never a flat row index, so a
  // neighbouring chapter attaching mid-restore cannot redirect it.
  const pendingRestoreRef = useRef<{
    chapterId: string;
    page: number;
    tries: number;
    /** When it was set; a restore older than RESTORE_MAX_MS gives up. */
    startedAt?: number;
    /** Set by a jump (slider, Home/End, a chapter button): see jumpSettling. */
    jump?: boolean;
    /**
     * A re-layout (resize, rotation, width or fit change) lands on this row
     * and this far into it, so the reader stays mid-page instead of being
     * thrown back to the top of a strip that can be many screens tall.
     */
    rowId?: string;
    fraction?: number;
  } | null>(null);

  const changeReadingMode = useCallback(
    (next: 'page' | 'scroll') => {
      if (next === readingMode) return;
      pendingRestoreRef.current = {
        chapterId: activeChapterId,
        page: activePageIndex,
        tries: 0,
      };
      setReadingMode(next);
      void AppSettings.setMangaReadingMode(next);
      didInitialScroll.current = true; // don't let the initial-scroll effect fight us
    },
    [readingMode, activeChapterId, activePageIndex],
  );

  const changeReadDirection = useCallback(
    (next: 'ltr' | 'rtl') => {
      if (next === readDirection) return;
      // Mirroring re-lays the list out, so hold the reader's place across it.
      pendingRestoreRef.current = {
        chapterId: activeChapterId,
        page: activePageIndex,
        tries: 0,
      };
      setReadDirection(next);
      void AppSettings.setReadDirection(next);
    },
    [readDirection, activeChapterId, activePageIndex],
  );

  const runPendingRestore = useCallback(() => {
    const pending = pendingRestoreRef.current;
    if (!pending) return;
    pending.tries += 1;
    // Bounded so a chapter that never settles can't retry forever. Each attempt
    // is just a scroll to an offset getItemLayout already knows, so over-trying
    // costs nothing and the last one wins. Images around the target report
    // their sizes one by one, so the bound is by time as well as count.
    if (pending.tries > 40 || (pending.startedAt && Date.now() - pending.startedAt > RESTORE_MAX_MS)) {
      pendingRestoreRef.current = null;
      return;
    }
    if (pending.rowId) {
      const index = rowsRef.current.findIndex((row) => row.id === pending.rowId);
      if (index >= 0) {
        jumpToRow(index, false, pending.fraction ?? 0);
        return;
      }
    }
    jumpToChapterPage(pending.chapterId, pending.page, false);
  }, [jumpToChapterPage, jumpToRow]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  /**
   * Fade the overlay out.
   *
   * Deliberately not the old `toggleUI`. A toggle is a flip, so a timer wired to
   * it would SHOW the bar whenever it fired while already hidden — an auto-hide
   * that makes the overlay appear on its own two seconds after you dismissed it.
   * Written as a plain idempotent function rather than a setState updater: the
   * previous version mutated `uiOpacity` inside the updater, and React may
   * double-invoke updaters.
   */
  const hideUI = useCallback(() => {
    clearHideTimer();
    if (!uiVisibleRef.current) return;
    uiVisibleRef.current = false;
    setUiShown(false);
    fadeUiTo(0);
    // pointerEvents lags the fade. If it flipped now the controls would go dead
    // while still fully painted, and a finger already in flight would press a
    // visible button and get nothing. Invisible when the user dismisses the bar
    // themselves; the most-reported class of bug once a timer does it for them.
    if (pointerOffTimerRef.current) clearTimeout(pointerOffTimerRef.current);
    pointerOffTimerRef.current = setTimeout(() => {
      pointerOffTimerRef.current = null;
      setUiInteractive(false);
    }, UI_FADE_MS);
  }, [clearHideTimer, uiOpacity]);

  // onScroll is declared several hundred lines above this point and cannot name
  // hideUI in a dependency array. Same pattern as ensureNextRef/ensurePrevRef.
  hideUIRef.current = hideUI;

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    if (!uiVisibleRef.current) return; // nothing on screen to hide
    if (uiHoldRef.current > 0) return; // a finger or a modal owns it
    hideTimerRef.current = setTimeout(hideUI, AUTO_HIDE_MS);
  }, [clearHideTimer, hideUI]);

  const showUI = useCallback(() => {
    if (pointerOffTimerRef.current) {
      clearTimeout(pointerOffTimerRef.current);
      pointerOffTimerRef.current = null;
    }
    uiVisibleRef.current = true; // order matters: scheduleHide reads this
    setUiShown(true);
    setUiInteractive(true);
    // Started unconditionally: a fade from the current value to the same value
    // costs one frame, and this runs on a touch path where checking first would
    // mean reading the animated value back.
    fadeUiTo(1);
    scheduleHide();
  }, [uiOpacity, scheduleHide]);

  const toggleUI = useCallback(() => {
    if (uiVisibleRef.current) hideUI();
    else showUI();
  }, [hideUI, showUI]);

  /** Suspend the timer entirely — restarting it isn't enough, because a slow
   *  scrub or a long visit to the settings sheet outlasts any window. */
  const holdUI = useCallback(() => {
    uiHoldRef.current += 1;
    clearHideTimer();
  }, [clearHideTimer]);

  const releaseUI = useCallback(() => {
    uiHoldRef.current = Math.max(0, uiHoldRef.current - 1);
    if (uiHoldRef.current === 0) scheduleHide();
  }, [scheduleHide]);

  /**
   * A touch landing on the overlay itself.
   *
   * The overlays swallow their own touches, so the list's onTouchEnd never fires
   * for them and without this, tapping the top bar's background wouldn't extend
   * its life. It also rescues "reached a moment too late": during the fade-out
   * the bar is still painted and still interactive, so the touch cancels the
   * hide instead of falling through to nothing.
   */
  const noteUiTouch = useCallback(() => {
    if (uiVisibleRef.current) scheduleHide();
    else showUI();
  }, [scheduleHide, showUI]);

  /**
   * Back, without stranding the reader.
   *
   * `router.back()` with nothing to pop does not stay put — it lands on the app
   * root carrying this route's params (verified: `/app/?id=<chapterId>`), which
   * renders an indefinite spinner. That is not an edge case: the reader is
   * reached with an empty stack by a refresh inside it, a shared or bookmarked
   * link, a PWA shortcut, and a notification tap.
   *
   * The manga page is where back means to go anyway, so go there directly
   * rather than asking history whether it happens to be behind us.
   */
  const goBack = useCallback(() => {
    clearHideTimer();
    // Navigate to the series explicitly rather than popping the stack.
    //
    // Both `router.canGoBack()` and `navigation.canGoBack()` return true here
    // even on a chapter opened cold — measured against two deployed bundles —
    // because a direct load synthesises the index route underneath, so there is
    // always *something* to pop. Popping it lands on `/app/?id=<chapterId>`,
    // which is not a screen. Neither predicate can tell a real previous screen
    // from that stand-in, so asking them is the wrong question.
    //
    // Back from a chapter means "the series this chapter belongs to" whatever
    // the route history happens to look like, and that is knowable from the id
    // we already hold. The cost is that arriving from Library or Continue
    // Reading now also lands on the series page rather than where you came
    // from — predictable, and never a dead end.
    router.replace({
      pathname: '/manga/[id]',
      params: {
        id: mangaId,
        ...(typeof source === 'string' && source ? { source } : {}),
      },
    });
  }, [clearHideTimer, router, mangaId, source]);

  // ── Page geometry ──────────────────────────────────────────────────────
  //
  // Webtoon mode: every row's height is known up front — measured, stated by
  // the source, remembered from an earlier visit, or the chapter's median —
  // so FlatList gets a real getItemLayout. That is what lets a resume (or a
  // slider seek, or Home/End) jump straight to page 60: before, there was no
  // layout, scrollToIndex landed on an estimate and re-landed on every
  // measure, mounting and downloading each page on the way (live: 7.5 s and
  // 5.5 MB to reach page 60, settling on 59).
  //
  // Pages sit in a centred column capped at the reader's max width, so a
  // 690 px strip is no longer blown up to 1440+ px on a desktop window.
  const isPaged = readingMode === 'page';
  const columnW = columnWidth(winW, prefs.maxWidth, READER_MAX_WIDTH_MAX);
  const pageGap = !isPaged && prefs.pageGap ? PAGE_GAP_PX : 0;
  const headerLength = hasPrevChapter ? LIST_HEADER_HEIGHT : 0;
  const ratioMedians = useMemo(() => {
    const byChapter: Record<string, number | null> = {};
    const all: number[] = [];
    for (const segment of segments) {
      const known = segment.pages.map((pg) => pageSizes[pg.id]?.ratio).filter(isUsableRatio);
      byChapter[segment.chapterId] = medianRatio(known);
      all.push(...known);
    }
    return { byChapter, session: medianRatio(all) };
  }, [segments, pageSizes]);
  const webtoonGeometry = useMemo(() => {
    if (isPaged) return null;
    const boxes = rows.map((row) =>
      row.kind === 'page'
        ? webtoonPageBox({
            ratio: estimatedRatio(pageSizes[row.id]?.ratio, ratioMedians.byChapter[row.chapterId], ratioMedians.session),
            naturalWidth: pageSizes[row.id]?.width,
            fit: prefs.pageFit,
            columnW,
            windowW: winW,
            windowH: winH,
          })
        : null,
    );
    const layout = buildListLayout(
      boxes.map((box) => (box ? box.height + pageGap : MARKER_HEIGHT)),
      headerLength,
    );
    return { boxes, layout };
  }, [isPaged, rows, pageSizes, ratioMedians, prefs.pageFit, columnW, winW, winH, pageGap, headerLength]);
  const getItemLayout = useMemo(() => {
    if (!webtoonGeometry) {
      // Paged: every row is exactly one window wide.
      return (_: unknown, index: number) => ({ length: winW, offset: winW * index, index });
    }
    const { layout } = webtoonGeometry;
    return (_: unknown, index: number) => ({
      length: layout.lengths[index] ?? 0,
      offset: layout.offsets[index] ?? layout.total,
      index,
    });
  }, [webtoonGeometry, winW]);
  rowSpanRef.current = (index: number) => getItemLayout(null, index);

  /**
   * Pages that load eagerly before viewability has reported anything: the
   * page the chapter opens on and the one after. Otherwise the first image
   * waited behind `loading="lazy"` and low priority until the first
   * viewability pass (layout plus minimumViewTime) promoted it.
   */
  const eagerPageIds = useMemo(() => {
    if (visiblePageIds.size > 0) return visiblePageIds;
    const ids = new Set<string>();
    const entry = segments.find((seg) => seg.chapterId === entryChapterId);
    [initialTarget, initialTarget + 1].forEach((i) => {
      const pg = entry?.pages[i];
      if (pg) ids.add(pg.id);
    });
    return ids;
  }, [visiblePageIds, segments, entryChapterId, initialTarget]);

  const background = BACKGROUNDS[prefs.background];
  const lightBackground = prefs.background === 'white';

  const renderPage = useCallback(
    ({ item, index }: { item: ReaderRow; index: number }) => {
      if (item.kind === 'marker') {
        // Fixed height (MARKER_HEIGHT): the layout above counts on it.
        return (
          <View style={[styles.chapterDivider, { width: winW }, lightBackground && styles.chapterDividerLight]}>
            <View style={[styles.chapterDividerRule, lightBackground && styles.chapterDividerRuleLight]} />
            <View style={styles.chapterDividerText}>
              <Text style={[styles.chapterDividerKicker, lightBackground && styles.chapterDividerKickerLight]}>NEXT</Text>
              <Text style={[styles.chapterDividerLabel, lightBackground && styles.chapterDividerLabelLight]} numberOfLines={1}>
                {item.label}
              </Text>
            </View>
            <View style={[styles.chapterDividerRule, lightBackground && styles.chapterDividerRuleLight]} />
          </View>
        );
      }
      const known = pageSizes[item.id];
      let width = winW;
      let height = winH;
      let rowHeight = winH;
      if (webtoonGeometry) {
        const box = webtoonGeometry.boxes[index] ?? { width: columnW, height: columnW * 1.5 };
        width = box.width;
        height = box.height;
        rowHeight = box.height + pageGap;
      } else if (prefs.pageFit === 'original' && known?.width) {
        // Paged 'original': the image's own pixels, scaled down only to fit.
        const scale = Math.min(1, winW / known.width, winH / (known.width * known.ratio));
        width = Math.round(known.width * scale);
        height = Math.round(known.width * known.ratio * scale);
      }
      return (
        <View style={[styles.pageRow, { width: winW, height: rowHeight }, isPaged && styles.pageRowPaged]}>
          <ReaderPageImage
            uri={item.url}
            pageId={item.id}
            pageNumber={item.pageIndex + 1}
            width={width}
            height={height}
            viewportHeight={winH}
            mirrored={isRtlPageMode}
            isVisible={eagerPageIds.has(item.id)}
            onLoad={(w, h) => handlePageLoad(item, w, h)}
            onBack={goBack}
          />
        </View>
      );
    },
    [
      winW,
      winH,
      columnW,
      pageGap,
      isPaged,
      prefs.pageFit,
      lightBackground,
      webtoonGeometry,
      pageSizes,
      isRtlPageMode,
      eagerPageIds,
      handlePageLoad,
      goBack,
    ],
  );

  /**
   * Desktop's double tap is a double click.
   *
   * A mouse fires no touch events, so `onTouchEnd` never reaches the list. With
   * the overlay starting hidden that would leave a desktop reader no way to
   * summon it at all. Deliberately the same gesture rather than a mouse-only
   * affordance like reveal-on-hover: "only on a double tap" should mean the same
   * thing on both.
   *
   * A DOM listener rather than a View prop. `onPointerDown` on a View is dropped
   * by react-native-web — verified against the deployed bundle by dispatching
   * pointerdown pairs at the list, which never reached the handler — and
   * `dblclick` is the browser's own notion of this gesture, so there is no
   * timing window to reimplement.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !focused) return;
    const onDoubleClick = (e: MouseEvent) => {
      // A double click on the overlay's own controls is aimed at them, not at
      // dismissing the thing they live in.
      if (uiVisibleRef.current && e.target instanceof Node && overlayHostRef.current?.contains(e.target)) {
        return;
      }
      // In paged mode the outer thirds turn pages on a single click; two quick
      // page turns are not a request for the overlay.
      if (pagedTapZone(e.clientX) !== 'center') return;
      toggleUI();
    };
    document.addEventListener('dblclick', onDoubleClick);
    return () => document.removeEventListener('dblclick', onDoubleClick);
  }, [toggleUI, focused]);

  /**
   * The overlay toggles on a DOUBLE tap, not a single one.
   *
   * Reading is a long sequence of touches — every flick and every finger rest
   * ends in a touch event, and on a single tap the top bar and page strip kept
   * appearing over the page mid-read. A second tap is a deliberate act;
   * scrolling never produces one.
   *
   * Taps landing while the list is still moving are ignored outright, so
   * settling a fling with a finger down can't count as the first tap of a pair.
   */
  const lastTapRef = useRef(0);
  /** Auto-scroll waits until this time (a touch, wheel or key pushes it on). */
  const autoScrollPausedUntilRef = useRef(0);
  function pauseAutoScroll() {
    autoScrollPausedUntilRef.current = Date.now() + AUTO_SCROLL_RESUME_MS;
  }
  /** What a tap at screen x does right now: a page turn in paged mode, else nothing. */
  function pagedTapZone(x: number) {
    const state = inputStateRef.current;
    if (!state.paged) return 'center' as const;
    return tapZoneAction(x, state.width, state.rtl, state.tapZones);
  }
  const handleReaderTap = useCallback(() => {
    if (isScrollingRef.current) return;
    const now = Date.now();
    if (now - lastTapRef.current <= DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      toggleUI();
      return;
    }
    lastTapRef.current = now;
    // The FIRST tap of a pair is interaction too. Without this the timer can
    // expire inside the window between the two taps, so a double tap meant to
    // dismiss the bar hides it and then immediately re-shows it.
    scheduleHide();
  }, [toggleUI, scheduleHide]);

  const markSeeking = useCallback(() => {
    seekingRef.current = true;
    if (seekGuardRef.current) clearTimeout(seekGuardRef.current);
    seekGuardRef.current = setTimeout(() => {
      seekingRef.current = false;
    }, SEEK_GUARD_MS);
  }, []);

  /**
   * Move to a page in the chapter on screen, from the slider.
   *
   * Targets `activeSegment.chapterId`, not `activeChapterId`: activeSegment
   * falls back to segments[0] and totalPages is derived from it, so using
   * activeChapterId could aim at a chapter that isn't resident — rowIndexFor
   * returns -1, the jump is a silent no-op, and the knob has already moved.
   */
  const seekToPage = useCallback(
    (pageIndex: number) => {
      const segment = activeSegment;
      if (!segment) return;
      markSeeking();
      // Warm the destination before its cell mounts. The strip this bar replaces
      // doubled as a whole-chapter prefetch — thumbnails and pages shared a URL,
      // so the image cache was warm by the time you swiped. Pages render with no
      // transition, so an unwarmed page paints nothing at all until fetch and
      // decode finish; without this every paged seek lands on black.
      // Data saver warms only the destination; look-ahead takes it from there.
      const span = dataSaverRef.current ? [pageIndex] : [pageIndex - 1, pageIndex, pageIndex + 1, pageIndex + 2];
      for (const k of span) {
        const pg = segment.pages[k];
        if (pg && segment.origin === 'network') warmReaderImage(pg.url);
      }
      if (readingMode === 'scroll') {
        // getItemLayout makes the jump itself exact, but rows near the target
        // that are still estimates correct their heights as they load. Re-land
        // from every layout pass until they settle — the mechanism the mode
        // switch uses. A user drag, wheel or key cancels it.
        pendingRestoreRef.current = { chapterId: segment.chapterId, page: pageIndex, tries: 0, startedAt: Date.now(), jump: true };
      } else {
        pendingRestoreRef.current = null;
      }
      jumpToChapterPage(segment.chapterId, pageIndex, false);
    },
    [activeSegment, markSeeking, readingMode, jumpToChapterPage],
  );

  /**
   * Warm where the finger pauses, not every page it sweeps over. Both modes
   * now: a webtoon seek lands directly on its page (getItemLayout), so the
   * page is no longer streamed in on the way there.
   */
  const previewSeek = useCallback(
    (pageIndex: number) => {
      const segment = activeSegment;
      if (!segment || segment.origin !== 'network') return;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        const span = dataSaverRef.current ? [pageIndex] : [pageIndex, pageIndex + 1, pageIndex - 1];
        span.forEach((k) => {
          const pg = segment.pages[k];
          if (pg) warmReaderImage(pg.url);
        });
      }, 140);
    },
    [activeSegment],
  );

  /** The chapters either side of the one on screen, from the normalised list. */
  const adjacentChapters = useMemo(() => {
    const at = orderedChapters.findIndex((c) => c.id === activeChapterId);
    if (at < 0) return { prev: null, next: null };
    return { prev: orderedChapters[at - 1] ?? null, next: orderedChapters[at + 1] ?? null };
  }, [orderedChapters, activeChapterId]);

  /**
   * Near the end of a chapter, fetch the next one's page list and warm its
   * first page, so "Next chapter" opens from memory and the HTTP cache rather
   * than waiting on a page-list request (~600 ms plus preflight live) and
   * then a cold first image.
   *
   * Only with continuous reading off: with it on, ensureNextChapter already
   * loads the next chapter at this point (through the same cached
   * loadChapterPages). Asking on every page turn past the threshold is cheap:
   * prefetchChapterPages and warmReaderImage both remember what they did.
   */
  const nextChapterId = adjacentChapters.next?.id ?? null;
  const nearChapterEnd =
    activeTotalPages > 0 && (activePageIndex + 1) / activeTotalPages >= NEXT_CHAPTER_PREFETCH_AT;
  useEffect(() => {
    // Data saver: nothing is fetched for a chapter the reader may not open.
    if (continuous || dataSaver || !nearChapterEnd || !nextChapterId || !mangaId) return;
    let cancelled = false;
    void prefetchChapterPages({ contentId: mangaId, chapterId: nextChapterId, source })
      .then((urls) => {
        if (cancelled || !urls?.length) return;
        // Lets an Up next row (saved at the end of this chapter) know the
        // next chapter's length.
        setPrefetchedPageCounts((prev) =>
          prev[nextChapterId] === urls.length ? prev : { ...prev, [nextChapterId]: urls.length },
        );
        warmReaderImage(urls[0]);
      });
    return () => {
      cancelled = true;
    };
  }, [continuous, dataSaver, nearChapterEnd, nextChapterId, mangaId, source]);

  /**
   * What Sakura is looking at.
   *
   * The chapter NUMBER comes from the loaded chapter list rather than from the
   * label, because the label is free-form per source. It is often unavailable:
   * orderedChapters is empty until the fetch resolves and stays empty on
   * failure, activeChapterId is '' until pages load, and the normaliser dedupes
   * by number so a duplicate upload's id can be missing entirely. It can also be
   * NaN for atsu-backed manga. buildReaderContext handles all of that and falls
   * back to parsing the label — a wrong number here is what makes the spoiler
   * guard cheerfully spoil the next arc.
   */
  const aiContext = useMemo(
    () =>
      buildReaderContext({
        medium: mediumFromSource(typeof source === 'string' ? source : undefined),
        seriesId: mangaId || undefined,
        seriesTitle: mangaTitle,
        chapterId: activeChapterId || undefined,
        chapterLabel: chapterLabel || undefined,
        chapterNumber: orderedChapters.find((c) => c.id === activeChapterId)?.number ?? null,
        totalChapters: orderedChapters.length || null,
        page: activePageIndex + 1,
        totalPages: activeTotalPages || null,
        allowSpoilers,
      }),
    [
      source,
      mangaId,
      mangaTitle,
      activeChapterId,
      chapterLabel,
      orderedChapters,
      activePageIndex,
      activeTotalPages,
      allowSpoilers,
    ],
  );

  /**
   * Tools only the reader can run. Turning "chapter 40" into a chapter id needs
   * the loaded list, which lib/sakura-ai.ts has no access to.
   *
   * Every branch returns an object. Returning undefined would fall through to
   * the shared dispatcher, which answers "Unknown tool" — the model would then
   * tell the user it could not navigate, right after navigating.
   */
  const askDispatch = useCallback(
    async (name: string, args: Record<string, any>) => {
      if (name !== 'open_in_app') return undefined;
      // Non-chapter targets fall through to the shared dispatcher, and
      // ReaderAskSheet closes the sheet on any open_in_app that reports ok.
      if (String(args.target) !== 'chapter') return undefined;

      const wanted = Number(args.chapter_number);
      const target = args.chapter_id
        ? orderedChapters.find((c) => c.id === String(args.chapter_id))
        : Number.isFinite(wanted)
          ? orderedChapters.find((c) => c.number === wanted)
          : undefined;

      if (!target) {
        return {
          ok: false,
          error: Number.isFinite(wanted)
            ? `Chapter ${wanted} isn't in this series' list.`
            : 'Which chapter?',
        };
      }

      setAskOpen(false);
      markSeeking(); // a jump is a skip, never a completed read
      router.replace({
        pathname: '/chapter/[id]',
        params: {
          id: `${mangaId}~${target.id}`,
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof cover === 'string' ? { cover } : {}),
          chapter: target.title || `Chapter ${target.number}`,
          ...(typeof source === 'string' && source ? { source } : {}),
        },
      });
      return { ok: true, opened: 'chapter', chapter_number: target.number };
    },
    [orderedChapters, mangaId, title, cover, source, markSeeking, router],
  );

  /** Open a chapter of this series: a scroll when it is resident, else a route swap. */
  const openChapter = useCallback(
    (target: MangaChapter) => {
      markSeeking(); // a button press is a skip, never a completed read
      scheduleHide();
      // Continuous reading has usually already attached the neighbour, in which
      // case this is a scroll rather than a load.
      if (segmentsRef.current.some((s) => s.chapterId === target.id)) {
        if (readingMode === 'scroll') {
          pendingRestoreRef.current = { chapterId: target.id, page: 0, tries: 0, startedAt: Date.now(), jump: true };
        }
        jumpToChapterPage(target.id, 0, false);
        return;
      }
      pendingRestoreRef.current = null;
      // replace, not push: otherwise every press adds a back-stack entry and
      // backing out of a long session walks you through all of them.
      router.replace({
        pathname: '/chapter/[id]',
        params: {
          id: `${mangaId}~${target.id}`,
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof cover === 'string' ? { cover } : {}),
          chapter: target.title || `Chapter ${target.number}`,
          ...(typeof source === 'string' && source ? { source } : {}),
        },
      });
    },
    [jumpToChapterPage, mangaId, markSeeking, readingMode, router, scheduleHide, title, cover, source],
  );

  const goToAdjacentChapter = useCallback(
    (dir: -1 | 1) => {
      const target = dir === 1 ? adjacentChapters.next : adjacentChapters.prev;
      if (target) openChapter(target);
    },
    [adjacentChapters, openChapter],
  );

  // Hoisted out of the JSX so React.memo on the bar can actually bite.
  const goPrevChapter = useCallback(() => goToAdjacentChapter(-1), [goToAdjacentChapter]);
  const goNextChapter = useCallback(() => goToAdjacentChapter(1), [goToAdjacentChapter]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const modeLabel = useMemo(() => {
    if (readingMode === 'page') {
      return `Paged (${readDirection === 'rtl' ? 'right to left' : 'left to right'})`;
    }
    // The caption opens the sheet that owns this switch, so it must not claim
    // "continuous" while the switch beside it is off.
    return continuous ? 'Webtoon (continuous)' : 'Webtoon';
  }, [readingMode, readDirection, continuous]);

  /**
   * Look-ahead: keep the next few pages downloading, in both modes, spilling
   * into the next resident chapter. Webtoon mode had none and relied on lazy
   * <img> loading, so a fast reader met "Loading page N…" on about one
   * screen in ten. The web implementation cancels pages that fall out of the
   * window (a jump, a chapter change). Data saver keeps one page ahead.
   * Downloaded chapters read from disk and need none.
   */
  useEffect(() => {
    if (!focused || loading) {
      clearReaderLookAhead();
      return;
    }
    const current = rowIndexFor(bounds, activeChapterId, activePageIndex);
    if (current < 0) return;
    const count = lookAheadCount(readingMode, dataSaver);
    const offline = new Set(segments.filter((seg) => seg.origin === 'offline').map((seg) => seg.chapterId));
    const ahead = rows
      .slice(current + 1, current + 1 + count * 2)
      .filter((row) => row.kind === 'page' && !offline.has(row.chapterId));
    setReaderLookAhead(lookAheadUrls(ahead, -1, count));
  }, [focused, loading, bounds, rows, segments, activeChapterId, activePageIndex, readingMode, dataSaver]);

  /**
   * Hold the overlay open while the settings sheet is up.
   *
   * Declarative rather than paired hold/release calls on the "Aa" button and
   * onClose. The sheet is a Modal with a fade animation, so during its fade-in
   * the button underneath is still mounted and touchable — a fast double-press
   * would take two holds against one release, the counter would never return to
   * zero, and auto-hide would be dead for the rest of the session. An effect is
   * idempotent by construction and covers any future close path.
   */
  useEffect(() => {
    if (!settingsOpen) return;
    holdUI();
    return releaseUI;
  }, [settingsOpen, holdUI, releaseUI]);

  /** Same idempotent hold for the ask sheet. Note this only suspends the
   *  auto-hide TIMER — hideUI() called directly (scroll dismiss, route change,
   *  a web double-click) still fires underneath. That is survivable here: the
   *  modal is a separate layer, so the overlay fading behind it costs nothing. */
  useEffect(() => {
    if (!askOpen) return;
    holdUI();
    return releaseUI;
  }, [askOpen, holdUI, releaseUI]);

  /**
   * Hide the overlay when the chapter underneath changes.
   *
   * The prev/next buttons replace the route WITHOUT remounting, so nothing else
   * resets it — and the overlay you summoned over chapter 12 should not still be
   * sitting there over chapter 13, reporting the wrong page count until its
   * timer happens to run out.
   */
  useEffect(() => {
    hideUIRef.current();
    // Only on a genuine route change: `rows` grows whenever continuous reading
    // attaches a neighbour, which must not dismiss a bar the reader just opened.
  }, [mangaId, entryChapterId]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // A timer scheduled before backgrounding can't be trusted across the gap —
      // iOS suspends JS timers, Android generally doesn't — so re-arm from now
      // rather than letting it fire at an arbitrary moment on resume.
      if (state === 'active') scheduleHide();
      else clearHideTimer();
    });
    return () => sub.remove();
  }, [scheduleHide, clearHideTimer]);

  useFocusEffect(
    useCallback(() => {
      // A no-op unless the overlay is actually up: scheduleHide returns early
      // when uiVisibleRef is false, which it is on entry and after every hide.
      scheduleHide();
      return clearHideTimer;
    }, [scheduleHide, clearHideTimer]),
  );

  // ── Input: tap zones, keyboard, auto-scroll ───────────────────────────

  /** Read by event handlers registered once; refreshed every render. */
  const inputStateRef = useRef({
    paged: false,
    rtl: false,
    tapZones: 'auto' as ReaderPrefs['tapZones'],
    width: 0,
    sheetOpen: false,
  });
  inputStateRef.current = {
    paged: isPaged,
    rtl: isRtlPageMode,
    tapZones: prefs.tapZones,
    width: winW,
    sheetOpen: settingsOpen || askOpen,
  };

  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : null;
  /** The chapter after the last one in the session, for the end card. */
  const endNext = useMemo((): MangaChapter | null | undefined => {
    if (!lastSegment || orderedChapters.length === 0) return undefined;
    const at = orderedChapters.findIndex((c) => c.id === lastSegment.chapterId);
    if (at < 0) return undefined;
    return orderedChapters[at + 1] ?? null;
  }, [orderedChapters, lastSegment]);

  /**
   * One page forward or back in paged mode, for tap zones and keys. Past the
   * last page comes the end card; past the end card, the next chapter.
   */
  const turnPage = useCallback(
    (dir: 1 | -1) => {
      if (readingMode !== 'page') return;
      pendingRestoreRef.current = null;
      const all = rowsRef.current;
      if (atEndRef.current) {
        if (dir === 1) {
          if (endNext) openChapter(endNext);
        } else if (all.length > 0) {
          const last = all[all.length - 1];
          if (last.kind === 'page') jumpToChapterPage(last.chapterId, last.pageIndex, true);
        }
        return;
      }
      const current = rowIndexFor(boundsRef.current, activeChapterId, activePageIndex);
      if (current < 0) return;
      const target = current + dir;
      if (target >= all.length) {
        flatListRef.current?.scrollToOffset({ offset: all.length * winW, animated: true });
        return;
      }
      const row = all[target];
      if (!row || row.kind !== 'page') return;
      scheduleHide();
      jumpToChapterPage(row.chapterId, row.pageIndex, true);
    },
    [readingMode, endNext, openChapter, jumpToChapterPage, activeChapterId, activePageIndex, winW, scheduleHide],
  );

  /** Webtoon: scroll by a share of the screen. */
  const scrollByScreens = useCallback(
    (screens: number) => {
      const offset = Math.max(0, scrollOffsetRef.current + screens * winH);
      flatListRef.current?.scrollToOffset({ offset, animated: true });
    },
    [winH],
  );

  const runKeyAction = (action: NonNullable<ReturnType<typeof readerKeyAction>>) => {
    switch (action) {
      case 'line-down':
        return scrollByScreens(0.25);
      case 'line-up':
        return scrollByScreens(-0.25);
      case 'screen-down':
        return scrollByScreens(0.85);
      case 'screen-up':
        return scrollByScreens(-0.85);
      case 'next-page':
        return turnPage(1);
      case 'prev-page':
        return turnPage(-1);
      case 'next-chapter':
        // At the end card the active chapter is the last one, so this is the
        // card's own "Read next chapter".
        return goToAdjacentChapter(1);
      case 'prev-chapter':
        return goToAdjacentChapter(-1);
      case 'first-page':
      case 'last-page': {
        const segment = activeSegment;
        if (!segment || segment.pages.length === 0) return;
        const page = action === 'first-page' ? 0 : segment.pages.length - 1;
        markSeeking(); // a jump, not reading
        if (readingMode === 'scroll') {
          pendingRestoreRef.current = { chapterId: segment.chapterId, page, tries: 0, startedAt: Date.now(), jump: true };
        }
        jumpToChapterPage(segment.chapterId, page, false);
        return;
      }
      case 'fullscreen':
        return toggleFullscreen();
      case 'escape':
        if (uiVisibleRef.current) hideUI();
        return;
    }
  };
  const runKeyActionRef = useRef(runKeyAction);
  runKeyActionRef.current = runKeyAction;
  const turnPageRef = useRef(turnPage);
  turnPageRef.current = turnPage;

  /**
   * Desktop keyboard (readerKeyAction has the map). A document listener, as
   * with dblclick: the RN-web list never holds focus, so before this Space,
   * the arrows and PageDown did nothing at all. Inactive while another
   * screen is in front, while a sheet is open, and while typing.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !focused) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (inputStateRef.current.sheetOpen) return;
      const state = inputStateRef.current;
      const action = readerKeyAction(e, state.paged ? 'page' : 'scroll', state.rtl);
      if (!action) return;
      e.preventDefault();
      pendingRestoreRef.current = null;
      pauseAutoScroll();
      runKeyActionRef.current(action);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focused]);

  /**
   * Web: click/tap zones in paged mode, and any direct interaction with the
   * list (wheel, touch, a press) ends a pending restore and pauses
   * auto-scroll. RN-web never fires onScrollBeginDrag, which is what does
   * this on native.
   */
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || !focused) return;
    const listNode = () =>
      (flatListRef.current as unknown as { getScrollableNode?: () => unknown } | null)?.getScrollableNode?.() as
        | HTMLElement
        | null
        | undefined;
    const inList = (target: EventTarget | null) => {
      const node = listNode();
      return !!node && target instanceof Node && node.contains(target);
    };
    const onInteract = (e: Event) => {
      if (!inList(e.target)) return;
      pendingRestoreRef.current = null;
      pauseAutoScroll();
    };
    const onClick = (e: MouseEvent) => {
      if (!inputStateRef.current.paged || !inList(e.target)) return;
      if ((e.target as HTMLElement | null)?.closest?.('[role="button"],button,a,input')) return;
      const zone = pagedTapZone(e.clientX);
      if (zone !== 'center') turnPageRef.current(zone === 'next' ? 1 : -1);
    };
    document.addEventListener('wheel', onInteract, { passive: true });
    document.addEventListener('touchstart', onInteract, { passive: true });
    document.addEventListener('mousedown', onInteract);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('wheel', onInteract);
      document.removeEventListener('touchstart', onInteract);
      document.removeEventListener('mousedown', onInteract);
      document.removeEventListener('click', onClick);
    };
  }, [focused]);

  /** Native: a short, still touch is a tap; in paged mode its third decides. */
  const touchStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const onListTouchStart = useCallback((e: GestureResponderEvent) => {
    const { pageX, pageY } = e.nativeEvent;
    touchStartRef.current = { x: pageX, y: pageY, at: Date.now() };
    pauseAutoScroll();
  }, []);
  const onListTouchEnd = useCallback(
    (e: GestureResponderEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      const { pageX, pageY } = e.nativeEvent;
      const still =
        !!start &&
        Math.abs(pageX - start.x) < TAP_SLOP_PX &&
        Math.abs(pageY - start.y) < TAP_SLOP_PX &&
        Date.now() - start.at < TAP_MAX_MS;
      if (still && !isScrollingRef.current) {
        const zone = pagedTapZone(pageX);
        if (zone !== 'center') {
          // Not counted toward the overlay's double tap.
          lastTapRef.current = 0;
          turnPage(zone === 'next' ? 1 : -1);
          return;
        }
      }
      handleReaderTap();
    },
    [handleReaderTap, turnPage],
  );

  // Auto-scroll (webtoon). A requestAnimationFrame loop that owns a float
  // position: scrollTop rounds to whole pixels, and adding 0.7 px a frame to
  // a rounded value at the slow speeds would never move. Any touch, wheel or
  // key pauses it for AUTO_SCROLL_RESUME_MS; it stops at the end card, and
  // flows on through chapters continuous reading attaches.
  const [autoScrolling, setAutoScrolling] = useState(false);
  useEffect(() => {
    if (readingMode !== 'scroll') setAutoScrolling(false);
  }, [readingMode]);
  useEffect(() => {
    if (!autoScrolling || readingMode !== 'scroll' || !focused || settingsOpen || askOpen) return;
    const speed = autoScrollPxPerSecond(prefs.autoScrollSpeed);
    pendingRestoreRef.current = null;
    let raf = 0;
    let last = Date.now();
    let position = scrollOffsetRef.current;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = Date.now();
      const dt = Math.min(100, now - last);
      last = now;
      if (now < autoScrollPausedUntilRef.current) {
        position = scrollOffsetRef.current;
        return;
      }
      if (atEndRef.current) {
        setAutoScrolling(false);
        return;
      }
      // Moved by something else (a seek, a chapter jump): continue from there.
      if (Math.abs(scrollOffsetRef.current - position) > 64) position = scrollOffsetRef.current;
      position += (speed * dt) / 1000;
      flatListRef.current?.scrollToOffset({ offset: position, animated: false });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [autoScrolling, readingMode, focused, settingsOpen, askOpen, prefs.autoScrollSpeed]);
  const toggleAutoScroll = useCallback(() => {
    autoScrollPausedUntilRef.current = 0;
    setAutoScrolling((on) => !on);
    scheduleHide();
  }, [scheduleHide]);

  // Keep the screen on while reading (Wake Lock on web, expo-keep-awake on
  // native), only while this screen is in front.
  useReaderKeepAwake(focused && prefs.keepAwake && !loading && rows.length > 0);

  // Resizing, rotating or changing the width or fit re-lays every row out;
  // keep the reader where they were rather than wherever that offset now
  // points.
  const activeChapterIdRef = useRef(activeChapterId);
  activeChapterIdRef.current = activeChapterId;
  const activePageIndexRef = useRef(activePageIndex);
  activePageIndexRef.current = activePageIndex;
  // Only what actually moves rows. The window height is in it only under Fit
  // height: on the web the reader's height follows the visual viewport, which
  // shrinks whenever the on-screen keyboard opens (typing in Ask Sakura) —
  // and re-landing for that threw the reader back to the top of the page
  // they were in the middle of. Paged rows are one window wide, so only the
  // width moves them.
  const geometryKey = isPaged
    ? `page:${winW}`
    : `${columnW}:${prefs.pageFit}:${pageGap}:${prefs.pageFit === 'height' ? winH : ''}:${
        prefs.pageFit === 'original' ? winW : ''
      }`;
  /** The layout as last committed, with its rows: what the reader's scroll offset refers to. */
  const committedLayoutRef = useRef<{ key: string; layout: ListLayout | null; rows: ReaderRow[] } | null>(null);
  // A layout effect, so it reads the scroll offset before the browser clamps
  // or anchors it against the new heights (that arrives as a scroll event
  // after this commit).
  useLayoutEffect(() => {
    const before = committedLayoutRef.current;
    committedLayoutRef.current = { key: geometryKey, layout: webtoonGeometry?.layout ?? null, rows };
    if (!before || before.key === geometryKey) return;
    if (!didInitialScroll.current || !activeChapterIdRef.current || pendingRestoreRef.current) return;
    // The row at the top of the screen in the old layout and how far into it
    // the reader was. Widths scale every row in proportion, so the same
    // fraction is the same spot on the page.
    let anchor: { rowId: string; fraction: number } | null = null;
    if (before.layout && webtoonGeometry) {
      const at = layoutAnchor(before.layout, scrollOffsetRef.current);
      const row = at ? before.rows[at.index] : undefined;
      if (at && row) anchor = { rowId: row.id, fraction: at.fraction };
    }
    pendingRestoreRef.current = {
      chapterId: activeChapterIdRef.current,
      page: activePageIndexRef.current,
      tries: 0,
      startedAt: Date.now(),
      ...(anchor ?? {}),
    };
    requestAnimationFrame(runPendingRestore);
  }, [geometryKey, webtoonGeometry, rows, runPendingRestore]);

  const endCard = lastSegment ? (
    <ChapterEndCard
      width={winW}
      height={isPaged ? winH : END_CARD_HEIGHT}
      chapterLabel={lastSegment.chapterLabel}
      next={
        endNext === undefined
          ? undefined
          : endNext === null
            ? null
            : {
                label: Number.isFinite(endNext.number) ? `Chapter ${endNext.number}` : endNext.title || 'Next chapter',
                detail:
                  endNext.title && endNext.title !== `Chapter ${endNext.number}` ? endNext.title : undefined,
              }
      }
      onNext={() => {
        if (endNext) openChapter(endNext);
      }}
      onBackToSeries={goBack}
      light={lightBackground}
      mirrored={isRtlPageMode}
    />
  ) : null;

  if (isGated && accessChecked && !hasAccess) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar hidden />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Back to series"
          onPress={onTap(goBack)}
          style={styles.backBtnAbsolute}
        >
          <BackIcon />
        </TouchableOpacity>
        <View style={styles.gateCard}>
          <View style={styles.gateIconWrap}>
            <GateLockIcon />
          </View>
          <Text style={styles.gateTitle}>Pass Required</Text>
          {/* Only reachable while AUTO_GATE_LATEST_CHAPTERS is on, which it is
              not — see lib/pass-gate.ts. Kept because flipping that flag back
              makes this the gate again, but the copy no longer promises to
              unlock "every other premium chapter": the pass gates no other
              content, so that claim was untrue. */}
          <Text style={styles.gateBody}>
            {address
              ? 'This chapter is behind the Sakura Monthly Pass.'
              : 'Connect your Sakura wallet and grab a Monthly Pass to read this chapter.'}
          </Text>
          {passExpiry ? (
            <Text style={styles.gateExpiry}>🎴 {formatPassTimeRemaining(passExpiry)}</Text>
          ) : null}
          <TouchableOpacity
            style={styles.gateBtn}
            activeOpacity={0.85}
            onPress={() => {
              playTap();
              router.push('/pass');
            }}
          >
            <Text style={styles.gateBtnText}>
              {address ? 'Get Monthly Pass' : 'Set Up Wallet'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (loading || !prefsReady) {
    // Not a bare spinner: the series and chapter are named at once and Back
    // works while the page list is out (it used to be a spinner and nothing
    // else for as long as the request took).
    const skeletonW = Math.min(columnW, 560);
    return (
      <View style={[styles.screen, { backgroundColor: background }]}>
        <StatusBar hidden />
        <View style={[styles.skeletonBar, { paddingTop: Math.max(insets.top, 12) + 8 }]}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Back to series"
            onPress={onTap(goBack)}
            style={styles.backBtn}
          >
            <BackIcon />
          </TouchableOpacity>
          <View style={styles.skeletonTitles}>
            {typeof title === 'string' && title ? (
              <Text style={styles.skeletonTitle} numberOfLines={1}>
                {title}
              </Text>
            ) : null}
            <Text style={styles.skeletonChapter} numberOfLines={1}>
              {routeChapterLabel}
            </Text>
          </View>
        </View>
        <View style={[styles.flex, styles.center]}>
          <View style={[styles.skeletonPage, { width: skeletonW, height: Math.min(skeletonW * 1.45, winH * 0.7) }]}>
            <ActivityIndicator size="large" color={lightBackground ? '#555' : Colors.white} />
            <Text style={[styles.skeletonHint, lightBackground && styles.skeletonHintLight]}>Loading pages…</Text>
          </View>
        </View>
      </View>
    );
  }

  if (rows.length === 0) {
    // A link without its series (`/chapter/<chapterId>`) cannot be loaded at
    // all; say so instead of offering a Retry that can never work.
    const incompleteLink = !mangaId || !entryChapterId;
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar hidden />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={incompleteLink ? 'Go home' : 'Back to series'}
          onPress={onTap(incompleteLink ? () => router.replace('/home') : goBack)}
          style={styles.backBtnAbsolute}
        >
          <BackIcon />
        </TouchableOpacity>
        <EmptyState
          inverted
          compact
          title={incompleteLink ? 'This chapter link is incomplete' : pageLoadError ? 'Chapter unavailable' : 'No pages found'}
          subtitle={incompleteLink ? 'Open the series to choose a chapter.' : pageLoadError || undefined}
        />
        {incompleteLink ? (
          <TouchableOpacity accessibilityRole="button" style={styles.pageRetry} onPress={() => router.replace('/home')}>
            <Text style={styles.pageRetryLabel}>Go home</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity accessibilityRole="button" style={styles.pageRetry} onPress={() => setLoadAttempt((attempt) => attempt + 1)}>
            <Text style={styles.pageRetryLabel}>Retry chapter</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // Where the list starts: with getItemLayout, FlatList renders the rows
  // around the saved page first instead of page 1. Captured once and kept:
  // VirtualizedList re-reads the prop on every render, and whenever it is
  // missing or 0 it keeps the first ten rows mounted for a fast scroll-to-top
  // — ten pages of images nobody resuming at page 60 is looking at. Kept
  // until a jump to the very top (releaseInitialIndex), which it would freeze.
  if (initialRowRef.current === null) {
    initialRowRef.current = rowIndexFor(bounds, entryChapterId, initialTarget);
  }
  const initialRow = initialRowRef.current;

  return (
    <View
      style={[styles.screen, { backgroundColor: background }]}
    >
      <StatusBar hidden />
      <FlatList
        ref={flatListRef}
        data={rows}
        // Mirrors the whole list for right-to-left paged reading; each page
        // un-mirrors itself in renderPage. This replaces reversing the data,
        // which cannot express per-chapter direction once a session holds more
        // than one chapter.
        style={isRtlPageMode ? styles.mirrored : undefined}
        keyExtractor={(p) => p.id}
        // Both modes: paged rows are one window wide; webtoon rows have the
        // heights computed in webtoonGeometry, which every rendered row uses.
        getItemLayout={getItemLayout}
        initialScrollIndex={initialIndexLive && initialRow > 0 ? initialRow : undefined}
        pagingEnabled={readingMode === 'page'}
        decelerationRate={readingMode === 'page' ? 'fast' : 'normal'}
        horizontal={readingMode === 'page'}
        snapToInterval={readingMode === 'page' ? winW : undefined}
        // Web handles taps with document listeners (dblclick for the overlay,
        // click for paged tap zones), so a tap on mobile web isn't counted
        // twice — once here and once there.
        onTouchStart={Platform.OS === 'web' ? undefined : onListTouchStart}
        onTouchEnd={Platform.OS === 'web' ? undefined : onListTouchEnd}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        // Second, independent trigger for attaching the next chapter. The
        // proximity check in the viewability callback normally gets there
        // first; this covers a short chapter that fits on one screen, where
        // viewability may never report a page far enough through it.
        onEndReached={() => {
          // Reaching the bottom of the loaded content means the furthest
          // chapter has been read to its end, which viewability can't always
          // establish on its own for a short chapter.
          // Arriving at the end by dragging the slider is not the same as
          // reading to it. Necessary but not sufficient — the guard on the
          // maxPage tracker below is the one that actually stops a scrub
          // counting as a read.
          const last = segmentsRef.current[segmentsRef.current.length - 1];
          if (last && !jumpSettling()) creditChapterComplete(last.chapterId);
          void ensureNextChapter();
        }}
        onEndReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => {
          isScrollingRef.current = true;
          userDragRef.current = true;
          dragStartOffsetRef.current = scrollOffsetRef.current;
          pauseAutoScroll();
          // The reader has taken the wheel; stop trying to re-land a seek or a
          // mode switch under them. runPendingRestore never nulls its anchor on
          // success, and it is wired to both onLayout and onContentSizeChange.
          pendingRestoreRef.current = null;
        }}
        onMomentumScrollEnd={settleScroll}
        onScrollEndDrag={() => {
          userDragRef.current = false;
          // A drag that ends without flinging emits no momentum event.
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          idleTimerRef.current = setTimeout(settleScroll, 120);
        }}
        // Solid on iOS, best-effort on Android — the explicit compensation in
        // ensurePrevChapter is what covers Android.
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        // Keeps the top of the list off true offset 0 whenever an earlier
        // chapter exists, so a prepend never has to fight an overscroll bounce.
        ListHeaderComponent={hasPrevChapter ? <View style={[styles.listHeaderSpacer, { backgroundColor: background }]} /> : null}
        // The end card: next chapter, caught up, or back to the series. Fixed
        // size (END_CARD_HEIGHT, or one page in paged mode) — onScroll's
        // end-of-session test counts on it.
        ListFooterComponent={endCard}
        // Tighter in webtoon mode: rows there are full-height strips and a
        // session can now hold several chapters of them, so keeping five
        // screens either side mounted is a lot of decoded bitmap.
        windowSize={readingMode === 'scroll' ? 3 : 5}
        maxToRenderPerBatch={3}
        removeClippedSubviews
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          listMetricsRef.current.view = readingMode === 'page' ? width : height;
          updateEndReached();
          runPendingRestore();
        }}
        onContentSizeChange={(width, height) => {
          listMetricsRef.current.content = readingMode === 'page' ? width : height;
          updateEndReached();
          runPendingRestore();
        }}
        onScrollToIndexFailed={(info) => {
          // Webtoon rows have variable heights and aren't measured yet, so the
          // first jump is only an estimate — land roughly, then retry precisely
          // once the rows around the target have been laid out. Without the
          // retry, resuming deep into a chapter dropped you at the wrong place.
          flatListRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          // Retry by page identity, not by replaying the index: the list can be
          // reordered or replaced in the 350ms gap (switching direction, or a
          // chapter finishing its load), and a stale index would then scroll to
          // the wrong page or throw.
          const targetId = rowsRef.current[info.index]?.id;
          setTimeout(() => {
            const index = targetId
              ? rowsRef.current.findIndex((pg) => pg.id === targetId)
              : info.index;
            if (index < 0) return; // that page is no longer in the list
            try {
              flatListRef.current?.scrollToIndex({ index, animated: false });
            } catch {
              // still unmeasured; the estimate above is close enough
            }
          }, 350);
        }}
        showsVerticalScrollIndicator={readingMode !== 'page'}
        showsHorizontalScrollIndicator={false}
        renderItem={renderPage}
      />

      {/* In-app dimmer (the brightness preference). Below the overlays so the
          controls stay readable, and never touchable. */}
      {prefs.brightness < 1 ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: 1 - prefs.brightness }]} />
      ) : null}

      {/* Top UI overlay */}
      <Animated.View
        style={[styles.topOverlay, overlayFadeStyle]}
        pointerEvents={uiInteractive ? 'auto' : 'none'}
        onTouchStart={noteUiTouch}
      >
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Back to series"
          onPress={onTap(goBack)}
          style={styles.backBtn}
        >
          <BackIcon />
        </TouchableOpacity>
        {/* Counts within the chapter on screen, not across the whole session —
            "page 14 of 3200" would be meaningless once neighbours attach. */}
        <Text style={styles.pageCount}>
          {activePageIndex + 1} / {activeTotalPages}
        </Text>
        {/* Opens layout / direction / continuity without leaving the chapter.
            Every change keeps your place and persists as the new default. */}
        {/* Ask about the chapter without leaving it. Hidden on adult sources:
            those titles must not reach an AI backend at all. Sits inside the
            overlay's Animated.View, so it inherits overlayFadeStyle and the
            parent's pointerEvents — it cannot become invisible-but-tappable. */}
        <View style={styles.topActions}>
          {!isAdult ? (
            <TouchableOpacity onPress={onTap(() => setAskOpen(true))} style={styles.askBtn}>
              <Text style={styles.askBtnText}>Ask</Text>
            </TouchableOpacity>
          ) : null}
          {/* Hands-free webtoon reading; speed lives in the Aa sheet. */}
          {readingMode === 'scroll' ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={autoScrolling ? 'Stop auto-scroll' : 'Start auto-scroll'}
              accessibilityState={{ selected: autoScrolling }}
              onPress={onTap(toggleAutoScroll)}
              style={[styles.modeBtn, autoScrolling && styles.modeBtnOn]}
            >
              <Text style={styles.modeBtnText}>{autoScrolling ? '❚❚ Auto' : '▶ Auto'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Reader settings"
            onPress={onTap(() => setSettingsOpen(true))}
            style={styles.modeBtn}
          >
            <Text style={styles.modeBtnText}>Aa</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* Page indicator strip — page/swipe mode only */}
      {!isAdult ? (
        <ReaderAskSheet
          visible={askOpen}
          onClose={() => setAskOpen(false)}
          context={aiContext}
          walletAddress={address ?? undefined}
          allowSpoilers={allowSpoilers}
          onChangeAllowSpoilers={setAllowSpoilers}
          dispatchExtra={askDispatch}
        />
      ) : null}

      <ReaderSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onAskSakura={
          isAdult
            ? undefined
            : () => {
                setSettingsOpen(false);
                setAskOpen(true);
              }
        }
        readingMode={readingMode}
        onChangeReadingMode={changeReadingMode}
        readDirection={readDirection}
        onChangeReadDirection={changeReadDirection}
        continuous={continuous}
        onChangeContinuous={(v) => {
          setContinuous(v);
          void AppSettings.setReaderContinuous(v);
        }}
        continuousBack={continuousBack}
        onChangeContinuousBack={(v) => {
          setContinuousBack(v);
          void AppSettings.setReaderContinuousBack(v);
        }}
        prefs={prefs}
        onChangePrefs={changePrefs}
        showWidthControls={winW > READER_MAX_WIDTH_MIN}
        dataSaver={dataSaver}
      />

      {/* Seek + chapter navigation. Replaces the thumbnail strip, which mounted
          one FULL-RESOLUTION Image per page of the chapter — the thumbnail used
          `page.url`, the identical string renderPage feeds the full-screen page,
          and loadChapterPages never rewrites it — and did so on chapter entry
          whether or not the overlay was ever painted.
          Deliberately NOT gated on readingMode: it defaults to 'scroll', so a
          paged-only bar would be invisible to most readers, and the chapter
          buttons work identically in both modes. */}
      {activeTotalPages > 0 ? (
        <Animated.View
          ref={overlayHostRef as never}
          style={[styles.bottomOverlay, { paddingBottom: insets.bottom + 6 }, overlayFadeStyle]}
          // box-none, not auto. The strip this replaces was paged-only, where
          // swipes start mid-screen. This band is full width and now present in
          // webtoon mode, where a vertical flick very often starts low on the
          // screen — with 'auto' the FlatList (a sibling, not an ancestor) would
          // never see those touches at all.
          pointerEvents={uiInteractive ? 'box-none' : 'none'}
          onTouchStart={noteUiTouch}
        >
          <ReaderChapterBar
            pageIndex={activePageIndex}
            totalPages={activeTotalPages}
            rtl={isRtlPageMode}
            modeLabel={modeLabel}
            onSeek={seekToPage}
            onSeekPreview={previewSeek}
            onSeekStart={holdUI}
            onSeekEnd={releaseUI}
            onPrevChapter={goPrevChapter}
            onNextChapter={goNextChapter}
            canGoPrev={adjacentChapters.prev != null}
            canGoNext={adjacentChapters.next != null}
            onOpenSettings={openSettings}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  /** A row the width of the window; the page box inside is centred in it. */
  pageRow: { alignItems: 'center' },
  pageRowPaged: { justifyContent: 'center' },
  skeletonBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  skeletonTitles: { flex: 1, minWidth: 0 },
  skeletonTitle: { color: Colors.white, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  skeletonChapter: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm, marginTop: 2 },
  skeletonPage: {
    maxWidth: '92%',
    borderRadius: 12,
    backgroundColor: 'rgba(127,127,127,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  skeletonHint: { color: 'rgba(255,255,255,0.7)', fontSize: FontSize.sm },
  skeletonHintLight: { color: 'rgba(0,0,0,0.6)' },
  topActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8 },
  modeBtnOn: { backgroundColor: 'rgba(232,69,69,0.85)' },
  pageRetry: { backgroundColor: '#E84545', borderRadius: 20, paddingHorizontal: 20, paddingVertical: 12 },
  pageRetryLabel: { color: '#fff', fontWeight: '600' },
  /** Applied to the list and re-applied per page, so RTL flips geometry only. */
  mirrored: { transform: [{ scaleX: -1 }] },
  listHeaderSpacer: { height: 48, backgroundColor: '#000' },
  chapterDivider: {
    // Width is the live window width, set inline; the height must stay
    // MARKER_HEIGHT for the webtoon layout.
    height: MARKER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
    backgroundColor: '#0A0A0A',
  },
  chapterDividerLight: { backgroundColor: '#F2F2F4' },
  chapterDividerRule: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.18)' },
  chapterDividerRuleLight: { backgroundColor: 'rgba(0,0,0,0.14)' },
  chapterDividerText: { alignItems: 'center', maxWidth: '70%' },
  chapterDividerKicker: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    fontWeight: FontWeight.bold,
    letterSpacing: 1.2,
  },
  chapterDividerKickerLight: { color: 'rgba(0,0,0,0.45)' },
  chapterDividerLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: FontWeight.semibold,
  },
  chapterDividerLabelLight: { color: 'rgba(0,0,0,0.75)' },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  backBtn: {
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: Radius.full,
  },
  backBtnAbsolute: {
    position: 'absolute',
    top: 52,
    left: 16,
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: Radius.full,
    zIndex: 5,
  },
  gateCard: {
    marginHorizontal: 32,
    alignItems: 'center',
    gap: 12,
  },
  gateIconWrap: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(88,86,214,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(123,121,232,0.35)',
    marginBottom: 4,
  },
  gateTitle: {
    color: Colors.white,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },
  gateBody: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: FontSize.sm,
    textAlign: 'center',
    lineHeight: 21,
  },
  gateExpiry: {
    color: '#9D9BF0',
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  gateBtn: {
    marginTop: 8,
    backgroundColor: '#5856D6',
    borderRadius: Radius.full,
    paddingHorizontal: 32,
    paddingVertical: 14,
    minWidth: 240,
    alignItems: 'center',
  },
  gateBtnText: {
    color: Colors.white,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
  },
  pageCount: {
    marginLeft: 10,
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  askBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(232,69,69,0.85)',
  },
  askBtnText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  modeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  modeBtnText: {
    color: Colors.white,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.bold,
  },
  bottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
});
