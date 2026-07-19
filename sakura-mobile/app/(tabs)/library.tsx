import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Image } from 'expo-image';
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

  const filtered =
    tab === 'All' ? items : items.filter((i) => i.type === tab.toLowerCase() as LibraryItem['type']);

  const showContinueWatch = continueAnime.length > 0 && (tab === 'All' || tab === 'Anime');
  const filteredReading = useMemo(() => {
    if (tab === 'Manga') return continueReading.filter((i) => i.kind === 'manga');
    if (tab === 'Novel') return continueReading.filter((i) => i.kind === 'novel');
    return continueReading;
  }, [continueReading, tab]);
  const showContinueRead = filteredReading.length > 0 && (tab === 'All' || tab === 'Manga' || tab === 'Novel');
  const showContinueHeader = showContinueWatch || showContinueRead;

  const continueByAnimeId = useMemo(
    () => new Map(continueAnime.map((c) => [c.animeId, c])),
    [continueAnime],
  );

  const navigate = (item: LibraryItem) => {
    playTap();
    if (item.type === 'novel') {
      router.push(`/novel/ext?path=${encodeURIComponent(item.id)}` as any);
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
      flex: 1,
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
  }), [colors]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
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

      {filtered.length === 0 && !showContinueHeader ? (
        <EmptyState
          style={styles.empty}
          title="Nothing saved yet"
          subtitle="Tap the bookmark icon on any anime, manga, or novel to save it here."
        />
      ) : (
        <FlatList
          ref={listRef}
          data={filtered}
          keyExtractor={(i) => `${i.type}-${i.id}`}
          numColumns={2}
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
              <Animated.View entering={FadeInDown.delay(index * 60).duration(400)} style={styles.card}>
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

