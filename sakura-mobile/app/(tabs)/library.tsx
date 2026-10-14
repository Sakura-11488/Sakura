import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, TextInput, Platform, useWindowDimensions, Modal, Pressable, ScrollView } from 'react-native';
import { useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Image from '@/components/ui/CoverImage';
import { useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, FontWeight, Shadow, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { Library, READING_STATUSES, effectiveReadingStatus, type LibraryItem, type ReadingStatus } from '@/lib/storage';
import { LIBRARY_SORTS } from '@/lib/library-updates';
import ContinueWatchingRow from '@/components/ui/ContinueWatchingRow';
import ContinueReadingRow from '@/components/ui/ContinueReadingRow';
import EmptyState from '@/components/ui/EmptyState';
import { getContinueWatching, subscribeWatchProgress, type AnimeWatchProgress } from '@/lib/watch-progress';
import {
  getAllMangaProgressEntries,
  getContinueReading,
  getNovelProgressBySeries,
  subscribeReadingProgress,
  type ContinueReadingItem,
} from '@/lib/reader-progress';
import {
  getLibraryUpdateSummaries,
  hasReadingStatus,
  hasRecentUpdate,
  libraryProgressKey as progressKey,
  libraryUpdateKey,
  refreshLibraryUpdates,
  sortLibraryItems,
  subscribeLibraryUpdates,
  type LibrarySort,
  type LibraryUpdateSummary,
} from '@/lib/library-updates';
import { subscribeChapterReadState } from '@/lib/chapter-read-state';
import { formatReleaseDate } from '@/lib/format-release-date';
import { playTap, onTap } from '@/lib/sound';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { contentWidth } from '@/constants/layout';
import LibraryWeb from '@/components/ui/LibraryWeb';
import { useFocusedSubscription } from '@/lib/hooks/useFocusedSubscription';

type Tab = 'All' | 'Anime' | 'Manga' | 'Novel' | 'Updates';
const TABS: Tab[] = ['All', 'Anime', 'Manga', 'Novel', 'Updates'];

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
  const [tab, setTab] = useState<Tab>('All');
  const [items, setItems] = useState<LibraryItem[]>([]);
  /** New-chapter and unread counts per saved series (lib/library-updates). */
  const [updates, setUpdates] = useState<Record<string, LibraryUpdateSummary>>({});
  /** When each saved title was last read, by progressKey. */
  const [lastRead, setLastRead] = useState<Record<string, number>>({});
  const [checking, setChecking] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | ReadingStatus>('all');
  const [sort, setSort] = useState<LibrarySort>('saved');
  /** Native: the item whose status sheet is open. */
  const [statusFor, setStatusFor] = useState<LibraryItem | null>(null);
  const itemsRef = useRef<LibraryItem[]>([]);
  itemsRef.current = items;
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

  const loadUpdates = useCallback(() => {
    void getLibraryUpdateSummaries(itemsRef.current).then(setUpdates, () => {});
  }, []);

  const loadLastRead = useCallback(() => {
    void Promise.all([getAllMangaProgressEntries(), getNovelProgressBySeries()]).then(([manga, novels]) => {
      const out: Record<string, number> = {};
      for (const row of manga) {
        const key = `${getScrapedAdapter(row.source)?.key ?? 'manga'}:${row.mangaId}`;
        out[key] = Math.max(out[key] || 0, row.updatedAt || 0);
      }
      for (const [path, row] of Object.entries(novels)) out[`novel:${path}`] = row.updatedAt || 0;
      setLastRead(out);
    }, () => {});
  }, []);

  /**
   * Check followed series for new chapters. Throttled and capped inside
   * lib/library-updates, so calling it on every focus is cheap; a pull to
   * refresh forces it (down to a 5-minute floor).
   */
  const checkUpdates = useCallback((list: LibraryItem[], force = false) => {
    if (!list.some((item) => item.type === 'manga')) return Promise.resolve();
    setChecking(true);
    return refreshLibraryUpdates(list, { force }).catch(() => {}).finally(() => {
      setChecking(false);
      loadUpdates();
    });
  }, [loadUpdates]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const all = await Library.getAll();
      itemsRef.current = all;
      setItems(all);
      refreshContinue();
      loadLastRead();
      loadUpdates();
      void checkUpdates(all, true);
    } finally {
      setRefreshing(false);
    }
  }, [refreshContinue, loadLastRead, loadUpdates, checkUpdates]);

  useFocusEffect(
    useCallback(() => {
      Library.getAll().then((all) => {
        itemsRef.current = all;
        setItems(all);
        loadUpdates();
        void checkUpdates(all);
      });
      refreshContinue();
      loadLastRead();
    }, [refreshContinue, loadUpdates, loadLastRead, checkUpdates]),
  );
  // Counts follow reading (marks) and checks landing, while focused.
  useFocusedSubscription(subscribeLibraryUpdates, loadUpdates);
  useFocusedSubscription(subscribeChapterReadState, loadUpdates);

  const setStatus = useCallback(async (item: LibraryItem, status: ReadingStatus | null) => {
    await Library.setStatus(item.id, item.type, status);
    const all = await Library.getAll();
    itemsRef.current = all;
    setItems(all);
  }, []);

  // Only while focused: the reader and player save progress every few
  // seconds, and the focus effect above already reloads on return.
  useFocusedSubscription(subscribeWatchProgress, refreshContinueWatching);
  useFocusedSubscription(subscribeReadingProgress, refreshContinueReading);

  const query = isWeb ? search.trim().toLocaleLowerCase() : '';
  // The status chips are hidden on Anime and Updates, so the status chosen on
  // another tab must not filter there: Anime would always come up empty (anime
  // has no reading status) and Updates would hide new chapters, with no
  // visible control to undo it.
  const statusApplies = statusFilter !== 'all' && tab !== 'Anime' && tab !== 'Updates';
  const filtered = useMemo(() => {
    const list = items.filter(item => (
      (tab === 'All' || tab === 'Updates' || item.type === tab.toLowerCase()) &&
      (tab !== 'Updates' || item.type === 'manga') &&
      (!query || item.title.toLocaleLowerCase().includes(query)) &&
      (!statusApplies || (hasReadingStatus(item) && effectiveReadingStatus(item, !!lastRead[progressKey(item)]) === statusFilter))
    ));
    if (tab === 'Updates') {
      // Followed series with news, newest first (see hasRecentUpdate).
      return sortLibraryItems(list.filter((item) => {
        const key = libraryUpdateKey(item);
        return hasRecentUpdate(key ? updates[key] : undefined);
      }), 'updated', lastRead, updates);
    }
    return sortLibraryItems(list, sort, lastRead, updates);
  }, [items, tab, query, statusFilter, statusApplies, lastRead, updates, sort]);
  const updatesCount = useMemo(
    () => items.reduce((n, item) => {
      const key = libraryUpdateKey(item);
      return n + (key && updates[key]?.newCount ? 1 : 0);
    }, 0),
    [items, updates],
  );
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
    chipRow: { paddingHorizontal: Spacing.md, gap: 6, marginBottom: Spacing.md, alignItems: 'center' },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { fontSize: 12, fontWeight: FontWeight.semibold, color: colors.textSecondary },
    chipTextActive: { color: colors.white },
    sortChip: { borderStyle: 'dashed' },
    updatesHint: { fontSize: FontSize.xs, color: colors.textSecondary, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm },
    newBadge: {
      position: 'absolute',
      top: 8,
      left: 8,
      backgroundColor: colors.primary,
      borderRadius: Radius.full,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    newBadgeText: { color: '#fff', fontSize: 9, fontWeight: FontWeight.heavy, letterSpacing: 0.4 },
    unreadBadge: {
      position: 'absolute',
      top: 8,
      right: 8,
      minWidth: 22,
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.72)',
      borderRadius: Radius.full,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    unreadBadgeText: { color: '#fff', fontSize: 10, fontWeight: FontWeight.bold },
    statusBadge: { backgroundColor: colors.surfaceSecondary },
    statusText: { color: colors.textSecondary, textTransform: 'none' },
    sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: Spacing.lg,
      paddingTop: Spacing.lg,
      paddingBottom: 34,
    },
    sheetTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text },
    sheetSub: { fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 2, marginBottom: Spacing.sm },
    sheetRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    sheetRowText: { fontSize: FontSize.md, color: colors.text },
  }), [colors, isWeb]);

  if (isWeb) {
    return <LibraryWeb items={items} refreshing={refreshing} onRefresh={onRefresh}
      updates={updates} lastRead={lastRead} checking={checking} onSetStatus={(item, status) => { void setStatus(item, status); }}
      onOpen={navigate} onBrowse={() => router.push('/anime' as any)}
      onSchedule={() => router.push('/anime/schedule' as any)}
      continueSection={<>
        {continueAnime.length > 0 && <ContinueWatchingRow items={continueAnime} />}
        {continueReading.length > 0 && <ContinueReadingRow items={continueReading} />}
      </>} />;
  }

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

      <Animated.View entering={FadeInDown.delay(80).duration(400)}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
          {TABS.map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => setTab(t)}
              style={[styles.tab, tab === t && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === t }}
            >
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t}{t === 'Updates' && updatesCount > 0 ? ` · ${updatesCount}` : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </Animated.View>

      {/* Reading status and order, for what you read (anime has its own status on web). */}
      {tab !== 'Anime' && tab !== 'Updates' && items.some(hasReadingStatus) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {([{ id: 'all', label: 'Any status' }, ...READING_STATUSES] as { id: 'all' | ReadingStatus; label: string }[]).map((st) => {
            const active = statusFilter === st.id;
            return (
              <TouchableOpacity
                key={st.id}
                onPress={() => setStatusFilter(st.id)}
                style={[styles.chip, active && styles.chipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{st.label}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            onPress={() => {
              const at = LIBRARY_SORTS.findIndex((o) => o.id === sort);
              setSort(LIBRARY_SORTS[(at + 1) % LIBRARY_SORTS.length].id);
            }}
            style={[styles.chip, styles.sortChip]}
            accessibilityRole="button"
            accessibilityLabel={`Sort: ${LIBRARY_SORTS.find((o) => o.id === sort)?.label}. Tap to change`}
          >
            <Text style={styles.chipText}>⇅ {LIBRARY_SORTS.find((o) => o.id === sort)?.label}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
      {tab === 'Updates' && (
        <Text style={styles.updatesHint}>
          {checking ? 'Checking your series for new chapters…' : 'New chapters in the series you saved. Pull down to check now.'}
        </Text>
      )}

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
          title={tab === 'Updates' ? (checking ? 'Checking for new chapters…' : 'No new chapters') : statusApplies ? 'Nothing with this status' : query ? 'No matching saved titles' : isWeb && tab !== 'All' ? `No saved ${tab.toLowerCase()} yet` : 'Nothing saved yet'}
          subtitle={tab === 'Updates' ? 'Save manga, manhwa and comics to follow them; new chapters show up here.' : statusApplies ? 'Long-press a saved title to set its reading status.' : query ? `Try another title${tab !== 'All' ? ' or choose All' : ''}, or clear your search.` : 'Tap the bookmark icon on any anime, manga, or novel to save it here.'}
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
            const updateKey = libraryUpdateKey(item);
            const upd = updateKey ? updates[updateKey] : undefined;
            const status = hasReadingStatus(item) ? effectiveReadingStatus(item, !!lastRead[progressKey(item)]) : null;
            const statusLabel = status ? READING_STATUSES.find((st) => st.id === status)?.label : null;
            return (
              <Animated.View entering={FadeInDown.delay(isWeb ? Math.min(index, 8) * 35 : index * 60).duration(400)} style={[styles.card, isWeb && { flexBasis: webCardWidth, flexGrow: 0, flexShrink: 0, width: webCardWidth }]}>
                <TouchableOpacity
                  onPress={() => navigate(item)}
                  onLongPress={hasReadingStatus(item) ? () => setStatusFor(item) : undefined}
                  delayLongPress={350}
                  activeOpacity={0.9}
                  style={styles.cardInner}
                  accessibilityHint={hasReadingStatus(item) ? 'Long press to set reading status' : undefined}
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
                  {upd && upd.newCount > 0 ? (
                    <View style={styles.newBadge}><Text style={styles.newBadgeText}>{upd.newCount} NEW</Text></View>
                  ) : null}
                  {upd && upd.unread > 0 ? (
                    <View style={styles.unreadBadge} accessibilityLabel={`${upd.unread} unread`}>
                      <Text style={styles.unreadBadgeText}>{upd.unread > 999 ? '999+' : upd.unread}</Text>
                    </View>
                  ) : null}
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    {pct > 0 ? (
                      <Text style={styles.continueHint}>
                        Continue Ep {cont!.episodeNumber} · {pct}%
                      </Text>
                    ) : null}
                    {tab === 'Updates' && upd ? (
                      <Text style={styles.continueHint} numberOfLines={1}>
                        {upd.latestTitle}{upd.latestAt ? ` · ${formatReleaseDate(upd.latestAt)}` : ''}
                      </Text>
                    ) : null}
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                      <View style={styles.typeBadge}>
                        <Text style={styles.typeText}>{item.type}</Text>
                      </View>
                      {statusLabel ? (
                        <View style={[styles.typeBadge, styles.statusBadge]}>
                          <Text style={[styles.typeText, styles.statusText]}>{statusLabel}</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </TouchableOpacity>
              </Animated.View>
            );
          }}
        />
      )}

      {/* Reading status, from a long press on a card. */}
      <Modal visible={!!statusFor} transparent animationType="fade" onRequestClose={() => setStatusFor(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setStatusFor(null)} accessibilityLabel="Close">
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle} numberOfLines={2}>{statusFor?.title}</Text>
            <Text style={styles.sheetSub}>Reading status</Text>
            {READING_STATUSES.map((st) => {
              const current = statusFor ? effectiveReadingStatus(statusFor, !!lastRead[progressKey(statusFor)]) === st.id : false;
              return (
                <TouchableOpacity
                  key={st.id}
                  style={styles.sheetRow}
                  accessibilityRole="button"
                  accessibilityState={{ selected: current }}
                  onPress={() => {
                    const item = statusFor;
                    setStatusFor(null);
                    if (item) void setStatus(item, st.id);
                  }}
                >
                  <Text style={[styles.sheetRowText, current && { color: colors.primary, fontWeight: FontWeight.bold }]}>{st.label}</Text>
                  {current ? <Text style={{ color: colors.primary }}>✓</Text> : null}
                </TouchableOpacity>
              );
            })}
            {statusFor?.status ? (
              <TouchableOpacity
                style={styles.sheetRow}
                accessibilityRole="button"
                onPress={() => {
                  const item = statusFor;
                  setStatusFor(null);
                  if (item) void setStatus(item, null);
                }}
              >
                <Text style={[styles.sheetRowText, { color: colors.textSecondary }]}>Automatic (from your reading)</Text>
              </TouchableOpacity>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
