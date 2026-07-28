import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, Dimensions, TouchableOpacity, StatusBar, ActivityIndicator, InteractionManager, Platform, AppState, Animated, type ViewToken, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Colors, Radius, FontSize, FontWeight } from '@/constants/theme';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { loadChapterPages, fetchReaderChapterList } from '@/lib/chapter-pages';
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
import { setMangaReadProgress } from '@/lib/reader-progress';
import { recordReadingEvent } from '@/lib/gamification';
import EmptyState from '@/components/ui/EmptyState';
import ReaderSettingsSheet from '@/components/reader/ReaderSettingsSheet';
import ReaderChapterBar from '@/components/reader/ReaderChapterBar';
import { onTap, playTap } from '@/lib/sound';
import { useWallet } from '@/lib/wallet/context';
import { checkPassStatus, formatPassTimeRemaining, type PassStatus } from '@/lib/wallet/pass';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
// Fallback page aspect (height/width) used only until an image reports its real
// size. A manga page is ~1.5, but manhwa/webtoon pages are long vertical strips
// (often 3–15), so every page is measured and sized to its own ratio — assuming
// 1.5 for everything is what made manhwa pages render cropped.
const DEFAULT_PAGE_RATIO = 1.5;
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
  const [readingMode, setReadingMode] = useState<'page' | 'scroll'>('scroll');
  const [readDirection, setReadDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [continuous, setContinuous] = useState(true);
  const [continuousBack, setContinuousBack] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Real per-page aspect ratios (height/width), filled in as each image loads so
  // tall manhwa strips get their full height instead of being cropped to 1.5.
  const [pageRatios, setPageRatios] = useState<Record<string, number>>({});
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

  const handlePageLoad = useCallback((pageId: string, width?: number, height?: number) => {
    if (!width || !height) return;
    const ratio = height / width;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    setPageRatios((prev) => {
      const existing = prev[pageId];
      // Only re-render when the ratio meaningfully changes.
      if (existing && Math.abs(existing - ratio) < 0.01) return prev;
      return { ...prev, [pageId]: ratio };
    });
  }, []);

  const tildeIdx = (id || '').indexOf('~');
  const mangaId = tildeIdx >= 0 ? id!.slice(0, tildeIdx) : '';
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

  const mangaTitle = typeof title === 'string' ? title : 'Manga';
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
    setAccessChecked(false);
    (async () => {
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
  }, [isGated, address]);

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
      try {
        // Offline is resolved per chapter inside loadChapterPages by asking the
        // store, so the route's `offline` param is no longer consulted here.
        // That also means a chapter opened from Continue Reading — which never
        // passes the param — now reads from disk instead of refetching.
        const { urls, origin } = await loadChapterPages({
          contentId: mangaId,
          chapterId: entryChapterId,
          source,
        });
        if (cancelled) return;
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
      } catch {
        if (!cancelled) setSegments([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mangaId, entryChapterId, source, routeChapterLabel, isGated, hasAccess]);

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
        // Opacity is native-drivable, and on web react-native-web falls back to
        // its own timing loop.
        useNativeDriver: true,
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

  /** Scroll to a flattened row index. No RTL mapping — the list is mirrored. */
  const jumpToRow = useCallback(
    (rowIndex: number, animated = false) => {
      const total = rowsRef.current.length;
      if (total === 0) return;
      const index = Math.min(Math.max(rowIndex, 0), total - 1);
      if (readingMode === 'page') {
        // Uniform page width, so offset math is exact.
        flatListRef.current?.scrollToOffset({ offset: SCREEN_WIDTH * index, animated });
      } else {
        // Webtoon mode has variable page heights — let FlatList resolve the
        // index itself (onScrollToIndexFailed covers unmeasured items).
        flatListRef.current?.scrollToIndex({ index, animated });
      }
    },
    [readingMode],
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

  useEffect(() => {
    if (loading || rows.length === 0 || didInitialScroll.current) return;
    const target = Math.min(Math.max(requestedPage - 1, 0), Math.max(activeTotalPages - 1, 0));
    requestAnimationFrame(() => {
      // Latch only on SUCCESS. The chapter buttons replace the route without
      // unmounting, so this effect fires once while the old chapter is still the
      // only resident one: rowIndexFor returns -1 for the new chapter, the jump
      // is a no-op, and latching anyway meant the new chapter was never scrolled
      // to at all — the list kept its native offset across the data swap, so
      // "next chapter" from page 30 of 40 opened the next one near its end.
      if (jumpToChapterPage(entryChapterId, target, false)) didInitialScroll.current = true;
    });
  }, [loading, requestedPage, rows.length, activeTotalPages, entryChapterId, jumpToChapterPage]);

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
        if (at < 0 || at === segment.orderIndex) return segment;
        changed = true;
        const chapter = orderedChapters[at];
        return {
          ...segment,
          orderIndex: at,
          chapterNumber: chapter.number,
          chapterLabel: chapter.title || segment.chapterLabel,
        };
      });
      return changed ? next.sort((a, b) => a.orderIndex - b.orderIndex) : prev;
    });
  }, [orderedChapters]);
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
      const { urls, origin } = await loadChapterPages({
        contentId: mangaId,
        chapterId: next.id,
        source,
      });
      if (urls.length === 0) return;
      // Warm the first few images so the boundary doesn't arrive as blank space.
      urls.slice(0, 3).forEach((u) => {
        void Image.prefetch(u).catch(() => undefined);
      });
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
  }, [mangaId, source]);

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

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { x, y } = e.nativeEvent.contentOffset;
      scrollOffsetRef.current = readingMode === 'page' ? x : y;
      isScrollingRef.current = true;
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
    [readingMode, settleScroll],
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
      const { urls, origin } = await loadChapterPages({
        contentId: mangaId,
        chapterId: prev.id,
        source,
      });
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
                offset: offsetBefore + insertedRows * SCREEN_WIDTH,
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
  }, [mangaId, source, readingMode]);

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
    // A divider carries no page of its own; the chapter change is the signal.
    if (row.kind === 'page') setActivePageIndex(row.pageIndex);

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

  const renderPage = useCallback(
    ({ item }: { item: ReaderRow }) => {
      if (item.kind === 'marker') {
        // A labelled hairline, not a card: the ask was that crossing into the
        // next chapter shouldn't feel like a stop, while still saying where you
        // are. Only ever rendered in webtoon mode.
        return (
          <View style={styles.chapterDivider}>
            <View style={styles.chapterDividerRule} />
            <Text style={styles.chapterDividerLabel}>{item.label}</Text>
            <View style={styles.chapterDividerRule} />
          </View>
        );
      }
      // Paged mode: one full screen per page, letterboxed so the whole page fits.
      if (readingMode === 'page') {
        return (
          <Image
            source={{ uri: item.url }}
            // Un-mirrors the list's scaleX in RTL so the artwork reads the right
            // way round while the geometry stays left-to-right.
            style={[
              { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
              isRtlPageMode && styles.mirrored,
            ]}
            contentFit="contain"
            transition={0}
            recyclingKey={item.id}
            onLoad={(e) => handlePageLoad(item.id, e?.source?.width, e?.source?.height)}
          />
        );
      }
      // Scroll (webtoon) mode: height follows the image's own aspect ratio, so a
      // long manhwa strip renders in full instead of being cropped.
      const ratio = pageRatios[item.id] ?? DEFAULT_PAGE_RATIO;
      return (
        <Image
          source={{ uri: item.url }}
          style={{ width: SCREEN_WIDTH, height: SCREEN_WIDTH * ratio }}
          contentFit="contain"
          transition={0}
          recyclingKey={item.id}
          onLoad={(e) => handlePageLoad(item.id, e?.source?.width, e?.source?.height)}
        />
      );
    },
    [readingMode, isRtlPageMode, pageRatios, handlePageLoad],
  );


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
    if (stillOnEntryChapter && page < 2 && activeTotalPages > 3) return;
    const t = setTimeout(() => {
      void setMangaReadProgress({
        mangaId,
        chapterId: activeChapterId,
        title: mangaTitle,
        cover: mangaCover,
        chapterLabel,
        page,
        totalPages: activeTotalPages,
        source: typeof source === 'string' ? source : undefined,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [
    mangaId,
    activeChapterId,
    entryChapterId,
    activePageIndex,
    activeTotalPages,
    mangaTitle,
    mangaCover,
    chapterLabel,
    isAdult,
    source,
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
            title: mangaTitle,
            cover: mangaCover,
            chapterLabel,
            page: activePageIndex + 1,
            totalPages: activeTotalPages,
            source: typeof source === 'string' ? source : undefined,
          }
        : null;
  });

  useEffect(() => {
    return () => {
      // Never persist 18+ progress or touch the shared reading-activity record
      // (clearing it here would wipe a legitimate manga/comic session).
      if (suppressProgressRef.current) return;
      if (progressRef.current) void setMangaReadProgress(progressRef.current);
      endReadingActivity();
    };
  }, []);

  // ── Reading gamification: one event per chapter actually read. ──
  //
  // Tracked per chapter rather than once for the whole session. Reading five
  // chapters in one sitting is now normal, and a single exit event would credit
  // the reader for one — losing four chapters of XP and streak progress.
  // Everything is ref-held so the unmount handler can see it.
  type ChapterStat = { startedAt: number; maxPage: number; total: number };
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
    if (seekingRef.current) return;
    const stats = chapterStatsRef.current;
    const existing = stats.get(activeChapterId);
    if (!existing) {
      stats.set(activeChapterId, {
        startedAt: Date.now(),
        maxPage: activePageIndex + 1,
        total: activeTotalPages,
      });
      return;
    }
    // Furthest page reached, not the current one — scrolling back up must not
    // reduce how much of the chapter counts as read.
    existing.maxPage = Math.max(existing.maxPage, activePageIndex + 1);
    existing.total = activeTotalPages;
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
      if (from && to && to.orderIndex > from.orderIndex && !seekingRef.current) {
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
    // is just a scroll, so over-trying costs nothing and the last one wins.
    if (pending.tries > 6) {
      pendingRestoreRef.current = null;
      return;
    }
    jumpToChapterPage(pending.chapterId, pending.page, false);
  }, [jumpToChapterPage]);

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
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onDoubleClick = (e: MouseEvent) => {
      // A double click on the overlay's own controls is aimed at them, not at
      // dismissing the thing they live in.
      if (uiVisibleRef.current && e.target instanceof Node && overlayHostRef.current?.contains(e.target)) {
        return;
      }
      toggleUI();
    };
    document.addEventListener('dblclick', onDoubleClick);
    return () => document.removeEventListener('dblclick', onDoubleClick);
  }, [toggleUI]);

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
      for (let k = pageIndex - 1; k <= pageIndex + 2; k += 1) {
        const pg = segment.pages[k];
        if (pg) void Image.prefetch(pg.url).catch(() => undefined);
      }
      if (readingMode === 'scroll') {
        // Webtoon has no getItemLayout, so scrollToIndex past the measured
        // frontier bails to onScrollToIndexFailed and lands on an estimate;
        // rows then re-measure as images load and replace the default ratio with
        // real 3-15 ones. Re-land from every layout pass instead — the exact
        // mechanism the mode switch already uses. A user drag cancels it.
        pendingRestoreRef.current = { chapterId: segment.chapterId, page: pageIndex, tries: 0 };
      } else {
        pendingRestoreRef.current = null;
      }
      jumpToChapterPage(segment.chapterId, pageIndex, false);
    },
    [activeSegment, markSeeking, readingMode, jumpToChapterPage],
  );

  /** Warm where the finger pauses, not every page it sweeps over. */
  const previewSeek = useCallback(
    (pageIndex: number) => {
      if (readingMode !== 'page') return; // webtoon rows stream in on scroll anyway
      const segment = activeSegment;
      if (!segment) return;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        [pageIndex, pageIndex + 1, pageIndex - 1].forEach((k) => {
          const pg = segment.pages[k];
          if (pg) void Image.prefetch(pg.url).catch(() => undefined);
        });
      }, 140);
    },
    [activeSegment, readingMode],
  );

  /** The chapters either side of the one on screen, from the normalised list. */
  const adjacentChapters = useMemo(() => {
    const at = orderedChapters.findIndex((c) => c.id === activeChapterId);
    if (at < 0) return { prev: null, next: null };
    return { prev: orderedChapters[at - 1] ?? null, next: orderedChapters[at + 1] ?? null };
  }, [orderedChapters, activeChapterId]);

  const goToAdjacentChapter = useCallback(
    (dir: -1 | 1) => {
      const target = dir === 1 ? adjacentChapters.next : adjacentChapters.prev;
      if (!target) return;
      markSeeking(); // a button press is a skip, never a completed read
      scheduleHide();
      // Continuous reading has usually already attached the neighbour, in which
      // case this is a scroll rather than a load.
      if (segmentsRef.current.some((s) => s.chapterId === target.id)) {
        if (readingMode === 'scroll') {
          pendingRestoreRef.current = { chapterId: target.id, page: 0, tries: 0 };
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
    [
      adjacentChapters,
      jumpToChapterPage,
      mangaId,
      markSeeking,
      readingMode,
      router,
      scheduleHide,
      title,
      cover,
      source,
    ],
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

  // The strip was also an accidental whole-chapter prefetch. Replace it with a
  // bounded, forward-looking one. Skipped while seeking so it doesn't compete
  // with seekToPage's own target warm.
  useEffect(() => {
    if (readingMode !== 'page' || !activeSegment || seekingRef.current) return;
    activeSegment.pages.slice(activePageIndex + 1, activePageIndex + 4).forEach((pg) => {
      void Image.prefetch(pg.url).catch(() => undefined);
    });
  }, [activeSegment, activePageIndex, readingMode]);

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

  if (isGated && accessChecked && !hasAccess) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar hidden />
        <TouchableOpacity onPress={onTap(() => router.back())} style={styles.backBtnAbsolute}>
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

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color={Colors.white} />
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={[styles.screen, styles.center]}>
        <StatusBar hidden />
        <TouchableOpacity onPress={onTap(() => router.back())} style={styles.backBtn}>
          <BackIcon />
        </TouchableOpacity>
        <EmptyState inverted compact title="No pages found" />
      </View>
    );
  }

  return (
    <View
      style={styles.screen}
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
        // Only valid in paged mode (uniform width). Webtoon pages have their own
        // heights, so FlatList must measure them instead of assuming a constant.
        getItemLayout={
          readingMode === 'page'
            ? (_, index) => ({ length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index })
            : undefined
        }
        pagingEnabled={readingMode === 'page'}
        decelerationRate={readingMode === 'page' ? 'fast' : 'normal'}
        horizontal={readingMode === 'page'}
        snapToInterval={readingMode === 'page' ? SCREEN_WIDTH : undefined}
        // Web drives the toggle from pointerdown on the root instead, so that a
        // tap on mobile web isn't counted twice — once here and once there,
        // which would turn a single tap into a toggle.
        onTouchEnd={Platform.OS === 'web' ? undefined : handleReaderTap}
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
          if (last && !seekingRef.current) creditChapterComplete(last.chapterId);
          void ensureNextChapter();
        }}
        onEndReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => {
          isScrollingRef.current = true;
          userDragRef.current = true;
          dragStartOffsetRef.current = scrollOffsetRef.current;
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
        ListHeaderComponent={hasPrevChapter ? <View style={styles.listHeaderSpacer} /> : null}
        // Tighter in webtoon mode: rows there are full-height strips and a
        // session can now hold several chapters of them, so keeping five
        // screens either side mounted is a lot of decoded bitmap.
        windowSize={readingMode === 'scroll' ? 3 : 5}
        maxToRenderPerBatch={3}
        removeClippedSubviews
        onLayout={runPendingRestore}
        onContentSizeChange={runPendingRestore}
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

      {/* Top UI overlay */}
      <Animated.View
        style={[styles.topOverlay, overlayFadeStyle]}
        pointerEvents={uiInteractive ? 'auto' : 'none'}
        onTouchStart={noteUiTouch}
      >
        <TouchableOpacity
          onPress={onTap(() => {
            clearHideTimer();
            router.back();
          })}
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
        <TouchableOpacity onPress={onTap(() => setSettingsOpen(true))} style={styles.modeBtn}>
          <Text style={styles.modeBtnText}>Aa</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Page indicator strip — page/swipe mode only */}
      <ReaderSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
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
  center: { alignItems: 'center', justifyContent: 'center' },
  /** Applied to the list and re-applied per page, so RTL flips geometry only. */
  mirrored: { transform: [{ scaleX: -1 }] },
  listHeaderSpacer: { height: 48, backgroundColor: '#000' },
  chapterDivider: {
    width: SCREEN_WIDTH,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 32,
    backgroundColor: '#0A0A0A',
  },
  chapterDividerRule: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.18)' },
  chapterDividerLabel: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    fontWeight: FontWeight.semibold,
  },
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
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  modeBtn: {
    marginLeft: 'auto',
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
