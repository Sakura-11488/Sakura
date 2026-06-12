import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  FlatList,
  Dimensions,
  ActivityIndicator,
  RefreshControl,
  ActionSheetIOS,
  Platform,
  Share,
} from 'react-native';
import { useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Svg, { Path, Circle } from 'react-native-svg';
import { Spacing, FontSize, Fonts, Radius, Shadow } from '@/constants/theme';
import { playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { addFavorite } from '@/lib/supabase';
import {
  fetchPopularNovels,
  searchNovels,
  enhanceCovers,
  ALLNOVEL_GENRES,
  type AllNovelItem,
} from '@/lib/allnovel';
import {
  getContinueReading,
  getNovelProgressBySeries,
  subscribeReadingProgress,
  isActiveReadingProgress,
  type NovelProgress,
  type ContinueReadingItem,
} from '@/lib/reader-progress';
import ContinueReadingRow from '@/components/ui/ContinueReadingRow';
import EmptyState from '@/components/ui/EmptyState';
import { useFocusEffect } from 'expo-router';

const { width: W } = Dimensions.get('window');
const GRID_GAP = 6;
const COL = 4;
const CARD_W = Math.floor((W - Spacing.md * 2 - GRID_GAP * (COL - 1)) / COL);
const CARD_H = Math.floor(CARD_W * 1.38);
const HERO_H = 240;
const MAX_RECENT = 8;

const HUMOR_ME_HERO: AllNovelItem = {
  path: 'humour-me',
  name: 'HUMOR ME',
  cover: 'https://i.postimg.cc/t4dpCnph/IMG-20260502-WA0012.jpg',
};

// ─── Icons ────────────────────────────────────────────────────────────────────

function SearchIcon({ color = '#8E8E93' }: { color?: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Circle cx="11" cy="11" r="8" stroke={color} strokeWidth={2} />
      <Path d="m21 21-4.35-4.35" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function CloseIcon({ color = '#8E8E93' }: { color?: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Path d="M18 6 6 18M6 6l12 12" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
    </Svg>
  );
}

function ClockIcon() {
  const { colors } = useTheme();
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="10" stroke={colors.textTertiary} strokeWidth={1.8} />
      <Path d="M12 6v6l4 2" stroke={colors.textTertiary} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

// ─── Genre pill list ──────────────────────────────────────────────────────────

const GENRES = [
  { label: 'All', value: '' },
  ...ALLNOVEL_GENRES,
];

// ─── Hero carousel ────────────────────────────────────────────────────────────

function HeroSlide({
  novel,
  onPress,
  onSave,
  isSaved,
}: {
  novel: AllNovelItem;
  onPress: () => void;
  onSave: () => void;
  isSaved: boolean;
}) {
  return (
    <View style={h.slideOuter}>
      <TouchableOpacity style={h.slide} onPress={onPress} activeOpacity={0.96}>
        {novel.cover ? (
          <Image
            source={{ uri: novel.cover }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={500}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, h.coverFallback]} />
        )}
        <LinearGradient
          colors={['transparent', 'rgba(15,8,30,0.55)', 'rgba(10,6,20,0.97)']}
          locations={[0.2, 0.58, 1]}
          style={StyleSheet.absoluteFill}
        />
        <View style={h.content}>
          <Text style={h.title} numberOfLines={2}>{novel.name}</Text>
          <View style={h.actionRow}>
            <TouchableOpacity style={h.startBtn} onPress={onPress} activeOpacity={0.85}>
              <Text style={h.startBtnText}>Start Reading</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[h.saveBtn, isSaved && h.saveBtnActive]}
              onPress={onSave}
              activeOpacity={0.85}
            >
              <Svg width={15} height={15} viewBox="0 0 24 24" fill={isSaved ? '#fff' : 'none'}>
                <Path
                  d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
                  stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
                />
              </Svg>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

function HeroCarousel({
  novels,
  onPress,
}: {
  novels: AllNovelItem[];
  onPress: (novel: AllNovelItem) => void;
}) {
  const { address } = useWallet();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const flatRef = useRef<FlatList<AllNovelItem>>(null);
  const activeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const items = useMemo(() => novels.slice(0, 6), [novels]);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (items.length <= 1) return;
    timerRef.current = setInterval(() => {
      const next = (activeRef.current + 1) % items.length;
      activeRef.current = next;
      flatRef.current?.scrollToOffset({ offset: next * W, animated: true });
    }, 4500);
  }, [items.length]);

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [startTimer]);

  const handleSave = useCallback(async (novel: AllNovelItem) => {
    if (!address || saved.has(novel.path)) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    playTap();
    try {
      await addFavorite({
        wallet_address: address,
        content_id: novel.path,
        content_type: 'novel',
        title: novel.name,
        cover_url: novel.cover || '',
      });
      setSaved((prev) => new Set([...prev, novel.path]));
    } catch {}
  }, [address, saved]);

  if (items.length === 0) return null;

  return (
    <View style={h.carouselWrap}>
      <FlatList
        ref={flatRef}
        data={items}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={W}
        decelerationRate="fast"
        bounces={false}
        keyExtractor={(item) => item.path}
        renderItem={({ item }) => (
          <HeroSlide
            novel={item}
            onPress={() => onPress(item)}
            onSave={() => handleSave(item)}
            isSaved={saved.has(item.path)}
          />
        )}
        onScrollBeginDrag={() => {
          if (timerRef.current) clearInterval(timerRef.current);
        }}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / W);
          activeRef.current = idx;
          startTimer();
        }}
      />
    </View>
  );
}

// ─── Novel card ───────────────────────────────────────────────────────────────

function NovelCard({
  novel,
  index = 0,
  progress,
}: {
  novel: AllNovelItem;
  index?: number;
  progress?: NovelProgress | null;
}) {
  const router = useRouter();
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const [imgErr, setImgErr] = useState(false);

  const coverUri = (!imgErr && novel.cover) ? novel.cover : (novel.originalCover ?? null);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    router.push(`/novel/ext?path=${encodeURIComponent(novel.path)}` as any);
  };

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Share'], cancelButtonIndex: 0 },
        (idx) => {
          if (idx === 1) Share.share({ message: `Check out "${novel.name}" on Sakura!` });
        },
      );
    } else {
      Share.share({ message: `Check out "${novel.name}" on Sakura!` });
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 35).duration(300)}
      style={[c.wrap, style]}
    >
      <TouchableOpacity
        onPressIn={() => { scale.value = withTiming(0.96, { duration: 80 }); }}
        onPressOut={() => { scale.value = withTiming(1, { duration: 140 }); }}
        onPress={handlePress}
        onLongPress={handleLongPress}
        delayLongPress={400}
        activeOpacity={1}
      >
        <View style={[c.imgWrap, { backgroundColor: colors.surfaceSecondary }]}>
          {coverUri ? (
            <Image
              source={{ uri: coverUri }}
              style={c.img}
              contentFit="cover"
              transition={300}
              onError={() => setImgErr(true)}
            />
          ) : (
            <View style={c.imgFallback}>
              <Text style={c.fallbackEmoji}>📖</Text>
            </View>
          )}
          {progress && isActiveReadingProgress(progress.progress) && (
            <View style={c.continuePill}>
              <Text style={c.continuePillText} numberOfLines={1}>
                Continue · {Math.round(progress.progress * 100)}%
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Skeleton card ────────────────────────────────────────────────────────────

function SkeletonCard({ index = 0 }: { index?: number }) {
  const { colors } = useTheme();
  const opacity = useSharedValue(0.45);
  useEffect(() => {
    const interval = setInterval(() => {
      opacity.value = withTiming(opacity.value < 0.65 ? 0.85 : 0.45, { duration: 750 });
    }, 750);
    return () => clearInterval(interval);
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[
        { width: CARD_W, height: CARD_H, borderRadius: Radius.sm, backgroundColor: colors.surfaceSecondary },
        style,
      ]}
    />
  );
}

// ─── Search bar ───────────────────────────────────────────────────────────────

function SearchBar({
  value, onChange, onClear, recentSearches, onRecentPress, onRecentRemove, onClearAll,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  recentSearches: string[];
  onRecentPress: (q: string) => void;
  onRecentRemove: (q: string) => void;
  onClearAll: () => void;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const showRecent = focused && value.length === 0 && recentSearches.length > 0;

  const sb = useMemo(() => StyleSheet.create({
    container: { position: 'relative', zIndex: 20 },
    wrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.white,
      borderRadius: Radius.full,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1.5,
      borderColor: colors.border,
      ...Shadow.sm,
    },
    wrapFocused: { borderColor: colors.primary },
    input: {
      flex: 1,
      fontSize: FontSize.sm,
      fontFamily: Fonts.body,
      color: colors.text,
      paddingVertical: 0,
    },
    clearCircle: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.textTertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    recentBox: {
      position: 'absolute',
      top: '100%',
      left: 0,
      right: 0,
      marginTop: 6,
      backgroundColor: colors.white,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      ...Shadow.md,
      zIndex: 100,
      overflow: 'hidden',
    },
    recentHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
    },
    recentLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    recentTitle: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyBold,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    clearAll: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyMedium,
      color: colors.primary,
    },
    recentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    recentQ: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.body,
      color: colors.text,
    },
  }), [colors]);

  return (
    <View style={sb.container}>
      <View style={[sb.wrap, focused && sb.wrapFocused]}>
        <SearchIcon color={focused ? colors.primary : colors.textSecondary} />
        <TextInput
          style={sb.input}
          placeholder="Search novels..."
          placeholderTextColor={colors.textTertiary}
          value={value}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          returnKeyType="search"
          autoCorrect={false}
        />
        {value.length > 0 && (
          <TouchableOpacity onPress={onClear} hitSlop={8}>
            <View style={sb.clearCircle}>
              <CloseIcon color="#fff" />
            </View>
          </TouchableOpacity>
        )}
      </View>
      {showRecent && (
        <Animated.View entering={FadeIn.duration(180)} style={sb.recentBox}>
          <View style={sb.recentHeader}>
            <View style={sb.recentLeft}>
              <ClockIcon />
              <Text style={sb.recentTitle}>Recent</Text>
            </View>
            <TouchableOpacity onPress={onClearAll}>
              <Text style={sb.clearAll}>Clear all</Text>
            </TouchableOpacity>
          </View>
          {recentSearches.map((q) => (
            <View key={q} style={sb.recentRow}>
              <TouchableOpacity onPress={() => onRecentPress(q)} style={{ flex: 1 }}>
                <Text style={sb.recentQ} numberOfLines={1}>{q}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => onRecentRemove(q)} hitSlop={10}>
                <CloseIcon color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          ))}
        </Animated.View>
      )}
    </View>
  );
}

// ─── Debounce hook ────────────────────────────────────────────────────────────

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function NovelScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const scrollY = useSharedValue(0);
  const scrollRef = useRef<any>(null);
  useScrollToTop(scrollRef);
  const [refreshing, setRefreshing] = useState(false);

  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    topGrad: {
      position: 'absolute', top: 0, left: 0, right: 0, height: 280, zIndex: 0,
    },
    safe: { flex: 1 },
    scroll: { paddingTop: 0 },
    titleWrap: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.md,
      paddingBottom: Spacing.sm,
    },
    title: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: 36,
      color: colors.text,
      letterSpacing: 0.3,
    },
    subtitle: {
      fontFamily: Fonts.body,
      fontSize: FontSize.sm,
      color: colors.textSecondary,
      marginTop: 4,
    },
    searchWrap: {
      paddingHorizontal: Spacing.md,
      marginBottom: Spacing.md,
      zIndex: 20,
    },
    heroWrap: {
      marginBottom: 8,
    },
    continueWrap: {
      marginBottom: Spacing.sm,
    },
    genreWrap: { marginBottom: Spacing.md },
    genreList: {
      paddingHorizontal: Spacing.md,
      gap: 7,
    },
    chip: {
      paddingHorizontal: 13,
      paddingVertical: 6,
      borderRadius: Radius.full,
      backgroundColor: colors.white,
      borderWidth: 1.5,
      borderColor: colors.border,
      ...Shadow.sm,
    },
    chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyMedium,
      color: colors.textSecondary,
    },
    chipTextActive: { color: '#fff', fontFamily: Fonts.bodyBold },
    sectionRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      marginBottom: 12,
    },
    sectionTitle: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.md,
      color: colors.text,
      letterSpacing: 0.5,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: Spacing.md,
      gap: GRID_GAP,
      rowGap: GRID_GAP + 4,
    },
    emptyWrap: {
      paddingVertical: 32,
      paddingHorizontal: Spacing.md,
    },
    loadingMoreWrap: {
      alignItems: 'center',
      paddingVertical: 20,
    },
  }), [colors]);

  // Data
  const [novels, setNovels] = useState<AllNovelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);

  // Search
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<AllNovelItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const debouncedSearch = useDebounce(search, 600);

  // Genre filter
  const [activeGenre, setActiveGenre] = useState('');
  const [genreResults, setGenreResults] = useState<AllNovelItem[]>([]);
  const [genreLoading, setGenreLoading] = useState(false);

  // Recent searches
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [continueNovels, setContinueNovels] = useState<ContinueReadingItem[]>([]);
  const [novelProgressMap, setNovelProgressMap] = useState<Record<string, NovelProgress>>({});

  const refreshReading = useCallback(() => {
    getContinueReading(12).then((items) => {
      setContinueNovels(items.filter((i) => i.kind === 'novel'));
    });
    getNovelProgressBySeries().then(setNovelProgressMap);
  }, []);

  useEffect(() => {
    refreshReading();
    const unsub = subscribeReadingProgress(refreshReading);
    return () => {
      unsub();
    };
  }, [refreshReading]);

  useFocusEffect(
    useCallback(() => {
      refreshReading();
    }, [refreshReading]),
  );

  const loadNovels = useCallback(async (showRefresh = false) => {
    if (!showRefresh) setLoading(true);
    try {
      const items = await fetchPopularNovels(1);
      setNovels(items);
      setPage(1);
      const enhanced = await enhanceCovers(items);
      setNovels(enhanced);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadNovels(true);
  }, [loadNovels]);

  // Initial load
  useEffect(() => { loadNovels(); }, [loadNovels]);

  // Debounced search
  useEffect(() => {
    if (!debouncedSearch.trim()) { setSearchResults([]); return; }
    setSearchLoading(true);
    searchNovels(debouncedSearch, 1)
      .then(async (items) => {
        setSearchResults(items);
        setSearchLoading(false);
        if (debouncedSearch.trim().length >= 2) saveRecentSearch(debouncedSearch);
        const enhanced = await enhanceCovers(items);
        setSearchResults(enhanced);
      })
      .catch(() => setSearchLoading(false));
  }, [debouncedSearch]);

  // Genre filter
  const handleGenreSelect = useCallback(async (genreValue: string) => {
    setActiveGenre(genreValue);
    setSearch('');
    if (!genreValue) { setGenreResults([]); return; }
    setGenreLoading(true);
    fetchPopularNovels(1, { genre: genreValue })
      .then(async (items) => {
        setGenreResults(items);
        setGenreLoading(false);
        const enhanced = await enhanceCovers(items);
        setGenreResults(enhanced);
      })
      .catch(() => setGenreLoading(false));
  }, []);

  // Load more
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const next = page + 1;
    fetchPopularNovels(next, activeGenre ? { genre: activeGenre } : undefined)
      .then(async (more) => {
        const target = activeGenre ? setGenreResults : setNovels;
        target((prev) => [...prev, ...more]);
        setPage(next);
        setLoadingMore(false);
        const enhanced = await enhanceCovers(more);
        target((prev) => {
          const base = prev.slice(0, prev.length - more.length);
          return [...base, ...enhanced];
        });
      })
      .catch(() => setLoadingMore(false));
  }, [page, loadingMore, activeGenre]);

  // Recent search helpers
  const saveRecentSearch = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    setRecentSearches((prev) => {
      const filtered = prev.filter((s) => s.toLowerCase() !== trimmed.toLowerCase());
      return [trimmed, ...filtered].slice(0, MAX_RECENT);
    });
  };
  const handleRecentPress = (q: string) => setSearch(q);
  const handleRecentRemove = (q: string) => setRecentSearches((p) => p.filter((s) => s !== q));
  const handleClearAll = () => setRecentSearches([]);

  const triggerLoadMore = useCallback(() => {
    if (search.trim().length > 0 || activeGenre || loadingMore) return;
    loadMore();
  }, [search, activeGenre, loadingMore, loadMore]);

  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
    if (e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - 500) {
      runOnJS(triggerLoadMore)();
    }
  });

  const isSearching = search.trim().length > 0;
  const isFiltering = !!activeGenre;
  const displayNovels = isSearching
    ? searchResults
    : isFiltering
    ? genreResults
    : novels;
  const isLoadingDisplay = isSearching ? searchLoading : isFiltering ? genreLoading : loading;

  const handleCardPress = (novel: AllNovelItem) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    router.push(`/novel/ext?path=${encodeURIComponent(novel.path)}` as any);
  };

  const activeGenreLabel = GENRES.find((g) => g.value === activeGenre)?.label ?? 'All';

  return (
    <View style={s.root}>
      <LinearGradient
        colors={['rgba(232,69,69,0.18)', 'rgba(120,40,180,0.10)', 'transparent']}
        style={s.topGrad}
        pointerEvents="none"
      />

      <SafeAreaView style={s.safe} edges={['top']}>
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          scrollIndicatorInsets={{ bottom: 90 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={s.scroll}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {/* Page title */}
          <Animated.View entering={FadeInDown.duration(340)} style={s.titleWrap}>
            <Text style={s.title}>Novels</Text>
            <Text style={s.subtitle}>Premium stories, curated daily</Text>
          </Animated.View>

          {/* Search bar */}
          <Animated.View entering={FadeInDown.delay(60).duration(360)} style={s.searchWrap}>
            <SearchBar
              value={search}
              onChange={(v) => { setSearch(v); if (v) setActiveGenre(''); }}
              onClear={() => setSearch('')}
              recentSearches={recentSearches}
              onRecentPress={handleRecentPress}
              onRecentRemove={handleRecentRemove}
              onClearAll={handleClearAll}
            />
          </Animated.View>

          {/* Hero carousel — Humor Me (Sakura Original) */}
          {!isSearching && (
            <Animated.View entering={FadeInDown.delay(100).duration(400)} style={s.heroWrap}>
              <HeroCarousel novels={[HUMOR_ME_HERO]} onPress={handleCardPress} />
            </Animated.View>
          )}

          {!isSearching && continueNovels.length > 0 && (
            <Animated.View entering={FadeInDown.delay(120).duration(360)} style={s.continueWrap}>
              <ContinueReadingRow items={continueNovels} title="Continue Reading" />
            </Animated.View>
          )}

          {/* Genre chips */}
          {!isSearching && (
            <Animated.View entering={FadeInDown.delay(140).duration(360)} style={s.genreWrap}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.genreList}
              >
                {GENRES.map((g) => {
                  const isActive = g.value === activeGenre;
                  return (
                    <TouchableOpacity
                      key={g.label}
                      onPress={() => {
                        handleGenreSelect(g.value);
                        Haptics.selectionAsync();
                      }}
                      style={[s.chip, isActive && s.chipActive]}
                      activeOpacity={0.75}
                    >
                      <Text style={[s.chipText, isActive && s.chipTextActive]}>{g.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </Animated.View>
          )}

          {/* Section label */}
          <View style={s.sectionRow}>
            <View>
              <Text style={s.sectionTitle}>
                {isSearching
                  ? `Results for "${search}"`
                  : isFiltering
                  ? activeGenreLabel.toUpperCase()
                  : 'CURATED PICKS'}
              </Text>
            </View>
          </View>

          {/* Grid */}
          {isLoadingDisplay ? (
            <View style={s.grid}>
              {Array.from({ length: 8 }).map((_, i) => (
                <SkeletonCard key={i} index={i} />
              ))}
            </View>
          ) : displayNovels.length === 0 ? (
            <Animated.View entering={FadeIn.duration(300)}>
              <EmptyState
                compact
                style={s.emptyWrap}
                title={isSearching ? 'No results found' : 'No novels found'}
                subtitle={isSearching ? 'Try a different title or keyword' : undefined}
              />
            </Animated.View>
          ) : (
            <View style={s.grid}>
              {displayNovels.map((novel, i) => (
                <NovelCard
                  key={`${novel.path}-${i}`}
                  novel={novel}
                  index={i}
                  progress={novelProgressMap[novel.path] ?? null}
                />
              ))}
            </View>
          )}

          {/* Infinite scroll loading indicator */}
          {loadingMore && (
            <View style={s.loadingMoreWrap}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          )}

          <View style={{ height: 130 }} />
        </Animated.ScrollView>
      </SafeAreaView>
    </View>
  );
}

// ─── Hero styles ──────────────────────────────────────────────────────────────

const h = StyleSheet.create({
  carouselWrap: {},
  slideOuter: {
    width: W,
    paddingHorizontal: Spacing.md,
  },
  slide: {
    height: HERO_H,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    ...Shadow.lg,
  },
  coverFallback: { backgroundColor: '#1a0a2e' },
  content: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 18,
    gap: 11,
  },
  title: {
    color: '#fff',
    fontSize: 21,
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
    lineHeight: 26,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 10,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  startBtn: {
    flex: 1,
    backgroundColor: '#E84545',
    borderRadius: Radius.full,
    paddingVertical: 12,
    alignItems: 'center',
  },
  startBtnText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyBold,
    letterSpacing: 0.4,
  },
  saveBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnActive: {
    backgroundColor: '#E84545',
    borderColor: '#E84545',
  },
});

// ─── Card styles ──────────────────────────────────────────────────────────────

const c = StyleSheet.create({
  wrap: {
    width: CARD_W,
    borderRadius: Radius.sm,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  imgWrap: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: Radius.sm,
    overflow: 'hidden',
  },
  img: { width: '100%', height: '100%' },
  imgFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackEmoji: { fontSize: 26 },
  continuePill: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(232,69,69,0.92)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 3,
  },
  continuePillText: {
    color: '#fff',
    fontSize: 8,
    fontFamily: Fonts.bodyBold,
    textAlign: 'center',
  },
});
