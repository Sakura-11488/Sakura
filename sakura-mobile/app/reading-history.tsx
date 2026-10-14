import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import Image from '@/components/ui/CoverImage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import EmptyState from '@/components/ui/EmptyState';
import {
  clearReadingHistory,
  formatHistoryTime,
  getReadingHistory,
  type HistoryItem,
  type HistoryKind,
} from '@/lib/reading-history';
import { subscribeReadingProgress } from '@/lib/reader-progress';
import { subscribeWatchProgress } from '@/lib/watch-progress';
import { useFocusedSubscription } from '@/lib/hooks/useFocusedSubscription';
import { confirmDestructive } from '@/lib/confirm-alert';
import { onTap, playTap } from '@/lib/sound';

const TABS: Array<'All' | 'Anime' | 'Manga' | 'Novel'> = ['All', 'Anime', 'Manga', 'Novel'];

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function kindLabel(kind: HistoryKind): string {
  if (kind === 'anime') return 'Anime';
  if (kind === 'manga') return 'Manga';
  return 'Novel';
}

function kindColor(kind: HistoryKind): string {
  if (kind === 'anime') return '#007AFF';
  if (kind === 'manga') return '#34C759';
  return '#AF52DE';
}

export default function ReadingHistoryScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<'All' | 'Anime' | 'Manga' | 'Novel'>('All');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void getReadingHistory(100).then((history) => {
      setItems(history);
      setError('');
    }).catch(() => setError('Your history could not be loaded.')).finally(() => setLoading(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // Only while focused: the reader and player save progress every few
  // seconds, and the focus effect above already reloads on return.
  useFocusedSubscription(subscribeReadingProgress, refresh);
  useFocusedSubscription(subscribeWatchProgress, refresh);

  const filtered = useMemo(() => {
    if (tab === 'All') return items;
    const kind = tab.toLowerCase() as HistoryKind;
    return items.filter((i) => i.kind === kind);
  }, [items, tab]);

  const openItem = (item: HistoryItem) => {
    playTap();
    if (item.kind === 'anime' && item.animeId && item.episodeId) {
      router.push({
        pathname: '/anime/watch',
        params: { id: item.animeId, ep: item.episodeId },
      });
      return;
    }
    if (item.kind === 'manga' && item.mangaId && item.chapterId) {
      router.push({
        pathname: '/chapter/[id]',
        params: {
          id: `${item.mangaId}~${item.chapterId}`,
          p: String(item.page || 1),
          title: item.title,
          cover: item.cover || '',
          ...(item.source ? { source: item.source } : {}),
        },
      });
      return;
    }
    if (item.kind === 'novel' && item.novelPath) {
      router.push({
        pathname: '/novel/read',
        params: {
          path: item.novelPath,
          o: String(item.novelOffsetY ?? 0),
          title: item.title,
          cover: item.cover || '',
        },
      });
    }
  };

  const confirmClear = () => {
    confirmDestructive(
      'Clear history?',
      'This removes your watch and read progress on this device.',
    ).then((ok) => {
      if (ok) clearReadingHistory().then(refresh).catch(() => setError('History could not be cleared. Please try again.'));
    });
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        headerRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: Spacing.md,
          paddingTop: Spacing.sm,
          marginBottom: Spacing.md,
        },
        backBtn: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
        heading: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 28,
          color: colors.text,
          letterSpacing: 0.3,
        },
        clearBtn: {
          paddingHorizontal: 10,
          minHeight: 44,
          justifyContent: 'center',
        },
        clearText: {
          fontSize: FontSize.sm,
          fontWeight: FontWeight.semibold,
          color: colors.primary,
        },
        tabRow: {
          flexDirection: 'row',
          paddingHorizontal: Spacing.md,
          gap: Spacing.sm,
          marginBottom: Spacing.md,
        },
        tab: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: Radius.full,
          backgroundColor: colors.surfaceSecondary,
        },
        tabActive: { backgroundColor: colors.primary },
        tabText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: colors.textSecondary },
        tabTextActive: { color: colors.white, fontWeight: FontWeight.semibold },
        list: { paddingHorizontal: Spacing.md, paddingBottom: 120 },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: Spacing.sm,
          paddingVertical: Spacing.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
        },
        thumb: {
          width: 56,
          height: 76,
          borderRadius: Radius.sm,
          backgroundColor: colors.surfaceSecondary,
        },
        body: { flex: 1, minWidth: 0, gap: 4 },
        topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        title: {
          flex: 1,
          fontSize: FontSize.md,
          fontWeight: FontWeight.semibold,
          color: colors.text,
        },
        time: {
          fontSize: FontSize.xs,
          color: colors.textTertiary,
        },
        subtitle: {
          fontSize: FontSize.sm,
          color: colors.textSecondary,
        },
        badge: {
          alignSelf: 'flex-start',
          borderRadius: Radius.full,
          paddingHorizontal: 8,
          paddingVertical: 2,
        },
        badgeText: {
          fontSize: 10,
          fontWeight: FontWeight.bold,
          color: '#fff',
          textTransform: 'uppercase',
        },
        track: {
          height: 3,
          borderRadius: 2,
          backgroundColor: `${colors.primary}22`,
          overflow: 'hidden',
          marginTop: 2,
        },
        fill: {
          height: '100%',
          backgroundColor: colors.primary,
          borderRadius: 2,
        },
        empty: { flex: 1, justifyContent: 'center' },
        feedback: { padding: Spacing.lg, gap: 12, alignItems: 'center' },
      }),
    [colors],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Animated.View entering={Platform.OS === 'web' ? undefined : FadeInDown.duration(400)}>
        <View style={styles.headerRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={onTap(() => router.back())} style={styles.backBtn} activeOpacity={0.7}>
            <BackIcon color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.heading}>History</Text>
          {items.length > 0 ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear reading and watch history" onPress={onTap(confirmClear)} style={styles.clearBtn} activeOpacity={0.7}>
              <Text style={styles.clearText}>Clear</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ width: 52 }} />
          )}
        </View>
      </Animated.View>

      <Animated.View entering={Platform.OS === 'web' ? undefined : FadeInDown.delay(80).duration(400)} style={styles.tabRow}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
            onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </Animated.View>

      {error ? <View style={styles.feedback}>
        <Text accessibilityRole="alert" style={styles.subtitle}>{error}</Text>
        <TouchableOpacity accessibilityRole="button" onPress={refresh} style={styles.clearBtn}>
          <Text style={styles.clearText}>Try again</Text>
        </TouchableOpacity>
      </View> : null}
      {loading ? <View style={styles.feedback}><ActivityIndicator accessibilityLabel="Loading history" color={colors.primary} /></View> : filtered.length === 0 && !error ? (
        <EmptyState
          style={styles.empty}
          title={tab === 'All' ? 'No history yet' : `No ${tab.toLowerCase()} history yet`}
          subtitle={tab === 'All' ? 'Anime, manga, and novels you watch or read will show up here.' : `Your ${tab.toLowerCase()} progress will appear here when you start ${tab === 'Anime' ? 'watching' : 'reading'}.`}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          scrollIndicatorInsets={{ bottom: 90 }}
          renderItem={({ item, index }) => {
            const pct = Math.min(100, Math.max(0, Math.round(item.progress * 100)));
            const showBar = item.progress > 0 && item.progress < 0.98;
            return (
              <Animated.View entering={Platform.OS === 'web' ? undefined : FadeInDown.delay(Math.min(index, 5) * 40).duration(350)}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Continue ${item.title}, ${item.subtitle}`} style={styles.row} onPress={() => openItem(item)} activeOpacity={0.85}>
                  {item.cover ? (
                    <Image source={{ uri: item.cover }} thumbnailWidth={256} style={styles.thumb} contentFit="cover" />
                  ) : (
                    <View style={styles.thumb} />
                  )}
                  <View style={styles.body}>
                    <View style={styles.topLine}>
                      <Text style={styles.title} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.time}>{formatHistoryTime(item.updatedAt)}</Text>
                    </View>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {item.subtitle}
                    </Text>
                    <View style={[styles.badge, { backgroundColor: kindColor(item.kind) }]}>
                      <Text style={styles.badgeText}>{kindLabel(item.kind)}</Text>
                    </View>
                    {showBar && (
                      <View style={styles.track}>
                        <View style={[styles.fill, { width: `${pct}%` }]} />
                      </View>
                    )}
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
