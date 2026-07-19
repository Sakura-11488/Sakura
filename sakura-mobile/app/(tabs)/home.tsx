import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Dimensions,
  TouchableOpacity,
  useWindowDimensions,
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
  toContentItem,
  toCarouselItem,
  searchManga,
} from '@/lib/manga';
import {
  fetchTrendingComics,
  searchComics,
} from '@/lib/comics';
import {
  fetchTrendingHentai,
  searchHentai,
} from '@/lib/hentai';
import { useContentPrefs } from '@/lib/content-prefs';
import { isWideWeb } from '@/constants/layout';
import { SAKURA_ORIGINALS } from '@/lib/sakura-originals';
import CreatorWorksRow from '@/components/creator/CreatorWorksRow';
import StreakLevelCard from '@/components/gamification/StreakLevelCard';
import FeaturedCarousel, { type CarouselItem } from '@/components/ui/FeaturedCarousel';

const { width: W } = Dimensions.get('window');


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
  const [loading, setLoading] = useState(true);
  // Full-screen skeleton only on the very first load; switching category keeps the
  // existing content on screen (no jarring flash) while the new rows stream in.
  const hasLoadedOnce = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [featured, setFeatured] = useState<CarouselItem[]>([]);
  const [trending, setTrending] = useState<ContentItem[]>([]);
  const [popularSeries, setPopularSeries] = useState<ContentItem[]>([]);
  const [newReleases, setNewReleases] = useState<ContentItem[]>([]);
  const [todaysPick, setTodaysPick] = useState<ContentItem[]>([]);
  const [actionPacked, setActionPacked] = useState<ContentItem[]>([]);
  const [romance, setRomance] = useState<ContentItem[]>([]);
  const [boredmBusters, setBoredmBusters] = useState<ContentItem[]>([]);
  const [comedy, setComedy] = useState<ContentItem[]>([]);
  const router = useRouter();
  const [continueAnime, setContinueAnime] = useState<AnimeWatchProgress[]>([]);
  const [continueReading, setContinueReading] = useState<ContinueReadingItem[]>([]);
  const scrollRef = useRef<any>(null);
  useScrollToTop(scrollRef);
  const scrollY = useSharedValue(0);

  const isComics = category === 'Comics';
  const isHentai = category === '18+';
  const categories = useMemo(
    () => (allowAdult ? ['Manga', 'Comics', '18+'] : ['Manga', 'Comics']),
    [allowAdult],
  );

  // Expand a home row into the full-grid browse screen, carrying the row's
  // source + query so it shows *that* section's content (not the manga
  // catalogue). `q` drives genre rows (search); `kind` drives catalogue rows.
  const browseSource = isHentai ? 'hentai' : isComics ? 'comics' : 'manga';
  const goBrowse = useCallback(
    (title: string, opts: { q?: string; kind?: string }) =>
      router.push({
        pathname: '/browse',
        params: { title, source: browseSource, ...opts },
      } as any),
    [router, browseSource],
  );

  // If the user turns off 18+ while the 18+ tab is selected, fall back to Manga.
  useEffect(() => {
    if (!allowAdult && category === '18+') setCategory('Manga');
  }, [allowAdult, category]);

  const loadData = useCallback(async () => {
    try {
      if (isComics || isHentai) {
        const source = isHentai ? 'hentai' : 'comics';
        const list = isHentai ? await fetchTrendingHentai(40) : await fetchTrendingComics(40);
        const toCarousel = (c: ContentItem): CarouselItem => ({
          id: c.id,
          title: c.title,
          cover: c.cover,
          genres: [],
          type: 'manga',
          source,
        });
        setFeatured(list.slice(0, 20).map(toCarousel));
        setTrending(list.slice(7, 15));
        setPopularSeries(list.slice(0, 10).map((c) => ({ ...c, badge: 'HOT' })));
        setNewReleases(list.slice(10, 20).map((c) => ({ ...c, badge: 'NEW' })));
        setTodaysPick(list.slice(16, 24));
      } else {
        const [trend, pop] = await Promise.all([
          fetchTrendingManga(32),
          fetchPopularManga(20),
        ]);

        setFeatured(trend.slice(0, 20).map(toCarouselItem));
        setTrending(trend.slice(7, 15).map((i) => toContentItem(i)));
        setPopularSeries(pop.slice(0, 10).map((i) => toContentItem(i, 'HOT')));
        setNewReleases(pop.slice(10, 20).map((i) => toContentItem(i, 'NEW')));
        setTodaysPick(trend.slice(16, 24).map((i) => toContentItem(i)));
      }
    } catch {
      // keep previous data / fallback to empty
    } finally {
      hasLoadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, [isComics, isHentai]);

  useEffect(() => {
    setLoading(true);
  }, [category]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (loading) return;
    (async () => {
      if (isHentai) {
        const [vanilla, romance, fullColor, yuri] = await Promise.all([
          searchHentai('vanilla', 12),
          searchHentai('romance', 12),
          searchHentai('full color', 12),
          searchHentai('yuri', 12),
        ]);
        setActionPacked(vanilla);
        setRomance(romance);
        setBoredmBusters(fullColor);
        setComedy(yuri);
        return;
      }
      if (isComics) {
        const [action, hero, scifi, horror] = await Promise.all([
          searchComics('action', 12),
          searchComics('superhero', 12),
          searchComics('sci-fi', 12),
          searchComics('horror', 12),
        ]);
        setActionPacked(action);
        setRomance(hero);
        setBoredmBusters(scifi);
        setComedy(horror);
        return;
      }
      const [action, rom, bored, com] = await Promise.all([
        searchManga('action', 12),
        searchManga('romance', 12),
        searchManga('slice of life', 12),
        searchManga('comedy', 12),
      ]);
      setActionPacked(action.map((i) => toContentItem(i)));
      setRomance(rom.map((i) => toContentItem(i)));
      setBoredmBusters(bored.map((i) => toContentItem(i)));
      setComedy(com.map((i) => toContentItem(i)));
    })();
  }, [loading, isComics, isHentai]);

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

  useEffect(() => {
    const unsubWatch = subscribeWatchProgress(refreshContinueWatching);
    const unsubRead = subscribeReadingProgress(refreshContinueReading);
    return () => {
      unsubWatch();
      unsubRead();
    };
  }, [refreshContinueWatching, refreshContinueReading]);

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

          {/* Trending & Popular */}
          {(trending.length > 0 || popularSeries.length > 0) && (
            <View style={s.sectionGap}>
              <TrendingPopularSection trending={trending} popular={popularSeries} />
            </View>
          )}

          {/* Community uploads — only in the Manga catalog (creator works are
              novel/manga/anime; novels + anime live on their own tabs). */}
          {!isComics && !isHentai && (
            <View style={s.sectionGap}>
              <CreatorWorksRow kind="manga" />
            </View>
          )}

          {/* New Releases */}
          {newReleases.length > 0 && (
            <View style={s.sectionGap}>
              <HorizSection
                data={newReleases}
                title="New Releases"
                onSeeAll={() => goBrowse('New Releases', { kind: 'new' })}
              />
            </View>
          )}

          {/* Today's Pick For You */}
          {todaysPick.length > 0 && (
            <View style={s.sectionGap}>
              <HorizSection
                data={todaysPick}
                title="Today's Pick For You"
                onSeeAll={() => goBrowse("Today's Pick For You", { kind: 'todays' })}
              />
            </View>
          )}

          {/* Action Packed */}
          {actionPacked.length > 0 && (
            <View style={s.sectionGap}>
              {(() => {
                const t = isHentai ? 'Vanilla' : 'Action Packed';
                const q = isHentai ? 'vanilla' : 'action';
                return (
                  <HorizSection data={actionPacked} title={t} onSeeAll={() => goBrowse(t, { q })} />
                );
              })()}
            </View>
          )}

          {/* Romance / Superheroes */}
          {romance.length > 0 && (
            <View style={s.sectionGap}>
              {(() => {
                const t = isHentai ? 'Romance' : isComics ? 'Superheroes' : 'Romance';
                const q = isHentai ? 'romance' : isComics ? 'superhero' : 'romance';
                return <HorizSection data={romance} title={t} onSeeAll={() => goBrowse(t, { q })} />;
              })()}
            </View>
          )}

          {/* Boredom Busters / Sci-Fi */}
          {boredmBusters.length > 0 && (
            <View style={s.sectionGap}>
              {(() => {
                const t = isHentai ? 'Full Color' : isComics ? 'Sci-Fi & Space' : 'Boredom Busters';
                const q = isHentai ? 'full color' : isComics ? 'sci-fi' : 'slice of life';
                return <HorizSection data={boredmBusters} title={t} onSeeAll={() => goBrowse(t, { q })} />;
              })()}
            </View>
          )}

          {/* Get Into Comedy / Horror */}
          {comedy.length > 0 && (
            <View style={s.sectionGap}>
              {(() => {
                const t = isHentai ? 'Yuri' : isComics ? 'Horror & Thriller' : 'Get Into Comedy';
                const q = isHentai ? 'yuri' : isComics ? 'horror' : 'comedy';
                return <HorizSection data={comedy} title={t} onSeeAll={() => goBrowse(t, { q })} />;
              })()}
            </View>
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
