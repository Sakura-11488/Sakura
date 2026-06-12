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
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { playTap, onTap } from '@/lib/sound';
import { fetchMangaPagedList, toContentItem } from '@/lib/manga';
import { useTheme } from '@/lib/theme';
import { Spacing, Radius, FontSize, FontWeight, Colors, Shadow } from '@/constants/theme';
import { ContentItem } from '@/components/ui/ContentCard';

const { width: W } = Dimensions.get('window');
const COLS = 3;
const H_PAD = Spacing.md;
const GAP = 8;
const ITEM_W = (W - H_PAD * 2 - GAP * (COLS - 1)) / COLS;
const ITEM_H = ITEM_W * 1.5;

function GridCard({ item }: { item: ContentItem }) {
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

  const loadPage = useCallback(async (p: number) => {
    try {
      const raw = await fetchMangaPagedList('popular', p);
      if (raw.length === 0) {
        setHasMore(false);
        return;
      }
      const mapped = raw.map((i) => toContentItem(i));
      setItems((prev) => (p === 0 ? mapped : [...prev, ...mapped]));
    } catch {
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

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
          <Text style={[s.headerTitle, { color: colors.text }]}>New Releases</Text>
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
    fontSize: FontSize.lg,
    fontWeight: FontWeight.bold,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
