import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { useScrollToTop, useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  interpolate,
  withTiming,
  Extrapolation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Circle } from 'react-native-svg';

import Header from '@/components/layout/Header';
import MangaHomeWeb from '@/components/discovery/MangaHomeWeb';
import CategoryTabs from '@/components/ui/CategoryTabs';
import ContentCard, { ContentItem } from '@/components/ui/ContentCard';
import SectionHeader from '@/components/ui/SectionHeader';
import ContinueWatchingRow from '@/components/ui/ContinueWatchingRow';
import ContinueReadingRow from '@/components/ui/ContinueReadingRow';
import { getContinueWatching, subscribeWatchProgress, type AnimeWatchProgress } from '@/lib/watch-progress';
import { getContinueReading, subscribeReadingProgress, type ContinueReadingItem } from '@/lib/reader-progress';
import { HomeScreenSkeleton } from '@/components/ui/ShimmerLoader';
import { Spacing, Radius } from '@/constants/theme';
import { Image } from 'expo-image';
import { useTheme } from '@/lib/theme';
import {
  fetchTrendingManga,
  fetchPopularManga,
  fetchHotUpdatedManga,
  browseManga,
  toContentItem,
  toCarouselItem,
} from '@/lib/manga';
import { formatReleaseDate } from '@/lib/format-release-date';
import { runWhenIdle } from '@/lib/manga-prefetch';
import { HOME_POPULAR_LIMIT, HOME_TRENDING_LIMIT, startHomeListsPreload, takeHomeListsPreload } from '@/lib/home-preload';
import { rememberMangaPreviews } from '@/lib/manga-prefetch';
import { useFocusedSubscription } from '@/lib/hooks/useFocusedSubscription';
import { visibleScrapedSources } from '@/lib/scraped-sources';
import { useContentPrefs } from '@/lib/content-prefs';
import { isWideWeb } from '@/constants/layout';
import { SAKURA_ORIGINALS } from '@/lib/sakura-originals';
import CreatorWorksRow from '@/components/creator/CreatorWorksRow';
import StreakLevelCard from '@/components/gamification/StreakLevelCard';
import FeaturedCarousel, { type CarouselItem } from '@/components/ui/FeaturedCarousel';

// Start the Manga tab's two lists now rather than after the first render
// (lib/home-preload explains when this helps and when it is too late).
startHomeListsPreload();

// Genre shelves for the atsu-backed Manga tab. The scraped sources carry their
// own set on their registry entry; this is the one case with no adapter.
//
// Real genres now (atsu genre ids, lib/manga ATSU_GENRES), not title
// searches: searchManga('action') matched TITLES, so "Action Packed" opened
// with "Action Idols" and "Action Mask" and nothing actually tagged Action.
// `query` stays for the row shape the scraped sources share.
type HomeRow = { title: string; query: string; genre?: string };
const MANGA_HOME_ROWS: HomeRow[] = [
  { title: 'Action Packed', query: 'action', genre: '39' },
  { title: 'Romance', query: 'romance', genre: '9' },
  { title: 'Boredom Busters', query: 'slice of life', genre: '7' },
  { title: 'Get Into Comedy', query: 'comedy', genre: '6' },
];
/** Fetched per genre shelf; titles already on an earlier shelf are skipped, then it is cut to SHELF_SIZE. */
const GENRE_FETCH = 24;
const SHELF_SIZE = 12;


// ─── Notification bell ────────────────────────────────────────────────────────
function BellIcon() {
  const { colors } = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"
        stroke={colors.text}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <Path d="M13.73 21a2 2 0 0 1-3.46 0" stroke={colors.text} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx="18" cy="5" r="3.5" fill={colors.primary} />
    </Svg>
  );
}

// ─── Horizontal content section ───────────────────────────────────────────────
function HorizSection({ data, title, onSeeAll }: { data: ContentItem[]; title: string; onSeeAll?: () => void }) {
  return (
    <Animated.View entering={FadeInDown.duration(350)}>
      <SectionHeader title={title} onSeeAll={onSeeAll} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={hs.list}
      >
        {data.map((item, i) => (
          <Animated.View key={item.id} entering={FadeInDown.delay(i * 55).duration(400)}>
            <ContentCard item={item} />
          </Animated.View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

function TrendingPopularSection({
  trending,
  popular,
}: {
  trending: ContentItem[];
  popular: ContentItem[];
}) {
  const [activeTab, setActiveTab] = useState<'trending' | 'popular'>('trending');
  const current = activeTab === 'trending' ? trending : popular;

  return (
    <Animated.View entering={FadeInDown.duration(350)}>
      <SectionHeader title="Trending & Popular Series" />
      <View style={tp.tabsWrap}>
        {(['trending', 'popular'] as const).map((tab) => {
          const active = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              style={[tp.tabPill, active && tp.tabPillActive]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.85}
            >
              <Text style={[tp.tabText, active && tp.tabTextActive]}>
                {tab === 'trending' ? 'Trending' : 'Popular'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={hs.list}>
        {current.map((item, i) => (
          <Animated.View key={`${activeTab}-${item.id}`} entering={FadeInDown.delay(i * 45).duration(360)}>
            <ContentCard item={item} />
          </Animated.View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

// ─── Sakura Originals section ─────────────────────────────────────────────────
const ORIG_CARD_W = 140;
const ORIG_CARD_H = ORIG_CARD_W * 1.46;

function OriginalsSection() {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <Animated.View entering={FadeInDown.duration(380)}>
      <View style={orig.header}>
        <Text style={[orig.title, { color: colors.text }]}>Sakura Originals</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 10, paddingBottom: 4 }}
      >
        {SAKURA_ORIGINALS.map((entry) => (
          <TouchableOpacity
            key={entry.id}
            style={[origCard.wrap, { backgroundColor: colors.border }]}
            onPress={() =>
              entry.type === 'novel'
                ? router.push(`/novel/ext?path=${encodeURIComponent(entry.id)}` as any)
                : router.push({ pathname: '/anime/[id]', params: { id: entry.id } } as any)
            }
            activeOpacity={0.85}
          >
            <Image source={entry.localImage} style={origCard.img} contentFit="cover" transition={300} />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.88)']} style={origCard.grad} />
            <View style={origCard.info}>
              <Text style={origCard.name} numberOfLines={2}>{entry.title}</Text>
              <Text style={origCard.label} numberOfLines={1}>{entry.label}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

const orig = StyleSheet.create({
  header: {
    paddingHorizontal: Spacing.md,
    marginBottom: 10,
  },
  title: { fontSize: 15, fontWeight: '800' },
});

const origCard = StyleSheet.create({
  wrap: {
    width: ORIG_CARD_W,
    height: ORIG_CARD_H,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  img: { width: '100%', height: '100%' },
  grad: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '65%' },
  info: { position: 'absolute', bottom: 10, left: 10, right: 10 },
  name: { color: '#fff', fontSize: 11, fontWeight: '700', lineHeight: 14 },
  label: { color: 'rgba(255,255,255,0.58)', fontSize: 9, fontWeight: '500', marginTop: 2 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const { colors } = useTheme();
  const { allowAdult } = useContentPrefs();
  const { width: windowW } = useWindowDimensions();
  // On desktop web the logo + wallet live in the sidebar, so drop the in-content header.
  const wideWeb = isWideWeb(windowW);
  const [category, setCategory] = useState('Manga');
  // Each shelf group shows as soon as its own list arrives: trending feeds
  // the featured slot, the hot list and the picks; popular feeds the popular
  // and "more" shelves. `loading` is "nothing has arrived yet".
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [popularLoading, setPopularLoading] = useState(true);
  const loading = trendingLoading && popularLoading;
  // Full-screen skeleton only on the very first load; switching category keeps the
  // existing content on screen (no jarring flash) while the new rows stream in.
  const hasLoadedOnce = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [featured, setFeatured] = useState<CarouselItem[]>([]);
  const [trending, setTrending] = useState<ContentItem[]>([]);
  const [popularSeries, setPopularSeries] = useState<ContentItem[]>([]);
  const [moreToExplore, setMoreToExplore] = useState<ContentItem[]>([]);
  const [trendingPicks, setTrendingPicks] = useState<ContentItem[]>([]);
  const [actionPacked, setActionPacked] = useState<ContentItem[]>([]);
  const [romance, setRomance] = useState<ContentItem[]>([]);
  const [boredmBusters, setBoredmBusters] = useState<ContentItem[]>([]);
  const [comedy, setComedy] = useState<ContentItem[]>([]);
  /** atsu's "Hot updates": popular titles that just got a chapter, with how long ago. */
  const [updates, setUpdates] = useState<ContentItem[]>([]);
  const router = useRouter();
  const [continueAnime, setContinueAnime] = useState<AnimeWatchProgress[]>([]);
  const [continueReading, setContinueReading] = useState<ContinueReadingItem[]>([]);
  const scrollRef = useRef<any>(null);
  useScrollToTop(scrollRef);
  const scrollY = useSharedValue(0);

  // Tabs are derived from the source registry rather than hardcoded, so a new
  // scraper appears here automatically instead of being silently unreachable.
  // Adult sources only surface once the user has opted in.
  const sources = useMemo(() => visibleScrapedSources(allowAdult), [allowAdult]);
  const categories = useMemo(() => ['Manga', ...sources.map((s) => s.label)], [sources]);
  const adapter = useMemo(
    () => sources.find((s) => s.label === category) ?? null,
    [sources, category],
  );
  // Four fixed shelves; atsu manga has no adapter so it keeps its own set.
  const homeRows: HomeRow[] = adapter?.homeRows ?? MANGA_HOME_ROWS;

  // Expand a home row into the full-grid browse screen, carrying the row's
  // source + query so it shows *that* section's content (not the manga
  // catalogue). `q` drives genre rows (search); `kind` drives catalogue rows.
  const browseSource = adapter?.key ?? 'manga';
  const goBrowse = useCallback(
    (title: string, opts: { q?: string; kind?: string; genre?: string }) =>
      router.push({
        pathname: '/browse',
        params: { title, source: browseSource, ...opts },
      } as any),
    [router, browseSource],
  );

  // If the selected tab disappears — turning off 18+ while it's open, or a
  // source being removed — fall back to Manga rather than showing an empty tab.
  useEffect(() => {
    if (!categories.includes(category)) setCategory('Manga');
  }, [categories, category]);

  const loadVersion = useRef(0);
  const loadData = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = () => version === loadVersion.current;
    if (adapter) {
      try {
        const list = await adapter.trending(40);
        if (!current()) return;
        const toCarousel = (c: ContentItem): CarouselItem => ({
          id: c.id,
          title: c.title,
          cover: c.cover,
          genres: [],
          type: 'manga',
          source: adapter.key,
        });
        rememberMangaPreviews(list);
        setFeatured(list.slice(0, 20).map(toCarousel));
        // Straight after the three featured titles: the hot list used to
        // start at item 8, skipping four of the most popular titles outright.
        setTrending(list.slice(3, 11));
        setPopularSeries(list.slice(0, 10).map((c) => ({ ...c, badge: 'HOT' })));
        setMoreToExplore(list.slice(10, 20));
        setTrendingPicks(list.slice(16, 24));
      } catch {
        if (current()) {
          setFeatured([]); setTrending([]); setPopularSeries([]);
          setMoreToExplore([]); setTrendingPicks([]);
        }
      } finally {
        if (current()) {
          hasLoadedOnce.current = true;
          setTrendingLoading(false);
          setPopularLoading(false);
          setRefreshing(false);
        }
      }
      return;
    }

    // Two independent halves rather than one Promise.all: the page used to
    // wait for the slower list (in one measured run popular took 3.2 s while
    // trending was back in 1 s) before showing either.
    const early = takeHomeListsPreload();
    const trendingDone = (early?.trending ?? fetchTrendingManga(HOME_TRENDING_LIMIT)).then((trend) => {
      if (!current()) return;
      const items = trend.slice(0, 24).map((i) => toContentItem(i));
      rememberMangaPreviews(items);
      setFeatured(trend.slice(0, 20).map(toCarouselItem));
      // After the three featured titles (see the scraped-source branch above).
      setTrending(items.slice(3, 11));
      setTrendingPicks(items.slice(16, 24));
    }, () => {
      if (!current()) return;
      setFeatured([]); setTrending([]); setTrendingPicks([]);
    }).finally(() => {
      if (current()) setTrendingLoading(false);
    });
    const popularDone = (early?.popular ?? fetchPopularManga(HOME_POPULAR_LIMIT)).then((pop) => {
      if (!current()) return;
      const items = pop.slice(0, 20).map((i) => toContentItem(i));
      rememberMangaPreviews(items);
      setPopularSeries(pop.slice(0, 10).map((i) => toContentItem(i, 'HOT')));
      setMoreToExplore(items.slice(10, 20));
    }, () => {
      if (!current()) return;
      setPopularSeries([]); setMoreToExplore([]);
    }).finally(() => {
      if (current()) setPopularLoading(false);
    });
    await Promise.all([trendingDone, popularDone]);
    if (current()) {
      hasLoadedOnce.current = true;
      setRefreshing(false);
    }
  }, [adapter]);

  useEffect(() => {
    setTrendingLoading(true);
    setPopularLoading(true);
  }, [category]);

  useEffect(() => {
    loadData();
    return () => { loadVersion.current += 1; };
  }, [loadData]);

  // Genre shelves, after the first lists so they never compete with what
  // is on screen; on web at idle too (they sit below the fold there). Web
  // used to skip them entirely.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    setActionPacked([]); setRomance([]); setBoredmBusters([]); setComedy([]);
    const setters = [setActionPacked, setRomance, setBoredmBusters, setComedy];
    const load = async () => {
      if (adapter) {
        const lists = await Promise.all(homeRows.slice(0, 4).map((row) => adapter.search(row.query, 12).catch(() => [] as ContentItem[])));
        if (cancelled) return;
        lists.forEach((list, i) => setters[i](list));
        return;
      }
      const lists = await Promise.all(homeRows.slice(0, 4).map((row) =>
        row.genre
          ? browseManga({ genreId: row.genre, sort: 'popular' }, 0, GENRE_FETCH).then((p) => p.items, () => [])
          : Promise.resolve([]),
      ));
      if (cancelled) return;
      // The biggest titles carry several genres; one shelf each is enough.
      const seen = new Set<string>();
      lists.forEach((list, i) => {
        const items = list.filter((it) => !seen.has(it.id)).slice(0, SHELF_SIZE);
        items.forEach((it) => seen.add(it.id));
        const cards = items.map((it) => toContentItem(it));
        rememberMangaPreviews(cards);
        setters[i](cards);
      });
    };
    const idle = Platform.OS === 'web' ? runWhenIdle(() => { void load(); }, 2500) : null;
    if (!idle) void load();
    return () => { cancelled = true; idle?.cancel(); };
  }, [loading, adapter, homeRows]);

  // "Latest updates" (atsu tab only): what just got a chapter, with how long ago.
  useEffect(() => {
    if (adapter || loading) return;
    let cancelled = false;
    const load = () => {
      fetchHotUpdatedManga(20).then((list) => {
        if (cancelled) return;
        const cards = list.map((it) => toContentItem(it, it.updatedAt ? formatReleaseDate(it.updatedAt) : undefined));
        rememberMangaPreviews(cards);
        setUpdates(cards);
      }, () => { if (!cancelled) setUpdates([]); });
    };
    const idle = Platform.OS === 'web' ? runWhenIdle(load, 2000) : null;
    if (!idle) load();
    return () => { cancelled = true; idle?.cancel(); };
  }, [adapter, loading]);

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

  useFocusEffect(
    useCallback(() => {
      refreshContinue();
    }, [refreshContinue]),
  );

  // Only while home is focused. The reader saves progress on every page turn
  // and the player every few seconds; home stays mounted under them, and each
  // save used to rebuild Continue Reading — and with it the whole web home —
  // out of sight. The focus effect above reloads both on return.
  useFocusedSubscription(subscribeWatchProgress, refreshContinueWatching);
  useFocusedSubscription(subscribeReadingProgress, refreshContinueReading);

  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const headerBarStyle = useAnimatedStyle(() => ({
    shadowOpacity: withTiming(
      interpolate(scrollY.value, [0, 30], [0, 0.1], Extrapolation.CLAMP),
      { duration: 120 },
    ),
  }));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
    refreshContinue();
  }, [loadData, refreshContinue]);

  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    topGrad: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 180,
      zIndex: 0,
    },
    safe: { flex: 1 },
    headerBar: {
      backgroundColor: 'transparent',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowRadius: 8,
      zIndex: 10,
    },
    scroll: { paddingTop: 4 },
    tabsWrap: {
      marginBottom: Spacing.sm,
      marginTop: Spacing.sm,
    },
    sectionGap: {
      marginTop: Spacing.md,
    },
  }), [colors]);

  if (Platform.OS === 'web') return <MangaHomeWeb
    category={category} categories={categories} onCategory={setCategory}
    featured={featured} trending={trending} popular={popularSeries}
    more={moreToExplore} picks={trendingPicks}
    genres={[actionPacked, romance, boredmBusters, comedy].map((items, index) => ({ ...homeRows[index], items }))}
    updates={adapter ? [] : updates} onUpdates={() => router.push('/new-releases' as any)}
    loading={loading} trendingLoading={trendingLoading} popularLoading={popularLoading}
    onRefresh={onRefresh} onBrowse={goBrowse}
    continueReading={continueReading.length > 0 ? <ContinueReadingRow items={continueReading} /> : null}
    continueWatching={continueAnime.length > 0 ? <ContinueWatchingRow items={continueAnime} /> : null}
    community={!adapter ? <><CreatorWorksRow kind="novel" title="Creator Novels" /><CreatorWorksRow kind="manga" title="Creator Manga" /><CreatorWorksRow kind="anime" title="Creator Anime" /></> : null}
    streak={<StreakLevelCard />} scrollRef={scrollRef}
  />;

  if (loading && !hasLoadedOnce.current) return <HomeScreenSkeleton />;

  return (
    <View style={s.root}>
      <LinearGradient
        colors={['rgba(232,69,69,0.07)', 'transparent']}
        style={s.topGrad}
        pointerEvents="none"
      />

      <SafeAreaView style={s.safe} edges={['top']}>
        {!wideWeb && (
          <Animated.View style={[s.headerBar, headerBarStyle]}>
            <Animated.View entering={FadeInDown.duration(380)}>
              <Header />
            </Animated.View>
          </Animated.View>
        )}

        <Animated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          scrollIndicatorInsets={{ bottom: 90 }}
          contentContainerStyle={s.scroll}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {/* Category tabs */}
          <Animated.View entering={FadeInDown.delay(80).duration(400)} style={s.tabsWrap}>
            <CategoryTabs
              key={categories.join('|')}
              selected={category}
              onSelect={setCategory}
              categories={categories}
            />
          </Animated.View>

          {/* Featured carousel — originals + trending manga */}
          <Animated.View entering={FadeInDown.delay(120).duration(500).springify()}>
            <FeaturedCarousel data={featured} />
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(150).duration(400)} style={s.sectionGap}>
            <StreakLevelCard />
          </Animated.View>

          {continueAnime.length > 0 && (
            <Animated.View entering={FadeInDown.delay(170).duration(400)} style={s.sectionGap}>
              <ContinueWatchingRow items={continueAnime} />
            </Animated.View>
          )}

          {continueReading.length > 0 && (
            <Animated.View entering={FadeInDown.delay(200).duration(400)} style={s.sectionGap}>
              <ContinueReadingRow items={continueReading} />
            </Animated.View>
          )}

          {/* Sakura Originals */}
          <View style={s.sectionGap}>
            <OriginalsSection />
          </View>

          {/* Community uploads, directly under the Originals they sit alongside.
              Each row renders nothing until it has at least one work, so an
              empty category leaves no stray heading.

              Novels are listed first on purpose: six were published through
              /creator-upload and sat unreadable for months because the reader
              only ever looked at the curated `novels` table. They resolve now,
              so this is the first place anyone will actually find them.

              Still gated on !adapter — with a scraped source active (comics,
              manhwa, 18+) the page is that source's catalogue, and community
              uploads do not belong in it. */}
          {!adapter && (
            <View style={s.sectionGap}>
              <CreatorWorksRow kind="novel" title="Creator Novels" />
              <CreatorWorksRow kind="manga" title="Creator Manga" />
              <CreatorWorksRow kind="anime" title="Creator Anime" />
            </View>
          )}

          {/* Trending & Popular */}
          {(trending.length > 0 || popularSeries.length > 0) && (
            <View style={s.sectionGap}>
              <TrendingPopularSection trending={trending} popular={popularSeries} />
            </View>
          )}

          {/* More catalogue titles, without implying a release date. */}
          {moreToExplore.length > 0 && (
            <View style={s.sectionGap}>
              <HorizSection
                data={moreToExplore}
                title="More to Explore"
                onSeeAll={() => goBrowse('More to Explore', { kind: 'popular' })}
              />
            </View>
          )}

          {/* What just got a chapter, with how long ago (atsu tab). */}
          {!adapter && updates.length > 0 && (
            <View style={s.sectionGap}>
              <HorizSection
                data={updates}
                title="Latest Updates"
                onSeeAll={() => router.push('/new-releases' as any)}
              />
            </View>
          )}

          {/* Picks from the trending feed, not personalized recommendations. */}
          {trendingPicks.length > 0 && (
            <View style={s.sectionGap}>
              <HorizSection
                data={trendingPicks}
                title="Trending Picks"
                onSeeAll={() => goBrowse('Trending Picks', { kind: 'trending' })}
              />
            </View>
          )}

          {/* Four genre shelves; their titles and queries come from the active
              source's registry entry so they stay in step with what was
              actually fetched above. */}
          {[actionPacked, romance, boredmBusters, comedy].map((data, i) =>
            data.length > 0 ? (
              <View key={homeRows[i].title} style={s.sectionGap}>
                <HorizSection
                  data={data}
                  title={homeRows[i].title}
                  onSeeAll={() => goBrowse(homeRows[i].title, homeRows[i].genre ? { genre: homeRows[i].genre } : { q: homeRows[i].query })}
                />
              </View>
            ) : null,
          )}

          <View style={{ height: 130 }} />
        </Animated.ScrollView>
      </SafeAreaView>
    </View>
  );
}

const hs = StyleSheet.create({
  list: {
    paddingHorizontal: Spacing.md,
    gap: 8,
    paddingBottom: 4,
  },
});

const tp = StyleSheet.create({
  tabsWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    marginBottom: 10,
  },
  tabPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  tabPillActive: {
    backgroundColor: '#E84545',
    borderColor: '#E84545',
  },
  tabText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.55)',
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
});
