import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Dimensions,
  useWindowDimensions,
  RefreshControl,
  ActionSheetIOS,
  Platform,
  Share,
} from 'react-native';
import { useScrollToTop } from 'expo-router';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  FadeInRight,
  FadeOutLeft,
} from 'react-native-reanimated';
import { useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path, Circle } from 'react-native-svg';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import {
  fetchAiringAnime,
  fetchPopularAnime,
  searchAnime,
  fetchAnimeByGenre,
  ANIME_GENRES,
  type AnimeResult,
} from '@/lib/anime';
import { SAKURA_ORIGINALS, type OriginalEntry } from '@/lib/sakura-originals';
import CreatorWorksRow from '@/components/creator/CreatorWorksRow';
const ANIME_ORIGINALS = SAKURA_ORIGINALS.filter((o) => o.type === 'anime');
import { playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import * as Haptics from 'expo-haptics';
import ContinueWatchingRow from '@/components/ui/ContinueWatchingRow';
import EmptyState from '@/components/ui/EmptyState';
import { getContinueWatching, subscribeWatchProgress, type AnimeWatchProgress } from '@/lib/watch-progress';

import {
  MAX_ANIME_HOME_HERO_HEIGHT_WEB,
  MAX_HERO_HEIGHT_WEB,
  contentWidth,
  isWideWeb,
} from '@/constants/layout';

const CARD_W = 108;
const CARD_H = CARD_W * 1.44;

function useLayoutMetrics() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    const HERO_H =
      Platform.OS === 'web'
        ? Math.min(W * 0.62, isWideWeb(windowW) ? MAX_ANIME_HOME_HERO_HEIGHT_WEB : MAX_HERO_HEIGHT_WEB)
        : W * 0.62;
    return { W, HERO_H };
  }, [windowW]);
}

const OC_W = 152;
const OC_H = OC_W * 1.48;

function useAnimeStyles() {
  const { colors } = useTheme();
  const { W, HERO_H } = useLayoutMetrics();
  return useMemo(() => ({
    W,
    HERO_H,
    s: StyleSheet.create({
      root: { flex: 1, backgroundColor: colors.background },
      searchWrap: {
        paddingHorizontal: Spacing.md,
        zIndex: 1,
      },
      searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: Radius.full,
        paddingHorizontal: 14,
        paddingVertical: 11,
        gap: 10,
        borderWidth: 1,
        borderColor: colors.border,
      },
      searchInput: {
        flex: 1,
        color: colors.text,
        fontSize: FontSize.md,
        fontFamily: Fonts.body,
        padding: 0,
      },
      continueWrap: {
        marginTop: 4,
        marginBottom: 4,
      },
      genreScroll: {
        paddingHorizontal: Spacing.md,
        paddingVertical: 10,
        gap: 7,
      },
      genreChip: {
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: Radius.full,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
      },
      genreChipActive: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
      },
      genreChipText: {
        color: colors.textSecondary,
        fontSize: FontSize.xs,
        fontFamily: Fonts.bodyMedium,
      },
      genreChipTextActive: {
        color: '#fff',
      },
      gridSection: {
        paddingHorizontal: Spacing.md,
        marginTop: 4,
      },
      sectionTitle: {
        color: colors.text,
        fontSize: FontSize.lg,
        fontWeight: '700',
        fontFamily: Fonts.bodyBold,
        marginBottom: 14,
      },
      gridRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
      },
      empty: {
        paddingVertical: 24,
      },
    }),
    hero: StyleSheet.create({
      wrap: { width: W, height: HERO_H },
      img: { width: '100%', height: '100%' },
      content: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: Spacing.md,
        paddingBottom: 24,
        gap: 6,
      },
      title: {
        color: '#fff',
        fontSize: FontSize.xxxl,
        fontWeight: '800',
        lineHeight: 32,
        letterSpacing: 0.2,
      },
      label: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: FontSize.sm,
        fontFamily: Fonts.bodyMedium,
      },
      actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: 4,
      },
      playBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.primary,
        borderRadius: Radius.full,
        paddingHorizontal: 20,
        paddingVertical: 10,
      },
      playText: {
        color: '#fff',
        fontSize: FontSize.md,
        fontFamily: Fonts.bodyBold,
      },
      scoreChip: {
        backgroundColor: 'rgba(0,0,0,0.55)',
        borderRadius: Radius.full,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      scoreText: {
        color: colors.gold,
        fontSize: FontSize.sm,
        fontFamily: Fonts.bodyBold,
      },
    }),
    oc: StyleSheet.create({
      wrap: {
        width: OC_W,
        height: OC_H,
        borderRadius: Radius.md,
        overflow: 'hidden',
        backgroundColor: colors.surfaceSecondary,
        marginRight: 10,
      },
      img: { width: '100%', height: '100%' },
      grad: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '65%',
      },
      badge: {
        position: 'absolute',
        top: 8,
        left: 8,
        backgroundColor: colors.primary,
        borderRadius: Radius.full,
        paddingHorizontal: 7,
        paddingVertical: 3,
      },
      badgeText: {
        color: '#fff',
        fontSize: 8,
        fontFamily: Fonts.bodyBold,
        letterSpacing: 0.6,
      },
      soonBadge: {
        position: 'absolute',
        top: 8,
        right: 8,
        backgroundColor: 'rgba(255,255,255,0.18)',
        borderRadius: Radius.full,
        paddingHorizontal: 7,
        paddingVertical: 3,
      },
      soonText: {
        color: '#fff',
        fontSize: 8,
        fontFamily: Fonts.bodyBold,
        letterSpacing: 0.6,
      },
      info: {
        position: 'absolute',
        bottom: 10,
        left: 10,
        right: 10,
      },
      title: {
        color: '#fff',
        fontSize: 11,
        fontFamily: Fonts.bodyBold,
        lineHeight: 15,
      },
      label: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 9,
        fontFamily: Fonts.bodyMedium,
        marginTop: 2,
      },
      rowHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: Spacing.md,
        marginBottom: 12,
      },
      rowTitle: {
        color: colors.text,
        fontSize: FontSize.lg,
        fontWeight: '700',
        fontFamily: Fonts.bodyBold,
      },
      rowBadge: {
        backgroundColor: colors.primary,
        borderRadius: Radius.full,
        paddingHorizontal: 8,
        paddingVertical: 2,
      },
      rowBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontFamily: Fonts.bodyBold,
        letterSpacing: 0.5,
      },
    }),
    card: StyleSheet.create({
      wrap: { width: CARD_W, marginRight: 8 },
      imgWrap: {
        width: CARD_W,
        height: CARD_H,
        borderRadius: Radius.sm,
        overflow: 'hidden',
        backgroundColor: colors.surfaceSecondary,
      },
      img: { width: '100%', height: '100%' },
      scoreBadge: {
        position: 'absolute',
        top: 5,
        left: 5,
        backgroundColor: 'rgba(0,0,0,0.7)',
        borderRadius: Radius.full,
        paddingHorizontal: 5,
        paddingVertical: 2,
      },
      scoreText: { color: colors.gold, fontSize: 9, fontFamily: Fonts.bodyBold },
      title: {
        color: colors.text,
        fontSize: 10,
        fontFamily: Fonts.bodyMedium,
        marginTop: 5,
        lineHeight: 13,
      },
    }),
    grid: StyleSheet.create({
      wrap: { marginBottom: 16 },
      imgWrap: { borderRadius: Radius.sm, overflow: 'hidden', backgroundColor: colors.surfaceSecondary },
      score: {
        position: 'absolute',
        top: 8,
        left: 8,
        backgroundColor: 'rgba(0,0,0,0.7)',
        borderRadius: Radius.full,
        paddingHorizontal: 7,
        paddingVertical: 3,
      },
      scoreText: { color: colors.gold, fontSize: 11, fontFamily: Fonts.bodyBold },
      title: {
        color: colors.text,
        fontSize: FontSize.sm,
        fontFamily: Fonts.bodyMedium,
        marginTop: 8,
        lineHeight: 18,
      },
      year: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.body, marginTop: 2 },
    }),
    row: StyleSheet.create({
      section: { marginTop: 24 },
      title: {
        color: colors.text,
        fontSize: FontSize.lg,
        fontWeight: '700',
        fontFamily: Fonts.bodyBold,
        marginBottom: 12,
        paddingHorizontal: Spacing.md,
      },
      scroll: { paddingHorizontal: Spacing.md, paddingBottom: 4 },
    }),
    colors,
  }), [colors, W, HERO_H]);
}

function useDebounce(value: string, delay: number) {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setDv(value), delay);
    return () => clearTimeout(h);
  }, [value, delay]);
  return dv;
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function SkeletonCard({ width = CARD_W, height = CARD_H }: { width?: number; height?: number }) {
  const { colors } = useTheme();
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(0.7, { duration: 700 }), withTiming(0.35, { duration: 700 })),
      -1,
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[style, { width, height, borderRadius: Radius.sm, backgroundColor: colors.surfaceSecondary, marginRight: 8 }]}
    />
  );
}

function SkeletonHero() {
  const { colors } = useTheme();
  const { W, HERO_H } = useLayoutMetrics();
  const opacity = useSharedValue(0.3);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(0.6, { duration: 800 }), withTiming(0.3, { duration: 800 })),
      -1,
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[style, { width: W, height: HERO_H, backgroundColor: colors.surfaceSecondary }]} />
  );
}

// ─── Hero banner (Sakura Originals) ──────────────────────────────────────────
function OriginalsHero({ original, onPress }: { original: OriginalEntry; onPress: () => void }) {
  const { hero, colors } = useAnimeStyles();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.95} style={hero.wrap}>
      <Image
        source={original.localImage}
        style={hero.img}
        contentFit="cover"
        transition={400}
        placeholder={{ blurhash: 'L02?U100~A~qIURjofWB~qxuRjWB' }}
      />
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.55)', colors.background]}
        locations={[0.3, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={hero.content}>
        <Text style={hero.title} numberOfLines={2}>{original.title}</Text>
        <Text style={hero.label} numberOfLines={1}>{original.label}</Text>
        <View style={hero.actions}>
          {!original.comingSoon ? (
            <TouchableOpacity onPress={onPress} style={hero.playBtn} activeOpacity={0.85}>
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="#fff">
                <Path d="M5 3l14 9-14 9V3z" fill="#fff" />
              </Svg>
              <Text style={hero.playText}>Watch Now</Text>
            </TouchableOpacity>
          ) : (
            <View style={[hero.playBtn, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
              <Text style={hero.playText}>Coming Soon</Text>
            </View>
          )}
          {original.score != null && (
            <View style={hero.scoreChip}>
              <Text style={hero.scoreText}>★ {original.score}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Original card (for the row section) ─────────────────────────────────────
function OriginalCard({ original, onPress }: { original: OriginalEntry; onPress: () => void }) {
  const { oc } = useAnimeStyles();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82} style={oc.wrap}>
      <Image source={original.localImage} style={oc.img} contentFit="cover" transition={300} />
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={oc.grad} />
      {original.comingSoon && (
        <View style={oc.soonBadge}>
          <Text style={oc.soonText}>SOON</Text>
        </View>
      )}
      <View style={oc.info}>
        <Text style={oc.title} numberOfLines={2}>{original.title}</Text>
        <Text style={oc.label} numberOfLines={1}>{original.label}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Anime poster card ────────────────────────────────────────────────────────
function AnimeCard({ anime, onPress }: { anime: AnimeResult; onPress: () => void }) {
  const { card } = useAnimeStyles();
  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Share'], cancelButtonIndex: 0 },
        (idx) => {
          if (idx === 1) Share.share({ message: `Check out "${anime.title}" on Sakura!` });
        },
      );
    } else {
      Share.share({ message: `Check out "${anime.title}" on Sakura!` });
    }
  };

  return (
    <TouchableOpacity onPress={onPress} onLongPress={handleLongPress} delayLongPress={400} activeOpacity={0.8} style={card.wrap}>
      <View style={card.imgWrap}>
        <Image
          source={{ uri: anime.image }}
          style={card.img}
          contentFit="cover"
          transition={300}
        />
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.75)']}
          style={StyleSheet.absoluteFill}
        />
        {anime.score != null && (
          <View style={card.scoreBadge}>
            <Text style={card.scoreText}>★ {anime.score}</Text>
          </View>
        )}
      </View>
      <Text style={card.title} numberOfLines={2}>{anime.title}</Text>
    </TouchableOpacity>
  );
}


/**
 * Width of one card in the search/genre results grid.
 *
 * Two columns is right for a phone and absurd for a desktop: at a 1920px window
 * `(contentWidth - padding) / 2` produced cards roughly 700px across, two per
 * row, so a search for anything looked like two billboards. Column count now
 * follows the available width, targeting a card of about 170px — close to the
 * 152px Originals card, so the grid and the rows read as the same shelf.
 */
function gridCardWidth(contentW: number): number {
  const GUTTER = 10;
  const TARGET = 170;
  const available = contentW - Spacing.md * 2;
  const columns = Math.max(2, Math.floor((available + GUTTER) / (TARGET + GUTTER)));
  return (available - GUTTER * (columns - 1)) / columns;
}

// ─── Grid card (search/genre results) ─────────────────────────────────────────
function GridCard({ anime, onPress }: { anime: AnimeResult; onPress: () => void }) {
  const { grid, W } = useAnimeStyles();
  const w = gridCardWidth(W);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={[grid.wrap, { width: w }]}>
      <View style={[grid.imgWrap, { height: w * 1.42 }]}>
        <Image source={{ uri: anime.image }} style={StyleSheet.absoluteFill} contentFit="cover" transition={300} />
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.8)']} style={StyleSheet.absoluteFill} />
        {anime.score != null && (
          <View style={grid.score}>
            <Text style={grid.scoreText}>★ {anime.score}</Text>
          </View>
        )}
      </View>
      <Text style={grid.title} numberOfLines={2}>{anime.title}</Text>
      {anime.year && <Text style={grid.year}>{anime.year}</Text>}
    </TouchableOpacity>
  );
}

// ─── Row section ──────────────────────────────────────────────────────────────
function Row({ title, data, loading, onPress }: {
  title: string;
  data: AnimeResult[];
  loading: boolean;
  onPress: (a: AnimeResult) => void;
}) {
  const { row } = useAnimeStyles();
  return (
    <View style={row.section}>
      <Text style={row.title}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={row.scroll}>
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : data.map((a) => (
              <AnimeCard key={a.id} anime={a} onPress={() => onPress(a)} />
            ))}
      </ScrollView>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function AnimeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scrollRef = useRef<any>(null);
  const { s, colors, oc, row, W } = useAnimeStyles();
  useScrollToTop(scrollRef);

  const [airing, setAiring] = useState<AnimeResult[]>([]);
  const [popular, setPopular] = useState<AnimeResult[]>([]);
  const [airingLoading, setAiringLoading] = useState(true);
  const [popularLoading, setPopularLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<AnimeResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [selectedGenre, setSelectedGenre] = useState<number | null>(null);
  const [genreResults, setGenreResults] = useState<AnimeResult[]>([]);
  const [genreLoading, setGenreLoading] = useState(false);
  const [originalIndex, setOriginalIndex] = useState(0);
  const [continueAnime, setContinueAnime] = useState<AnimeWatchProgress[]>([]);

  const debouncedSearch = useDebounce(search, 650);

  const refreshContinue = useCallback(() => {
    getContinueWatching(10).then(setContinueAnime);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshContinue();
    }, [refreshContinue]),
  );

  useEffect(() => {
    return subscribeWatchProgress(refreshContinue);
  }, [refreshContinue]);

  const loadData = useCallback(() => {
    setAiringLoading(true);
    setPopularLoading(true);
    fetchAiringAnime()
      .then(setAiring)
      .catch(() => {})
      .finally(() => setAiringLoading(false));
    fetchPopularAnime()
      .then(setPopular)
      .catch(() => {})
      .finally(() => { setPopularLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!debouncedSearch.trim()) { setSearchResults([]); return; }
    setSearchLoading(true);
    searchAnime(debouncedSearch)
      .then(setSearchResults)
      .catch(() => {})
      .finally(() => setSearchLoading(false));
  }, [debouncedSearch]);

  useEffect(() => {
    const timer = setInterval(() => {
      setOriginalIndex((prev) => (prev + 1) % ANIME_ORIGINALS.length);
    }, 3500);
    return () => clearInterval(timer);
  }, []);

  const handleGenreSelect = useCallback((id: number | null) => {
    playTap();
    setSelectedGenre(id);
    if (!id) { setGenreResults([]); return; }
    setGenreLoading(true);
    fetchAnimeByGenre(id)
      .then(setGenreResults)
      .catch(() => {})
      .finally(() => setGenreLoading(false));
  }, []);

  const handleAnimePress = (a: AnimeResult) => {
    playTap();
    router.push({ pathname: '/anime/[id]', params: { id: a.id } });
  };

  const isSearching = search.trim().length > 0;
  const activeOriginal = ANIME_ORIGINALS[originalIndex % ANIME_ORIGINALS.length];

  return (
    <View style={s.root}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        scrollIndicatorInsets={{ bottom: 90 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* Hero — Sakura Originals carousel */}
        {!isSearching && (
          <Animated.View
            key={activeOriginal.id}
            entering={FadeInRight.duration(420)}
            exiting={FadeOutLeft.duration(300)}
          >
            <OriginalsHero
              original={activeOriginal}
              onPress={() => { playTap(); router.push({ pathname: '/anime/[id]', params: { id: activeOriginal.id } }); }}
            />
          </Animated.View>
        )}

        {/* Search bar */}
        <View style={[s.searchWrap, { marginTop: isSearching ? insets.top + 12 : 16 }]}>
          <View style={s.searchBar}>
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
              <Circle cx="11" cy="11" r="8" stroke={colors.textSecondary} strokeWidth={2} />
              <Path d="M21 21l-4.35-4.35" stroke={colors.textSecondary} strokeWidth={2} strokeLinecap="round" />
            </Svg>
            <TextInput
              style={s.searchInput}
              placeholder="Search anime..."
              placeholderTextColor={colors.textTertiary}
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                  <Path d="M18 6L6 18M6 6l12 12" stroke={colors.textSecondary} strokeWidth={2} strokeLinecap="round" />
                </Svg>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Genre chips */}
        {!isSearching && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.genreScroll}
          >
            <TouchableOpacity
              onPress={() => handleGenreSelect(null)}
              style={[s.genreChip, selectedGenre === null && s.genreChipActive]}
            >
              <Text style={[s.genreChipText, selectedGenre === null && s.genreChipTextActive]}>
                All
              </Text>
            </TouchableOpacity>
            {ANIME_GENRES.map((g) => (
              <TouchableOpacity
                key={g.id}
                onPress={() => handleGenreSelect(g.id)}
                style={[s.genreChip, selectedGenre === g.id && s.genreChipActive]}
              >
                <Text style={[s.genreChipText, selectedGenre === g.id && s.genreChipTextActive]}>
                  {g.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {!isSearching && <CreatorWorksRow kind="anime" />}

        {/* Search results */}
        {isSearching && (
          <View style={s.gridSection}>
            <Text style={s.sectionTitle}>
              {searchLoading ? 'Searching…' : `Results for "${search.trim()}"`}
            </Text>
            {searchLoading ? (
              <View style={s.gridRow}>
                {Array.from({ length: 6 }).map((_, i) => {
                  const w = gridCardWidth(W);
                  return <SkeletonCard key={i} width={w} height={w * 1.42} />;
                })}
              </View>
            ) : searchResults.length > 0 ? (
              <View style={s.gridRow}>
                {searchResults.map((a) => (
                  <GridCard key={a.id} anime={a} onPress={() => handleAnimePress(a)} />
                ))}
              </View>
            ) : (
              <EmptyState compact title="No results found" style={s.empty} />
            )}
          </View>
        )}

        {/* Genre results */}
        {!isSearching && selectedGenre !== null && (
          <View style={s.gridSection}>
            <Text style={s.sectionTitle}>
              {ANIME_GENRES.find((g) => g.id === selectedGenre)?.name}
            </Text>
            {genreLoading ? (
              <View style={s.gridRow}>
                {Array.from({ length: 6 }).map((_, i) => {
                  const w = gridCardWidth(W);
                  return <SkeletonCard key={i} width={w} height={w * 1.42} />;
                })}
              </View>
            ) : genreResults.length > 0 ? (
              <View style={s.gridRow}>
                {genreResults.map((a) => (
                  <GridCard key={a.id} anime={a} onPress={() => handleAnimePress(a)} />
                ))}
              </View>
            ) : !genreLoading ? (
              <EmptyState compact title="No anime found for this genre" style={s.empty} />
            ) : null}
          </View>
        )}

        {!isSearching && continueAnime.length > 0 && (
          <View style={s.continueWrap}>
            <ContinueWatchingRow items={continueAnime} />
          </View>
        )}

        {/* Default rows */}
        {!isSearching && selectedGenre === null && (
          <>
            {/* Sakura Originals row */}
            <View style={row.section}>
              <View style={oc.rowHeader}>
                <Text style={oc.rowTitle}>Sakura Originals</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={row.scroll}>
                {ANIME_ORIGINALS.map((orig) => (
                  <OriginalCard
                    key={orig.id}
                    original={orig}
                    onPress={() => { playTap(); router.push({ pathname: '/anime/[id]', params: { id: orig.id } }); }}
                  />
                ))}
              </ScrollView>
            </View>

            <Row
              title="Currently Airing"
              data={airing}
              loading={airingLoading}
              onPress={handleAnimePress}
            />
            <Row
              title="Top Picks"
              data={popular}
              loading={popularLoading}
              onPress={handleAnimePress}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}
