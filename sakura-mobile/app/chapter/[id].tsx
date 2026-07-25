import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ScrollView, Dimensions, TouchableOpacity, StatusBar, ActivityIndicator, InteractionManager, Platform, type ViewToken, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
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
import { onTap, playTap } from '@/lib/sound';
import { useWallet } from '@/lib/wallet/context';
import { checkPassStatus, formatPassTimeRemaining, type PassStatus } from '@/lib/wallet/pass';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
// Fallback page aspect (height/width) used only until an image reports its real
// size. A manga page is ~1.5, but manhwa/webtoon pages are long vertical strips
// (often 3–15), so every page is measured and sized to its own ratio — assuming
// 1.5 for everything is what made manhwa pages render cropped.
const DEFAULT_PAGE_RATIO = 1.5;
const THUMB_W = 44;
const THUMB_H = 60;
const THUMB_GAP = 8;
const THUMB_STEP = THUMB_W + THUMB_GAP;

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
  const indicatorRef = useRef<ScrollView>(null);
  const didInitialScroll = useRef(false);
  // One entry per chapter resident in this session, always in reading order.
  const [segments, setSegments] = useState<ChapterSegment[]>([]);
  // The series' full chapter list, normalised. Empty means continuous reading
  // is simply off and the reader behaves exactly as it always did.
  const [orderedChapters, setOrderedChapters] = useState<MangaChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
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
  const uiOpacity = useSharedValue(1);

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

  const uiStyle = useAnimatedStyle(() => ({ opacity: uiOpacity.value }));

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
    (chapterId: string, pageIndex: number, animated = false) => {
      const rowIndex = rowIndexFor(boundsRef.current, chapterId, pageIndex);
      if (rowIndex < 0) return;
      jumpToRow(rowIndex, animated);
      setActiveChapterId(chapterId);
      setActivePageIndex(pageIndex);
    },
    [jumpToRow],
  );

  useEffect(() => {
    if (loading || rows.length === 0 || didInitialScroll.current) return;
    const target = Math.min(Math.max(requestedPage - 1, 0), Math.max(activeTotalPages - 1, 0));
    requestAnimationFrame(() => {
      jumpToChapterPage(entryChapterId, target, false);
      didInitialScroll.current = true;
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
  const scrollOffsetRef = useRef(0);
  const isScrollingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrependRef = useRef(false);
  /** True between a prepend and its compensating scroll landing. */
  const anchorPendingRef = useRef(false);
  const firstVisibleIdRef = useRef<string | null>(null);

  const settleScroll = useCallback(() => {
    isScrollingRef.current = false;
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
            } else if (Platform.OS === 'android' && anchorId) {
              // Variable heights: re-anchor on the row that was on screen.
              // maintainVisibleContentPosition already handles this on iOS;
              // on Android it is unreliable, and landing the anchor at the top
              // of the viewport is a bounded correction rather than an exact
              // one — it can shift by however far that row was already scrolled.
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
    if (index <= 3) void ensurePrevRef.current();
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
      if (from && to && to.orderIndex > from.orderIndex) creditChapterComplete(previous);
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

  const toggleUI = () => {
    const next = !uiVisible;
    setUiVisible(next);
    uiOpacity.value = withTiming(next ? 1 : 0, { duration: 200 });
  };

  useEffect(() => {
    if (!indicatorRef.current || activeTotalPages === 0) return;
    const x = activePageIndex * THUMB_STEP - SCREEN_WIDTH / 2 + THUMB_W / 2 + 12;
    indicatorRef.current.scrollTo({ x: Math.max(0, x), animated: false });
  }, [activePageIndex, activeTotalPages]);

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
    <View style={styles.screen}>
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
        onTouchEnd={toggleUI}
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
          const last = segmentsRef.current[segmentsRef.current.length - 1];
          if (last) creditChapterComplete(last.chapterId);
          void ensureNextChapter();
        }}
        onEndReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => {
          isScrollingRef.current = true;
        }}
        onMomentumScrollEnd={settleScroll}
        onScrollEndDrag={() => {
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
      <Animated.View style={[styles.topOverlay, uiStyle]} pointerEvents={uiVisible ? 'auto' : 'none'}>
        <TouchableOpacity onPress={onTap(() => router.back())} style={styles.backBtn}>
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

      {/* Scoped to the active chapter: a strip spanning every resident chapter
          would be thousands of un-virtualised thumbnails. */}
      {readingMode === 'page' && activeTotalPages > 0 && (
        <Animated.View
          style={[styles.indicatorWrap, { bottom: insets.bottom + 8 }, uiStyle]}
          pointerEvents={uiVisible ? 'auto' : 'none'}
        >
          <ScrollView
            ref={indicatorRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.indicatorList}
          >
            {(activeSegment?.pages ?? []).map((page, i) => {
              const active = i === activePageIndex;
              return (
                <TouchableOpacity
                  key={page.id}
                  activeOpacity={0.75}
                  onPress={() => jumpToChapterPage(page.chapterId, i, false)}
                >
                  <Image
                    source={{ uri: page.url }}
                    style={[styles.thumb, active && styles.thumbActive]}
                    contentFit="cover"
                  />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </Animated.View>
      )}
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
  indicatorWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingVertical: 10,
  },
  indicatorList: {
    paddingHorizontal: 12,
    gap: THUMB_GAP,
    alignItems: 'center',
  },
  thumb: {
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  thumbActive: {
    borderColor: '#FFFFFF',
  },
});
