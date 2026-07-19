import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { playTap, onTap } from '@/lib/sound';
import {
  fetchMangaPagedList,
  searchManga,
  toContentItem,
} from '@/lib/manga';
import { fetchTrendingComics, searchComics } from '@/lib/comics';
import { fetchTrendingHentai, searchHentai } from '@/lib/hentai';
import { useTheme } from '@/lib/theme';
import { Spacing, Radius, FontSize, FontWeight, Colors, Shadow } from '@/constants/theme';
import { ContentItem } from '@/components/ui/ContentCard';

const { width: W } = Dimensions.get('window');
const COLS = 3;
const H_PAD = Spacing.md;
const GAP = 8;
const ITEM_W = (W - H_PAD * 2 - GAP * (COLS - 1)) / COLS;
const ITEM_H = ITEM_W * 1.5;
const PAGE_SIZE = 60;

type BrowseSource = 'manga' | 'comics' | 'hentai';

/**
 * Fetch one page of a section's content, honouring the section's *source*
 * (manga / comics / 18+) and its query, rather than always falling back to the
 * manga catalogue. `q` drives the genre sections (search), while `kind` drives
 * the catalogue sections (New Releases / Today's Pick / Trending / Popular).
 * Only the paginated manga catalogue reports `hasMore`; every other source
 * returns a single generous batch.
 */
async function loadBrowse(
  source: BrowseSource,
  q: string,
  kind: string,
  page: number,
): Promise<{ items: ContentItem[]; hasMore: boolean }> {
  if (source === 'comics') {
    const items = q ? await searchComics(q, PAGE_SIZE) : await fetchTrendingComics(PAGE_SIZE);
    return { items, hasMore: false };
  }
  if (source === 'hentai') {
    const items = q ? await searchHentai(q, PAGE_SIZE) : await fetchTrendingHentai(PAGE_SIZE);
    return { items, hasMore: false };
  }
  if (q) {
    const raw = await searchManga(q, PAGE_SIZE);
    return { items: raw.map((i) => toContentItem(i)), hasMore: false };
  }
  const pagedKind = kind === 'trending' ? 'trending' : 'popular';
  const raw = await fetchMangaPagedList(pagedKind, page);
  return { items: raw.map((i) => toContentItem(i)), hasMore: raw.length > 0 };
}

function GridCard({ item }: { item: ContentItem }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={[gc.wrap, { width: ITEM_W, height: ITEM_H }]}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        playTap();
        if (item.type === 'manga' && item.source && item.source !== 'manga') {
          router.push({ pathname: '/manga/[id]', params: { id: item.id, source: item.source } } as any);
        } else {
          router.push(`/${item.type}/${item.id}` as any);
        }
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

export default function BrowseScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    title?: string;
    source?: string;
    q?: string;
    kind?: string;
  }>();

  const title = typeof params.title === 'string' && params.title ? params.title : 'Browse';
  const source: BrowseSource =
    params.source === 'comics' || params.source === 'hentai' ? params.source : 'manga';
  const q = typeof params.q === 'string' ? params.q : '';
  const kind = typeof params.kind === 'string' ? params.kind : '';

  const [items, setItems] = useState<ContentItem[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadPage = useCallback(
    async (p: number) => {
      try {
        const { items: mapped, hasMore: more } = await loadBrowse(source, q, kind, p);
        if (mapped.length === 0) {
          setHasMore(false);
          return;
        }
        setItems((prev) => (p === 0 ? mapped : [...prev, ...mapped]));
        setHasMore(more);
      } catch {
        setHasMore(false);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [source, q, kind],
  );

  useEffect(() => {
    loadPage(0);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading) return;
    const next = page + 1;
    setPage(next);
    setLoadingMore(true);
    loadPage(next);
  }, [loadingMore, hasMore, loading, page, loadPage]);

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
          <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
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
                <Text style={{ color: colors.textSecondary }}>Nothing here yet.</Text>
              </View>
            }
            ListFooterComponent={
              loadingMore ? (
                <View style={s.footer}>
                  <ActivityIndicator color={colors.primary} size="small" />
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
    flex: 1,
    textAlign: 'center',
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
