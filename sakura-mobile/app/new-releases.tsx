import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Image from '@/components/ui/CoverImage';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { playTap, onTap } from '@/lib/sound';
import { fetchRecentlyUpdatedManga, toContentItem } from '@/lib/manga';
import { formatReleaseDate } from '@/lib/format-release-date';
import { rememberMangaPreviews } from '@/lib/manga-prefetch';
import BrowseCatalogWeb from '@/components/discovery/BrowseCatalogWeb';
import { useTheme } from '@/lib/theme';
import { Spacing, Radius, FontSize, FontWeight, Colors, Shadow } from '@/constants/theme';
import { ContentItem } from '@/components/ui/ContentCard';
import { contentWidth } from '@/constants/layout';

/**
 * Titles that just got a new chapter, newest first, with how long ago.
 *
 * This screen used to list atsu's POPULAR titles under the name "New
 * Releases" (Witch Hat Atelier, The Knight Only Lives Today…), and the
 * new-releases push opens it. It now reads atsu's recently-updated feed
 * (lib/manga fetchRecentlyUpdatedManga, comics only), 40 a page.
 */
const PAGE_SIZE = 40;

const COLS = 3;
const H_PAD = Spacing.md;
const GAP = 8;

/**
 * Grid metrics, read reactively.
 *
 * These were module constants derived from a Dimensions.get('window') captured
 * once at bundle evaluation; nothing in the app re-reads it. On desktop web the
 * sidebar is a sibling of the content column, so the card width comes from
 * contentWidth() rather than the raw window width — sizing off the window
 * overflows by exactly SIDEBAR_WIDTH.
 */
function useGridMetrics() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    const ITEM_W = (W - H_PAD * 2 - GAP * (COLS - 1)) / COLS;
    return { ITEM_W, ITEM_H: ITEM_W * 1.5 };
  }, [windowW]);
}

function GridCard({ item }: { item: ContentItem }) {
  const { ITEM_W, ITEM_H } = useGridMetrics();
  const router = useRouter();
  return (
    <TouchableOpacity
      style={[gc.wrap, { width: ITEM_W, height: ITEM_H }]}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        playTap();
        router.push(`/${item.type}/${item.id}` as any);
      }}
      activeOpacity={0.88}
    >
      <Image source={{ uri: item.cover }} style={gc.img} contentFit="cover" transition={300} />
      {item.badge && (
        <View style={gc.badge}>
          <Text style={gc.badgeText}>{item.badge}</Text>
        </View>
      )}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.78)']} style={gc.grad} />
      <Text style={gc.title} numberOfLines={2}>{item.title}</Text>
    </TouchableOpacity>
  );
}

export default function NewReleasesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [items, setItems] = useState<ContentItem[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');

  const loadPage = useCallback(async (p: number) => {
    setError('');
    try {
      const raw = await fetchRecentlyUpdatedManga(p, PAGE_SIZE);
      if (raw.length === 0) {
        setHasMore(false);
        return;
      }
      // The badge says when: "12m ago", "Yesterday".
      const mapped = raw.map((i) => toContentItem(i, i.updatedAt ? formatReleaseDate(i.updatedAt) : undefined));
      rememberMangaPreviews(mapped);
      setItems((prev) => {
        const all = p === 0 ? mapped : [...prev, ...mapped];
        // A title updated again between two page loads moves up the feed and
        // would show twice; keep its newest position.
        const seen = new Set<string>();
        return all.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
      });
      setPage(p);
      setHasMore(raw.length >= PAGE_SIZE);
    } catch {
      setError('Latest updates could not load. Please try again.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadPage(0);
  }, [loadPage]);

  const nextPage = items.length ? page + 1 : 0;
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading || error) return;
    setLoadingMore(true);
    loadPage(nextPage);
  }, [loadingMore, hasMore, loading, error, nextPage, loadPage]);

  const retry = useCallback(() => {
    if (!items.length) setLoading(true); else setLoadingMore(true);
    void loadPage(nextPage);
  }, [items.length, nextPage, loadPage]);

  if (Platform.OS === 'web') {
    return <BrowseCatalogWeb title="Latest updates" eyebrow="New chapters, newest first" source="manga" items={items} loading={loading} loadingMore={loadingMore} hasMore={hasMore} error={error} badgeSubtitle onBack={() => router.canGoBack() ? router.back() : router.replace('/home')} onRetry={retry} onLoadMore={loadMore}/>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={[s.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onTap(() => router.back())} style={s.backBtn} hitSlop={12}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path
                d="M19 12H5M12 19l-7-7 7-7"
                stroke={colors.text}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </TouchableOpacity>
          <Text style={[s.headerTitle, { color: colors.text }]}>Latest Updates</Text>
          <View style={{ width: 40 }} />
        </View>

        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item, index) => `${item.id}-${index}`}
            numColumns={COLS}
            contentContainerStyle={s.grid}
            columnWrapperStyle={s.row}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => <GridCard item={item} />}
            ListEmptyComponent={
              <View style={s.center}>
                <Text style={{ color: colors.textSecondary }}>{error || 'Nothing new yet.'}</Text>
                {!!error && (
                  <TouchableOpacity onPress={onTap(retry)} style={{ padding: 12 }} hitSlop={8}>
                    <Text style={{ color: colors.primary, fontWeight: FontWeight.semibold }}>Try again</Text>
                  </TouchableOpacity>
                )}
              </View>
            }
            ListFooterComponent={
              loadingMore ? (
                <View style={s.footer}>
                  <ActivityIndicator color={colors.primary} size="small" />
                </View>
              ) : error && items.length > 0 ? (
                <View style={s.footer}>
                  <Text style={{ color: colors.textSecondary }}>{error}</Text>
                  <TouchableOpacity onPress={onTap(retry)} style={{ padding: 12 }} hitSlop={8}>
                    <Text style={{ color: colors.primary, fontWeight: FontWeight.semibold }}>Try again</Text>
                  </TouchableOpacity>
                </View>
              ) : null
            }
          />
        )}
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: H_PAD,
    paddingVertical: Spacing.sm + 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  grid: {
    padding: H_PAD,
    paddingBottom: 110,
  },
  row: {
    gap: GAP,
    marginBottom: GAP + 4,
  },
  footer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
});

const gc = StyleSheet.create({
  wrap: {
    borderRadius: Radius.md,
    overflow: 'hidden',
    backgroundColor: Colors.border,
    ...Shadow.sm,
  },
  img: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    color: Colors.white,
    fontSize: 9,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.4,
  },
  grad: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '55%',
  },
  title: {
    position: 'absolute',
    bottom: 7,
    left: 7,
    right: 7,
    color: Colors.white,
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    lineHeight: 13,
  },
});
