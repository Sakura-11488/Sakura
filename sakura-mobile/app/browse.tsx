import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Platform,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Image from '@/components/ui/CoverImage';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { playTap, onTap } from '@/lib/sound';
import {
  ATSU_GENRES,
  MANGA_BROWSE_SORTS,
  browseManga,
  fetchMangaPagedList,
  searchManga,
  toContentItem,
  type MangaBrowseSort,
  type MangaBrowseStatus,
} from '@/lib/manga';
import { getScrapedAdapter, asScrapedSource, type ScrapedSource } from '@/lib/scraped-sources';
import { useTheme } from '@/lib/theme';
import { Spacing, Radius, FontSize, FontWeight, Colors, Shadow } from '@/constants/theme';
import { ContentItem } from '@/components/ui/ContentCard';
import BrowseCatalogWeb from '@/components/discovery/BrowseCatalogWeb';
import { contentWidth } from '@/constants/layout';

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
const PAGE_SIZE = 60;

type BrowseSource = 'manga' | ScrapedSource;

/** Filters for the atsu catalogue (lib/manga browseManga). Empty strings mean "any". */
export type BrowseFilters = { genre: string; status: '' | MangaBrowseStatus; sort: '' | MangaBrowseSort };

const STATUSES: MangaBrowseStatus[] = ['Ongoing', 'Completed', 'Hiatus'];
function asStatus(value: unknown): '' | MangaBrowseStatus {
  return STATUSES.includes(value as MangaBrowseStatus) ? (value as MangaBrowseStatus) : '';
}
function asSort(value: unknown): '' | MangaBrowseSort {
  return MANGA_BROWSE_SORTS.some((s) => s.id === value) ? (value as MangaBrowseSort) : '';
}
function asGenre(value: unknown): string {
  return typeof value === 'string' && ATSU_GENRES.some((g) => g.id === value) ? value : '';
}

/**
 * Fetch one page of a section's content, honouring the section's *source*
 * (manga or any scraped source) and its query, rather than always falling back
 * to the manga catalogue. `q` drives the genre sections (search), while `kind`
 * drives the catalogue sections (New Releases / Today's Pick / Trending /
 * Popular). The paginated manga catalogue and scraped sources with a paged
 * `browse` (manhwa) report `hasMore`; every other source returns a single
 * generous batch.
 */
async function loadBrowse(
  source: BrowseSource,
  q: string,
  kind: string,
  page: number,
  filters: BrowseFilters,
): Promise<{ items: ContentItem[]; hasMore: boolean; found?: number }> {
  const adapter = getScrapedAdapter(source);
  // A genre, status or explicit order: atsu's own catalogue, filtered
  // (Typesense, paged). Genre shelves used to be title searches.
  if (!adapter && !q && (filters.genre || filters.status || filters.sort)) {
    const result = await browseManga(
      { genreId: filters.genre || null, status: filters.status || null, sort: filters.sort || 'popular' },
      page,
      PAGE_SIZE,
    );
    return { items: result.items.map((i) => toContentItem(i)), hasMore: result.hasMore, found: result.found };
  }
  if (adapter?.browse) return adapter.browse(page, PAGE_SIZE, q || undefined);
  if (adapter) {
    const items = q ? await adapter.search(q, PAGE_SIZE) : await adapter.trending(PAGE_SIZE);
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
  const { ITEM_W, ITEM_H } = useGridMetrics();
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
    genre?: string;
    status?: string;
    sort?: string;
  }>();

  const paramTitle = typeof params.title === 'string' && params.title ? params.title : 'Browse';
  const source: BrowseSource = asScrapedSource(params.source) ?? 'manga';
  const q = typeof params.q === 'string' ? params.q : '';
  const kind = typeof params.kind === 'string' ? params.kind : '';
  const paramGenre = asGenre(params.genre);
  // The atsu catalogue can be filtered from this screen; scraped sources and
  // searches cannot (their upstreams have no such filters).
  const filterable = source === 'manga' && !q;
  const [filters, setFilters] = useState<BrowseFilters>(() => ({
    genre: paramGenre,
    status: asStatus(params.status),
    sort: asSort(params.sort),
  }));
  // A new route (another genre's "See all") resets them; the same values keep
  // the same object, so mounting does not load page 0 twice.
  useEffect(() => {
    const next: BrowseFilters = { genre: paramGenre, status: asStatus(params.status), sort: asSort(params.sort) };
    setFilters((prev) => (prev.genre === next.genre && prev.status === next.status && prev.sort === next.sort ? prev : next));
  }, [paramGenre, params.status, params.sort]);
  const [found, setFound] = useState<number | null>(null);
  // Picking another genre here retitles the page after it.
  const title = filters.genre && filters.genre !== paramGenre
    ? ATSU_GENRES.find((g) => g.id === filters.genre)?.name ?? paramTitle
    : paramTitle;

  const [items, setItems] = useState<ContentItem[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  // Sources that list one series under several ids (manhwa: `mr:` and `cz:`)
  // also dedupe by title, so a series met again on a later page is not shown
  // twice. A stable function from the registry, so it does not churn loadPage.
  const titleKey = getScrapedAdapter(source)?.titleKey;

  const loadPage = useCallback(
    async (p: number) => {
      const version = ++requestVersion.current;
      setError('');
      try {
        const { items: mapped, hasMore: more, found: total } = await loadBrowse(source, q, kind, p, filters);
        if (version !== requestVersion.current) return;
        if (p === 0) setFound(typeof total === 'number' ? total : null);
        if (mapped.length === 0) {
          if (p === 0) setItems([]);
          setHasMore(false);
          return;
        }
        setItems((prev) => {
          const seen = new Set<string>();
          return (p === 0 ? mapped : [...prev, ...mapped]).filter(item => {
            const key = `${item.source}-${item.id}`;
            const tk = titleKey?.(item.title);
            const tKey = tk ? `${item.source}~${tk}` : '';
            if (seen.has(key) || (tKey && seen.has(tKey))) return false;
            seen.add(key);
            if (tKey) seen.add(tKey);
            return true;
          });
        });
        setPage(p);
        setHasMore(more);
      } catch {
        if (version !== requestVersion.current) return;
        setError('This shelf could not load. Please try again.');
      } finally {
        if (version === requestVersion.current) { setLoading(false); setLoadingMore(false); }
      }
    },
    [source, q, kind, titleKey, filters],
  );

  useEffect(() => {
    setLoading(true); setPage(0); setItems([]); setHasMore(true);
    loadPage(0);
    return () => { requestVersion.current += 1; };
  }, [loadPage]);

  // `page` only advances when a page loads, so until one has, the next page to
  // ask for is 0 again — not `page + 1`. After a failed first page the native
  // FlatList fires onEndReached on its empty list, and `page + 1` silently
  // skipped page 0 (for manhwa: /popular and the first discovery words).
  const nextPage = items.length ? page + 1 : 0;

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    loadPage(nextPage);
  }, [loadingMore, hasMore, loading, nextPage, loadPage]);

  const retry = useCallback(() => {
    if (loading || loadingMore) return;
    if (!items.length) setLoading(true); else setLoadingMore(true);
    void loadPage(nextPage);
  }, [loading, loadingMore, items.length, nextPage, loadPage]);

  const filterProps = filterable ? {
    genres: ATSU_GENRES,
    sorts: MANGA_BROWSE_SORTS,
    statuses: STATUSES,
    value: filters,
    onChange: (next: Partial<BrowseFilters>) => setFilters((prev) => ({ ...prev, ...next })),
  } : undefined;

  if (Platform.OS === 'web') return <BrowseCatalogWeb key={`${source}-${q}-${kind}`} title={title} source={source} items={items} loading={loading} loadingMore={loadingMore} hasMore={hasMore} error={error} found={found} filters={filterProps} onBack={() => router.canGoBack() ? router.back() : router.replace('/home')} onRetry={retry} onLoadMore={loadMore}/>;

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

        {filterProps && (
          <View style={s.filterBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
              {[{ id: '', name: 'All genres' }, ...ATSU_GENRES].map((g) => {
                const active = filters.genre === g.id;
                return (
                  <TouchableOpacity
                    key={g.id || 'all'}
                    onPress={() => setFilters((prev) => ({ ...prev, genre: g.id }))}
                    style={[s.chip, { borderColor: colors.border }, active && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[s.chipText, { color: active ? '#fff' : colors.textSecondary }]}>{g.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
              {[{ id: '' as const, label: 'Any status' }, ...STATUSES.map((st) => ({ id: st, label: st }))].map((st) => {
                const active = filters.status === st.id;
                return (
                  <TouchableOpacity
                    key={st.id || 'any'}
                    onPress={() => setFilters((prev) => ({ ...prev, status: st.id }))}
                    style={[s.chip, { borderColor: colors.border }, active && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[s.chipText, { color: active ? '#fff' : colors.textSecondary }]}>{st.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <View style={{ width: 10 }} />
              {MANGA_BROWSE_SORTS.map((so) => {
                const active = (filters.sort || 'popular') === so.id && !!(filters.genre || filters.status || filters.sort);
                return (
                  <TouchableOpacity
                    key={so.id}
                    onPress={() => setFilters((prev) => ({ ...prev, sort: so.id }))}
                    style={[s.chip, { borderColor: colors.border }, active && { backgroundColor: colors.text, borderColor: colors.text }]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[s.chipText, { color: active ? colors.background : colors.textSecondary }]}>{so.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

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
                <Text style={{ color: colors.textSecondary }}>{error || 'Nothing here yet.'}</Text>
                {!!error && (
                  <TouchableOpacity onPress={onTap(retry)} style={s.retryBtn} hitSlop={8}>
                    <Text style={[s.retryText, { color: colors.primary }]}>Try again</Text>
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
                // Without this a failed "load more" was invisible on native:
                // onEndReached does not fire again for the same content, so
                // the grid just stopped with no way to continue.
                <View style={s.footer}>
                  <Text style={{ color: colors.textSecondary }}>{error}</Text>
                  <TouchableOpacity onPress={onTap(retry)} style={s.retryBtn} hitSlop={8}>
                    <Text style={[s.retryText, { color: colors.primary }]}>Try again</Text>
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
  filterBar: { paddingTop: Spacing.sm, gap: 6 },
  chipRow: { paddingHorizontal: H_PAD, gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  chipText: { fontSize: 12, fontWeight: FontWeight.semibold },
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
  retryBtn: {
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  retryText: {
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
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
