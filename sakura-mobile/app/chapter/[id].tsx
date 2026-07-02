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
import { upsertReadingActivity, endReadingActivity } from '@/lib/reading-activity';
import { AppSettings } from '@/lib/settings';
import { setMangaReadProgress } from '@/lib/reader-progress';
import { getOfflineMangaPageUris } from '@/lib/manga-offline';
import EmptyState from '@/components/ui/EmptyState';
import { onTap, playTap } from '@/lib/sound';
import { useWallet } from '@/lib/wallet/context';
import { checkPassStatus, formatPassTimeRemaining, type PassStatus } from '@/lib/wallet/pass';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const PAGE_HEIGHT = SCREEN_WIDTH * 1.5;
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
  const isGated = gated === '1' && !isComics;
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
  const uiOpacity = useSharedValue(1);

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
      if (offline === '1' && !isComics) {
        const local = await getOfflineMangaPageUris(mangaId, chapterId);
        if (cancelled) return;
        if (local?.length) {
          setPages(local.map((uri, i) => ({ id: `page-${i}`, url: uri })));
          setLoading(false);
          return;
        }
      }

      if (isComics) {
        try {
          const urls = await fetchComicPages(mangaId, chapterId);
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
  }, [mangaId, chapterId, offline, isComics, isGated, hasAccess]);

  const uiStyle = useAnimatedStyle(() => ({ opacity: uiOpacity.value }));

  useEffect(() => {
    if (loading || renderedPages.length === 0) return;
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
      id ? `sakura://chapter/${id}?p=${pageNumber}` : undefined,
    );
  }, [chapterId, currentPage, id, loading, renderedPages.length]);

  useEffect(() => {
    didInitialScroll.current = false;
  }, [mangaId, chapterId]);

  const itemLength = readingMode === 'page' ? SCREEN_WIDTH : PAGE_HEIGHT;

  const jumpToPage = useCallback(
    (sourceIndex: number, animated = false) => {
      if (renderedPages.length === 0) return;
      const clamped = Math.min(Math.max(sourceIndex, 0), renderedPages.length - 1);
      const renderedIdx = mapSourceToRenderedIndex(clamped, renderedPages.length);
      flatListRef.current?.scrollToOffset({
        offset: itemLength * renderedIdx,
        animated,
      });
      setCurrentPage(clamped);
    },
    [isRtlPageMode, itemLength, renderedPages.length],
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
    ({ item }: { item: { id: string; url: string } }) => (
      <Image
        source={{ uri: item.url }}
        style={styles.page}
        contentFit="cover"
        transition={0}
        recyclingKey={item.id}
      />
    ),
    [],
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
  ]);

  useEffect(() => {
    return () => {
      if (mangaId && chapterId && renderedPages.length > 0) {
        void setMangaReadProgress({
          mangaId,
          chapterId,
          title: mangaTitle,
          cover: mangaCover,
          chapterLabel,
          page: currentPage + 1,
          totalPages: renderedPages.length,
        });
      }
      endReadingActivity();
    };
  }, []);

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
        getItemLayout={(_, index) => ({
          length: itemLength,
          offset: itemLength * index,
          index,
        })}
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
          flatListRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
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
  page: { width: SCREEN_WIDTH, height: PAGE_HEIGHT },
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
