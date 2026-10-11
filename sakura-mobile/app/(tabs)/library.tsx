import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, TextInput, Platform, useWindowDimensions } from 'react-native';
import { useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Image from '@/components/ui/CoverImage';
import { useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, FontWeight, Shadow, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { Library, type LibraryItem } from '@/lib/storage';
import ContinueWatchingRow from '@/components/ui/ContinueWatchingRow';
import ContinueReadingRow from '@/components/ui/ContinueReadingRow';
import EmptyState from '@/components/ui/EmptyState';
import { getContinueWatching, subscribeWatchProgress, type AnimeWatchProgress } from '@/lib/watch-progress';
import { getContinueReading, subscribeReadingProgress, type ContinueReadingItem } from '@/lib/reader-progress';
import { playTap, onTap } from '@/lib/sound';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { contentWidth } from '@/constants/layout';

const TABS: Array<'All' | 'Anime' | 'Manga' | 'Novel'> = ['All', 'Anime', 'Manga', 'Novel'];

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function LibraryScreen() {
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'All' | 'Anime' | 'Manga' | 'Novel'>('All');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [continueAnime, setContinueAnime] = useState<AnimeWatchProgress[]>([]);
  const [continueReading, setContinueReading] = useState<ContinueReadingItem[]>([]);
  const router = useRouter();
  const listRef = useRef<any>(null);
  useScrollToTop(listRef);

  const refreshContinueWatching = useCallback(() => {
    getContinueWatching(10).then(setContinueAnime);
  }, []);

  const refreshContinueReading = useCallback(() => {
    getContinueReading(10).then(setContinueReading);
  }, []);

  const refreshContinue = useCallback(() => {
    refreshContinueWatching();
    refreshContinueReading();
  }, [refreshContinueWatching, refreshContinueReading]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const all = await Library.getAll();
      setItems(all);
      refreshContinue();
    } finally {
      setRefreshing(false);
    }
  }, [refreshContinue]);

  useFocusEffect(
    useCallback(() => {
      Library.getAll().then(setItems);
      refreshContinue();
    }, [refreshContinue]),
  );

  useEffect(() => {
    const unsubWatch = subscribeWatchProgress(refreshContinueWatching);
    const unsubRead = subscribeReadingProgress(refreshContinueReading);
    return () => {
      unsubWatch();
      unsubRead();
    };
  }, [refreshContinueWatching, refreshContinueReading]);

  const query = isWeb ? search.trim().toLocaleLowerCase() : '';
  const filtered = useMemo(() => items.filter(item => (
    (tab === 'All' || item.type === tab.toLowerCase()) &&
    (!query || item.title.toLocaleLowerCase().includes(query))
  )), [items, tab, query]);
  const gridWidth = Math.max(0, (layoutWidth || contentWidth(windowWidth)) - Spacing.md * 2);
  const columns = isWeb ? Math.max(2, Math.floor((gridWidth + Spacing.sm) / (170 + Spacing.sm))) : 2;
  const webCardWidth = (gridWidth - Spacing.sm * (columns - 1)) / columns;

  const showContinueWatch = continueAnime.length > 0 && (tab === 'All' || tab === 'Anime');
  const filteredReading = useMemo(() => {
    if (tab === 'Manga') return continueReading.filter((i) => i.kind === 'manga');
    if (tab === 'Novel') return continueReading.filter((i) => i.kind === 'novel');
    return continueReading;
  }, [continueReading, tab]);
  const showContinueRead = filteredReading.length > 0 && (tab === 'All' || tab === 'Manga' || tab === 'Novel');
  const showContinueHeader = !query && (showContinueWatch || showContinueRead);

  const continueByAnimeId = useMemo(
    () => new Map(continueAnime.map((c) => [c.animeId, c])),
    [continueAnime],
  );

  const navigate = (item: LibraryItem) => {
    playTap();
    if (item.type === 'novel') {
      router.push(`/novel/ext?path=${encodeURIComponent(item.id)}` as any);
    } else if (item.type === 'manga') {
      // The manga screen serves every source and picks its backend from
      // `source`; without it a saved manhwa or comic reopened as atsu. Only a
      // key the registry knows is passed on — the stored value round-trips
      // through cloud sync — and items saved before `source` existed have
      // none, which correctly means atsu.
      const adapter = getScrapedAdapter(item.source);
      router.push({
        pathname: '/manga/[id]',
        params: { id: item.id, ...(adapter ? { source: adapter.key } : {}) },
      });
    } else {
      router.push(`/${item.type}/${item.id}` as any);
    }
  };

  const styles = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      marginBottom: Spacing.md,
    },
    backBtn: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
    heading: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: 34,
      color: colors.text,
      letterSpacing: 0.3,
    },
    tabRow: {
      flexDirection: 'row',
      paddingHorizontal: Spacing.md,
      gap: Spacing.sm,
      marginBottom: Spacing.md,
    },
    tab: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: Radius.full,
      backgroundColor: colors.white,
      ...Shadow.sm,
    },
    tabActive: { backgroundColor: colors.primary },
    tabText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: colors.textSecondary },
    tabTextActive: { color: colors.white, fontWeight: FontWeight.semibold },
    searchWrap: { paddingHorizontal: Spacing.md, marginBottom: Spacing.md, gap: 8 },
    searchField: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: 12, borderRadius: Radius.md,
      backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1,
      maxWidth: 480,
    },
    searchInput: { flex: 1, minWidth: 0, height: 42, color: colors.text, fontFamily: Fonts.body, fontSize: FontSize.sm },
    clearSearch: { width: 30, height: 34, alignItems: 'center', justifyContent: 'center' },
    resultsHint: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.body },
    list: { paddingHorizontal: Spacing.md, paddingBottom: 120 },
    continueWrap: { marginBottom: Spacing.md, marginHorizontal: -Spacing.md },
    cardProgressTrack: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      height: 3,
      backgroundColor: 'rgba(0,0,0,0.15)',
    },
    cardProgressFill: {
      height: '100%',
      backgroundColor: colors.primary,
    },
    continueHint: {
      fontSize: 10,
      fontWeight: FontWeight.semibold,
      color: colors.primary,
    },
    row: { gap: Spacing.sm, marginBottom: Spacing.sm },
    card: {
      flex: isWeb ? undefined : 1,
      borderRadius: Radius.lg,
      overflow: 'hidden',
      backgroundColor: colors.white,
      ...Shadow.sm,
    },
    cardInner: { flex: 1 },
    cover: {
      width: '100%',
      aspectRatio: 0.7,
      borderTopLeftRadius: Radius.lg,
      borderTopRightRadius: Radius.lg,
    },
    cardInfo: { padding: Spacing.sm, gap: 6 },
    cardTitle: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: colors.text,
      lineHeight: 18,
    },
    typeBadge: {
      alignSelf: 'flex-start',
      backgroundColor: `${colors.primary}18`,
      borderRadius: Radius.full,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    typeText: {
      fontSize: 10,
      fontWeight: FontWeight.bold,
      color: colors.primary,
      textTransform: 'capitalize',
    },
    empty: {
      flex: 1,
      justifyContent: 'center',
    },
  }), [colors, isWeb]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}
      onLayout={isWeb ? event => setLayoutWidth(event.nativeEvent.layout.width) : undefined}>
      <Animated.View entering={FadeInDown.duration(400)}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onTap(() => router.replace('/profile'))} style={styles.backBtn} activeOpacity={0.7}>
            <BackIcon color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.heading}>My Library</Text>
          <View style={{ width: 40 }} />
        </View>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(80).duration(400)} style={styles.tabRow}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </Animated.View>

      {isWeb && <View style={styles.searchWrap}>
        <View style={styles.searchField}>
          <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
            <Path d="m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0" stroke={colors.textSecondary} strokeWidth={1.7} strokeLinecap="round" />
          </Svg>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search saved titles"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Search saved titles"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={styles.searchInput}
          />
          {search.length > 0 && <TouchableOpacity onPress={() => setSearch('')} style={styles.clearSearch} accessibilityLabel="Clear library search">
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none"><Path d="m6 6 12 12M18 6 6 18" stroke={colors.textSecondary} strokeWidth={2} strokeLinecap="round" /></Svg>
          </TouchableOpacity>}
        </View>
        <Text style={styles.resultsHint} accessibilityLiveRegion="polite">
          {filtered.length} {query ? `match${filtered.length === 1 ? '' : 'es'}` : `saved title${filtered.length === 1 ? '' : 's'}`}{tab === 'All' ? '' : ` in ${tab}`}
        </Text>
      </View>}

      {filtered.length === 0 && !showContinueHeader ? (
        <EmptyState
          style={styles.empty}
          title={query ? 'No matching saved titles' : isWeb && tab !== 'All' ? `No saved ${tab.toLowerCase()} yet` : 'Nothing saved yet'}
          subtitle={query ? `Try another title${tab !== 'All' ? ' or choose All' : ''}, or clear your search.` : 'Tap the bookmark icon on any anime, manga, or novel to save it here.'}
        />
      ) : (
        <FlatList
          key={`library-${columns}`}
          ref={listRef}
          data={filtered}
          keyExtractor={(i) => `${i.type}-${i.id}`}
          numColumns={columns}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          scrollIndicatorInsets={{ bottom: 90 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />
          }
          ListHeaderComponent={
            showContinueHeader ? (
              <Animated.View entering={FadeInDown.duration(350)} style={styles.continueWrap}>
                {showContinueWatch && <ContinueWatchingRow items={continueAnime} />}
                {showContinueRead && <ContinueReadingRow items={filteredReading} />}
              </Animated.View>
            ) : null
          }
          renderItem={({ item, index }) => {
            const cont = item.type === 'anime' ? continueByAnimeId.get(item.id) : undefined;
            const pct = cont && cont.progress > 0.02 ? Math.round(cont.progress * 100) : 0;
            return (
              <Animated.View entering={FadeInDown.delay(isWeb ? Math.min(index, 8) * 35 : index * 60).duration(400)} style={[styles.card, isWeb && { flexBasis: webCardWidth, flexGrow: 0, flexShrink: 0, width: webCardWidth }]}>
                <TouchableOpacity
                  onPress={() => navigate(item)}
                  activeOpacity={0.9}
                  style={styles.cardInner}
                >
                  <Image
                    source={{ uri: item.cover }}
                    style={styles.cover}
                    contentFit="cover"
                    transition={300}
                  />
                  {pct > 0 && (
                    <View style={styles.cardProgressTrack}>
                      <View style={[styles.cardProgressFill, { width: `${pct}%` }]} />
                    </View>
                  )}
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    {pct > 0 ? (
                      <Text style={styles.continueHint}>
                        Continue Ep {cont!.episodeNumber} · {pct}%
                      </Text>
                    ) : null}
                    <View style={styles.typeBadge}>
                      <Text style={styles.typeText}>{item.type}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              </Animated.View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
