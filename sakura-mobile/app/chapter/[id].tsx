import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ScrollView, Dimensions, TouchableOpacity, StatusBar, ActivityIndicator, type ViewToken } from 'react-native';
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
import { fetchMangaChapterPages } from '@/lib/manga';
import { fetchComicPages } from '@/lib/comics';
import { fetchHentaiPages } from '@/lib/hentai';
import { upsertReadingActivity, endReadingActivity } from '@/lib/reading-activity';
import { AppSettings } from '@/lib/settings';
import { setMangaReadProgress } from '@/lib/reader-progress';
import { recordReadingEvent } from '@/lib/gamification';
import { getOfflineMangaPageUris } from '@/lib/manga-offline';
import { getScrapedOfflinePageUris } from '@/lib/scraped-offline';
import EmptyState from '@/components/ui/EmptyState';
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
  const isComics = source === 'comics';
  const isHentai = source === 'hentai';
  // External droplet-scraped sources: no offline downloads, no pass-gating.
  const isExternal = isComics || isHentai;
  const isGated = gated === '1' && !isExternal;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { address } = useWallet();

  const [accessChecked, setAccessChecked] = useState(!isGated);
  const [hasAccess, setHasAccess] = useState(!isGated);
  const [passExpiry, setPassExpiry] = useState<Date | null>(null);
  const flatListRef = useRef<FlatList<{ id: string; url: string }>>(null);
  const indicatorRef = useRef<ScrollView>(null);
  const didInitialScroll = useRef(false);
  const pageCountRef = useRef(0);
  const isRtlRef = useRef(false);
  const [pages, setPages] = useState<{ id: string; url: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [readingMode, setReadingMode] = useState<'page' | 'scroll'>('scroll');
  const [readDirection, setReadDirection] = useState<'ltr' | 'rtl'>('ltr');
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
  const chapterId = tildeIdx >= 0 ? id!.slice(tildeIdx + 1) : '';
  const parsedRequested = Number(p);
  const requestedPage = Number.isFinite(parsedRequested) && parsedRequested > 0 ? parsedRequested : 1;

  useEffect(() => {
    AppSettings.getMangaReadingMode()
      .then((mode) => setReadingMode(mode === 'page' ? 'page' : 'scroll'))
      .catch(() => setReadingMode('scroll'));
    AppSettings.getReadDirection()
      .then((direction) => setReadDirection(direction === 'rtl' ? 'rtl' : 'ltr'))
      .catch(() => setReadDirection('ltr'));
  }, []);

  const isRtlPageMode = readingMode === 'page' && readDirection === 'rtl';
  isRtlRef.current = isRtlPageMode;
  const renderedPages = useMemo(
    () => (isRtlPageMode ? [...pages].reverse() : pages),
    [isRtlPageMode, pages],
  );

  const mapSourceToRenderedIndex = (sourceIndex: number, total: number) => {
    if (!isRtlPageMode) return sourceIndex;
    return total - 1 - sourceIndex;
  };

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
    if (!mangaId || !chapterId) {
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
      if (offline === '1' && !isExternal) {
        const local = await getOfflineMangaPageUris(mangaId, chapterId);
        if (cancelled) return;
        if (local?.length) {
          setPages(local.map((uri, i) => ({ id: `page-${i}`, url: uri })));
          setLoading(false);
          return;
        }
      }

      if (isExternal) {
        if (offline === '1') {
          const local = await getScrapedOfflinePageUris(isHentai ? 'hentai' : 'comics', mangaId, chapterId);
          if (cancelled) return;
          if (local?.length) {
            setPages(local.map((uri, i) => ({ id: `page-${i}`, url: uri })));
            setLoading(false);
            return;
          }
        }
        try {
          const urls = isHentai
            ? await fetchHentaiPages(mangaId, chapterId)
            : await fetchComicPages(mangaId, chapterId);
          if (!cancelled) {
            setPages(urls.map((url, i) => ({ id: `page-${i}`, url })).filter((pg) => pg.url));
          }
        } catch {
          if (!cancelled) setPages([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      try {
        const urls = await fetchMangaChapterPages(mangaId, chapterId);
        if (!cancelled) {
          setPages(urls.map((url, i) => ({ id: `page-${i}`, url })).filter((pg) => pg.url));
        }
      } catch {
        if (!cancelled) setPages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mangaId, chapterId, offline, isExternal, isHentai, isGated, hasAccess]);

  const uiStyle = useAnimatedStyle(() => ({ opacity: uiOpacity.value }));

  useEffect(() => {
    if (loading || renderedPages.length === 0) return;
    // 18+ reading is never surfaced in Continue Reading or lock-screen activity
    // (it would leak past the settings toggle and the reopen path has no source).
    if (isHentai) return;
    const pageNumber = currentPage + 1;
    const total = renderedPages.length;
    upsertReadingActivity(
      {
        title: 'Manga Reader',
        subtitle: chapterId ? `Chapter ${chapterId}` : 'Reading chapter',
        progressText: `${pageNumber}/${total}`,
        progressPercent: total > 0 ? pageNumber / total : 0,
        kind: 'manga',
      },
      id
        ? `sakura://chapter/${id}?p=${pageNumber}` +
          (source ? `&source=${source}` : '') +
          (offline === '1' ? '&offline=1' : '')
        : undefined,
    );
  }, [chapterId, currentPage, id, loading, renderedPages.length, isHentai, source, offline]);

  useEffect(() => {
    didInitialScroll.current = false;
  }, [mangaId, chapterId]);

  const jumpToPage = useCallback(
    (sourceIndex: number, animated = false) => {
      if (renderedPages.length === 0) return;
      const clamped = Math.min(Math.max(sourceIndex, 0), renderedPages.length - 1);
      const renderedIdx = mapSourceToRenderedIndex(clamped, renderedPages.length);
      if (readingMode === 'page') {
        // Uniform page width, so offset math is exact.
        flatListRef.current?.scrollToOffset({ offset: SCREEN_WIDTH * renderedIdx, animated });
      } else {
        // Webtoon mode has variable page heights — let FlatList resolve the
        // index itself (onScrollToIndexFailed covers unmeasured items).
        flatListRef.current?.scrollToIndex({ index: renderedIdx, animated });
      }
      setCurrentPage(clamped);
    },
    [isRtlPageMode, readingMode, renderedPages.length],
  );

  useEffect(() => {
    if (loading || renderedPages.length === 0 || didInitialScroll.current) return;
    const sourceTarget = Math.min(Math.max(requestedPage - 1, 0), renderedPages.length - 1);
    requestAnimationFrame(() => {
      jumpToPage(sourceTarget, false);
      didInitialScroll.current = true;
    });
  }, [loading, requestedPage, renderedPages.length, jumpToPage]);

  pageCountRef.current = renderedPages.length;

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const renderedIndex = Number(viewableItems[0]?.index ?? -1);
    if (renderedIndex < 0) return;
    const total = pageCountRef.current;
    if (total === 0) return;
    const sourceIndex = isRtlRef.current ? total - 1 - renderedIndex : renderedIndex;
    if (sourceIndex >= 0) setCurrentPage(sourceIndex);
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const renderPage = useCallback(
    ({ item }: { item: { id: string; url: string } }) => {
      // Paged mode: one full screen per page, letterboxed so the whole page fits.
      if (readingMode === 'page') {
        return (
          <Image
            source={{ uri: item.url }}
            style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}
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
    [readingMode, pageRatios, handlePageLoad],
  );

  const mangaTitle = typeof title === 'string' ? title : 'Manga';
  const mangaCover = typeof cover === 'string' ? cover : undefined;
  const chapterLabel =
    typeof chapter === 'string' && chapter
      ? chapter
      : chapterId
        ? `Chapter ${chapterId}`
        : 'Chapter';

  useEffect(() => {
    if (!mangaId || !chapterId || renderedPages.length === 0) return;
    // 18+ reading progress is never persisted (keeps it out of Continue Reading).
    if (isHentai) return;
    const page = currentPage + 1;
    if (page < 2 && renderedPages.length > 3) return;
    const t = setTimeout(() => {
      void setMangaReadProgress({
        mangaId,
        chapterId,
        title: mangaTitle,
        cover: mangaCover,
        chapterLabel,
        page,
        totalPages: renderedPages.length,
        source: typeof source === 'string' ? source : undefined,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [
    mangaId,
    chapterId,
    currentPage,
    renderedPages.length,
    mangaTitle,
    mangaCover,
    chapterLabel,
    isHentai,
    source,
  ]);

  useEffect(() => {
    return () => {
      // Never persist 18+ progress or touch the shared reading-activity record
      // (clearing it here would wipe a legitimate manga/comic session).
      if (isHentai) return;
      if (mangaId && chapterId && renderedPages.length > 0) {
        void setMangaReadProgress({
          mangaId,
          chapterId,
          title: mangaTitle,
          cover: mangaCover,
          chapterLabel,
          page: currentPage + 1,
          totalPages: renderedPages.length,
          source: typeof source === 'string' ? source : undefined,
        });
      }
      endReadingActivity();
    };
  }, []);

  // ── Reading gamification: report the read on exit (dwell + completion). ──
  const gamStartRef = useRef(Date.now());
  const gamPageRef = useRef(0);
  const gamTotalRef = useRef(0);
  useEffect(() => {
    gamStartRef.current = Date.now();
  }, [chapterId]);
  useEffect(() => {
    gamPageRef.current = currentPage + 1;
    gamTotalRef.current = renderedPages.length;
  });
  useEffect(() => {
    return () => {
      if (isHentai || !mangaId || !chapterId) return;
      const total = gamTotalRef.current;
      if (total <= 0) return;
      const progress = Math.min(1, gamPageRef.current / total);
      void recordReadingEvent({
        kind: 'manga',
        contentId: mangaId,
        chapterId,
        seriesId: mangaId,
        progress,
        dwellMs: Date.now() - gamStartRef.current,
        completed: progress >= 0.9,
      });
    };
  }, [mangaId, chapterId, isHentai]);

  // Switch reading mode in place: remember where you are, flip the mode, then
  // restore that same page once the list has re-laid-out in the new geometry.
  const toggleReadingMode = useCallback(() => {
    const next = readingMode === 'page' ? 'scroll' : 'page';
    const keepPage = currentPage;
    setReadingMode(next);
    void AppSettings.setMangaReadingMode(next);
    didInitialScroll.current = true; // don't let the initial-scroll effect fight us
    requestAnimationFrame(() => {
      setTimeout(() => jumpToPage(keepPage, false), 120);
    });
  }, [readingMode, currentPage, jumpToPage]);

  const toggleUI = () => {
    const next = !uiVisible;
    setUiVisible(next);
    uiOpacity.value = withTiming(next ? 1 : 0, { duration: 200 });
  };

  useEffect(() => {
    if (!indicatorRef.current || pages.length === 0) return;
    const x = currentPage * THUMB_STEP - SCREEN_WIDTH / 2 + THUMB_W / 2 + 12;
    indicatorRef.current.scrollTo({ x: Math.max(0, x), animated: false });
  }, [currentPage, pages.length]);

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
          <Text style={styles.gateBody}>
            {address
              ? 'This is one of the latest chapters. Unlock it (and every other premium chapter) with a Sakura Monthly Pass.'
              : 'Connect your Sakura wallet and grab a Monthly Pass to read the latest chapters.'}
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

  if (renderedPages.length === 0) {
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
        data={renderedPages}
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
        windowSize={5}
        maxToRenderPerBatch={3}
        removeClippedSubviews
        onScrollToIndexFailed={(info) => {
          // Webtoon rows have variable heights and aren't measured yet, so the
          // first jump is only an estimate — land roughly, then retry precisely
          // once the rows around the target have been laid out. Without the
          // retry, resuming deep into a chapter dropped you at the wrong place.
          flatListRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          setTimeout(() => {
            try {
              flatListRef.current?.scrollToIndex({ index: info.index, animated: false });
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
        <Text style={styles.pageCount}>{currentPage + 1} / {renderedPages.length}</Text>
        {/* Switch webtoon <-> paged without leaving the chapter. Keeps your
            place across the switch and persists as the new default. */}
        <TouchableOpacity onPress={onTap(toggleReadingMode)} style={styles.modeBtn}>
          <Text style={styles.modeBtnText}>
            {readingMode === 'page' ? 'Paged' : 'Scroll'}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Page indicator strip — page/swipe mode only */}
      {readingMode === 'page' && pages.length > 0 && (
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
            {pages.map((page, i) => {
              const active = i === currentPage;
              return (
                <TouchableOpacity
                  key={page.id}
                  activeOpacity={0.75}
                  onPress={() => jumpToPage(i, false)}
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
