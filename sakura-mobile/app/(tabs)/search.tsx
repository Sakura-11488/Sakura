import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  useWindowDimensions,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useScrollToTop, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import CoverImage from '@/components/ui/CoverImage';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Circle, Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, Fonts } from '@/constants/theme';
import { contentWidth } from '@/constants/layout';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import EmptyState from '@/components/ui/EmptyState';
import { fetchTrendingManga, toContentItem } from '@/lib/manga';
import { type UserSearchResult } from '@/lib/creator';
import { navigateToUserChat } from '@/lib/user-chat-nav';
import { useContentPrefs } from '@/lib/content-prefs';
import MangaCatalogWeb from '@/components/discovery/MangaCatalogWeb';
import { EMPTY_MAY_MEAN_DOWN, SEARCH_SOURCES } from '@/lib/search-sources';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_CHARS,
  SEARCH_SLOW_MS,
  SearchSessionCache,
  applySourceOutcome,
  buildSectionViews,
  cleanQuery,
  emptySections,
  enabledSources,
  markSectionSlow,
  prefillSections,
  runProgressively,
  searchFilters,
  sourcesToRun,
  summarizeSections,
  type SearchFilter,
  type SearchResult,
  type SearchSourceKey,
  type SectionMap,
  type SectionView,
  type SourceAnswer,
} from '@/lib/search-core';
import {
  clearRecentSearches,
  loadRecentSearches,
  peekRecentSearches,
  rememberSearch,
  removeRecentSearch,
  subscribeRecentSearches,
} from '@/lib/search-history';

type Filter = SearchFilter;

/**
 * Answers per query for this app session, at module scope so they outlive the
 * screen: leaving the tab and coming back, or backspacing to a query already
 * run, renders it synchronously (see lib/search-core.ts).
 */
const searchCache = new SearchSessionCache(24);

/** Rows per section in the native All overview; "View all" opens the section's chip. */
const NATIVE_OVERVIEW_ROWS = 4;

type Row =
  | { kind: 'header'; key: string; view: SectionView }
  | { kind: 'item'; key: string; item: SearchResult; stale: boolean; index: number }
  | { kind: 'skeleton'; key: string }
  | { kind: 'failed'; key: string; view: SectionView }
  | { kind: 'more'; key: string; view: SectionView }
  | { kind: 'browse'; key: string; view: SectionView }
  | { kind: 'section-empty'; key: string; view: SectionView };

/** Flattens the visible sections into FlatList rows (virtualised, unlike a ScrollView of sections). */
function buildRows(views: SectionView[], overview: boolean): Row[] {
  const rows: Row[] = [];
  let index = 0;
  for (const view of views) {
    if (overview) rows.push({ kind: 'header', key: `h-${view.key}`, view });
    if (view.status === 'failed') {
      rows.push({ kind: 'failed', key: `f-${view.key}`, view });
      continue;
    }
    if (!view.items.length) {
      if (view.status === 'pending') {
        const count = overview ? 2 : 6;
        for (let i = 0; i < count; i++) rows.push({ kind: 'skeleton', key: `s-${view.key}-${i}` });
      } else if (!overview) {
        rows.push({ kind: 'section-empty', key: `e-${view.key}`, view });
      }
      continue;
    }
    const shown = overview ? view.items.slice(0, NATIVE_OVERVIEW_ROWS) : view.items;
    for (const item of shown) rows.push({ kind: 'item', key: item.key, item, stale: view.stale, index: index++ });
    if (overview && !view.stale && view.items.length > NATIVE_OVERVIEW_ROWS) rows.push({ kind: 'more', key: `m-${view.key}`, view });
    if (view.browseSource && view.full) rows.push({ kind: 'browse', key: `b-${view.key}`, view });
  }
  return rows;
}

function avatarColor(seed: string): string {
  const palette = ['#E84545', '#9B21BE', '#3498DB', '#27AE60', '#E67E22', '#5856D6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function SearchIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Circle cx="11" cy="11" r="8" stroke={color} strokeWidth={2} />
      <Path d="M21 21l-4.35-4.35" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

/** Recent searches, shared by both platforms and kept in sync across screens. */
function useRecentSearches(): string[] {
  const [list, setList] = useState<string[]>(() => peekRecentSearches() ?? []);
  useEffect(() => {
    let alive = true;
    const unsubscribe = subscribeRecentSearches((next) => { if (alive) setList(next); });
    loadRecentSearches().then((next) => { if (alive) setList(next); }).catch(() => {});
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return list;
}

export default function SearchTabScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const searchParams = useLocalSearchParams<{ q?: string; focus?: string; searchRequest?: string }>();
  const { address, unlockForAppSession } = useWallet();
  const { allowAdult } = useContentPrefs();
  // Size the category grid off the CONTENT column, not the raw window: on a
  // 1920px desktop the window-derived width produced 939px cards that couldn't
  // fit two per row, so each rendered as a near-empty full-width slab.
  const { width: windowW } = useWindowDimensions();
  const catCardW = useMemo(() => {
    const avail = contentWidth(windowW) - Spacing.md * 2;
    const cols = avail >= 900 ? 4 : avail >= 620 ? 3 : 2;
    return Math.floor((avail - 10 * (cols - 1)) / cols);
  }, [windowW]);
  const filters = useMemo<Filter[]>(() => searchFilters(allowAdult), [allowAdult]);
  const enabled = useMemo(() => enabledSources(allowAdult), [allowAdult]);
  const recentSearches = useRecentSearches();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped whenever the query changes; answers from an older generation are dropped. */
  const generationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  /** Sources with a request in flight for the current generation, so a retry never doubles one. */
  const inFlightRef = useRef(new Set<SearchSourceKey>());
  const activeKeyRef = useRef('');
  const activeQueryRef = useRef('');
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const scrollRef = useRef<any>(null);
  const resultsRef = useRef<FlatList<Row>>(null);
  const inputRef = useRef<TextInput>(null);
  useScrollToTop(scrollRef);

  const [query, setQuery] = useState('');
  /** queryKey() of the search the sections are for (stale sections show an older one). */
  const [activeKey, setActiveKey] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [sections, setSections] = useState<SectionMap>(emptySections);
  const [messagingUser, setMessagingUser] = useState<string | null>(null);
  const [discoverCards, setDiscoverCards] = useState<Array<{ id: string; title: string; cover: string }>>([]);
  const [discoverLoading, setDiscoverLoading] = useState(true);
  const [discoverError, setDiscoverError] = useState(false);
  const [discoverAttempt, setDiscoverAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDiscoverLoading(true);
    setDiscoverError(false);
    fetchTrendingManga(12)
      .then((items) => {
        if (cancelled) return;
        setDiscoverCards(items.slice(0, 10).map((m) => ({ id: m.id, title: m.title, cover: toContentItem(m).cover })));
      })
      .catch(() => { if (!cancelled) { setDiscoverCards([]); setDiscoverError(true); } })
      .finally(() => { if (!cancelled) setDiscoverLoading(false); });
    return () => { cancelled = true; };
  }, [discoverAttempt]);

  /** Drop everything in flight: the query moved on (or the screen went away). */
  const cancelInFlight = useCallback(() => {
    generationRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    inFlightRef.current.clear();
  }, []);

  /**
   * Asks every source that has no fresh cached answer for `q`, and draws each
   * section the moment its own answer lands.
   */
  const runSources = useCallback((q: string) => {
    const qKey = q.toLowerCase();
    if (q.length < SEARCH_MIN_CHARS) return;
    const generation = generationRef.current;
    const keys = sourcesToRun(enabledRef.current, searchCache.get(qKey), Date.now())
      .filter((key) => !inFlightRef.current.has(key));
    if (!keys.length) return;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    keys.forEach((key) => inFlightRef.current.add(key));
    void runProgressively<SearchSourceKey, SourceAnswer>(
      keys.map((key) => ({
        key,
        run: async (signal) => {
          const answer = await SEARCH_SOURCES[key](q, signal);
          // Cached even when superseded: backspacing to this query is then
          // instant. An empty answer that may be a hidden outage is stored as
          // already stale (at 0), so the next run asks that source again.
          const trusted = answer.items.length > 0 || !EMPTY_MAY_MEAN_DOWN.has(key);
          searchCache.put(qKey, key, answer, trusted ? Date.now() : 0);
          return answer;
        },
      })),
      (key, outcome) => {
        if (generation !== generationRef.current) return;
        inFlightRef.current.delete(key);
        setSections((prev) => applySourceOutcome(prev, key, qKey, outcome));
      },
      {
        signal: controller.signal,
        slowMs: SEARCH_SLOW_MS,
        onSlow: (key) => {
          if (generation !== generationRef.current) return;
          // Let "Try again" start a fresh request; a late answer still lands.
          inFlightRef.current.delete(key);
          setSections((prev) => markSectionSlow(prev, key, qKey));
        },
      },
    ).finally(() => controllersRef.current.delete(controller));
  }, []);

  /**
   * The single entry point for a query change. `debounced` (typing) waits
   * SEARCH_DEBOUNCE_MS before asking the network; `now` (Enter, a recent or
   * suggestion tap, a retry) asks at once. Either way, cached sections render
   * synchronously and the others keep their previous cards until answered.
   */
  const applyQuery = useCallback((text: string, mode: 'debounced' | 'now') => {
    setQuery(text);
    const q = cleanQuery(text);
    const qKey = q.toLowerCase();
    const changed = qKey !== activeKeyRef.current;
    // Only whitespace changed: whatever is already scheduled or running stands.
    if (!changed && mode === 'debounced') return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (changed) {
      cancelInFlight();
      activeKeyRef.current = qKey;
      activeQueryRef.current = q;
      setActiveKey(qKey);
    }
    if (q.length < SEARCH_MIN_CHARS) {
      setSections(emptySections());
      return;
    }
    setSections((prev) => prefillSections(prev, qKey, enabledRef.current, searchCache.get(qKey)));
    if (mode === 'now') runSources(q);
    else debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      runSources(q);
    }, SEARCH_DEBOUNCE_MS);
  }, [cancelInFlight, runSources]);

  const onChangeQuery = useCallback((text: string) => applyQuery(text, 'debounced'), [applyQuery]);
  const submitQuery = useCallback((text: string) => {
    applyQuery(text, 'now');
    if (cleanQuery(text).length >= SEARCH_MIN_CHARS) void rememberSearch(text);
  }, [applyQuery]);
  const retrySearch = useCallback(() => applyQuery(activeQueryRef.current, 'now'), [applyQuery]);
  const rememberCurrent = useCallback(() => {
    if (activeQueryRef.current.length >= SEARCH_MIN_CHARS) void rememberSearch(activeQueryRef.current);
  }, []);

  // The adult opt-in adds or removes the 18+ source mid-search.
  const enabledSig = enabled.join(',');
  const firstEnabled = useRef(true);
  useEffect(() => {
    if (firstEnabled.current) { firstEnabled.current = false; return; }
    const q = activeQueryRef.current;
    if (q.length < SEARCH_MIN_CHARS) return;
    setSections((prev) => prefillSections(prev, q.toLowerCase(), enabledRef.current, searchCache.get(q.toLowerCase())));
    runSources(q);
  }, [enabledSig, runSources]);

  // A search handed over by another screen (the web home masthead): run it now.
  const appliedSearch = useRef<string | null>(null);
  useEffect(() => {
    if (typeof searchParams.q !== 'string') return;
    const request = JSON.stringify([searchParams.q, searchParams.searchRequest]);
    if (appliedSearch.current === request) return;
    appliedSearch.current = request;
    submitQuery(searchParams.q);
  }, [searchParams.q, searchParams.searchRequest, submitQuery]);

  useEffect(() => {
    if (Platform.OS === 'web' || !searchParams.focus) return;
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [searchParams.focus]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      cancelInFlight();
    };
  }, [cancelInFlight]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (Platform.OS === 'web') return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = null;
        cancelInFlight();
        activeKeyRef.current = '';
        activeQueryRef.current = '';
        setActiveKey('');
        setQuery('');
        setFilter('All');
        setSections(emptySections());
        inputRef.current?.blur();
      };
    }, [cancelInFlight]),
  );

  // If the adult toggle flips off while 18+ is the active chip, snap back to All.
  useEffect(() => {
    if (!allowAdult && filter === '18+') setFilter('All');
  }, [allowAdult, filter]);

  const views = useMemo(
    () => buildSectionViews(sections, filter, activeKey, { allowAdult, excludeWallet: address }),
    [sections, filter, activeKey, allowAdult, address],
  );
  const summary = useMemo(() => summarizeSections(views), [views]);

  const openBrowse = useCallback((view: SectionView) => {
    const q = activeQueryRef.current;
    if (!view.browseSource || !q) return;
    rememberCurrent();
    // Same route shape as the home tab's "View all": browse pages a scraped
    // source's query through its adapter, past what one search returns.
    router.push({
      pathname: '/browse',
      params: { title: `${view.label} · ${q}`, source: view.browseSource, q },
    } as never);
  }, [rememberCurrent, router]);

  const showSection = useCallback((view: SectionView) => {
    setFilter(view.filter);
    resultsRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  const openUserChat = useCallback(
    async (user: UserSearchResult) => {
      if (messagingUser) return;
      if (!address) {
        Alert.alert('Connect Account', 'Connect your Sakura account to send messages.');
        return;
      }
      setMessagingUser(user.wallet_address);
      try {
        const kp = await unlockForAppSession();
        if (!kp) return;
        await navigateToUserChat(router, kp, user);
      } catch (e) {
        Alert.alert('Message failed', e instanceof Error ? e.message : 'Try again.');
      } finally {
        setMessagingUser(null);
      }
    },
    [address, messagingUser, router, unlockForAppSession],
  );

  const handleResultPress = useCallback(
    (item: SearchResult) => {
      if (item.type === 'user' && item.user) {
        void openUserChat(item.user);
        return;
      }
      if (item.navTarget) {
        router.push(item.navTarget as never);
      }
    },
    [openUserChat, router],
  );

  const categoryCards = useMemo(
    () => [
      { label: 'Originals Rankings', query: 'Originals', cover: discoverCards[3]?.cover || discoverCards[0]?.cover || '' },
      { label: 'CANVAS Rankings', query: 'Canvas', cover: discoverCards[4]?.cover || discoverCards[1]?.cover || '' },
      { label: 'New Releases', query: 'New', cover: discoverCards[5]?.cover || discoverCards[2]?.cover || '' },
      { label: 'Daily', query: 'Daily', cover: discoverCards[6]?.cover || discoverCards[0]?.cover || '' },
      { label: 'US Originals', query: 'US Originals', cover: discoverCards[7]?.cover || discoverCards[1]?.cover || '' },
      { label: 'Video Episodes', query: 'Anime', cover: discoverCards[8]?.cover || discoverCards[2]?.cover || '' },
      { label: 'Graphic Novels', query: 'Graphic Novels', cover: discoverCards[9]?.cover || discoverCards[0]?.cover || '' },
      { label: 'Action', query: 'Action', cover: discoverCards[1]?.cover || discoverCards[0]?.cover || '' },
    ],
    [discoverCards],
  );
  const suggestions = useMemo(
    () => discoverCards.slice(0, 6).map((card) => ({ label: card.title, query: card.title, cover: card.cover })),
    [discoverCards],
  );

  const s = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        container: { flex: 1, paddingHorizontal: Spacing.md },
        title: {
          fontSize: 30,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          color: colors.text,
          marginTop: 2,
          marginBottom: 8,
        },
        searchWrap: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.md,
          paddingHorizontal: 12,
          gap: 8,
          marginBottom: 14,
          height: 46,
        },
        input: {
          flex: 1,
          fontSize: Platform.OS === 'web' ? 16 : FontSize.md,
          color: colors.text,
          fontFamily: Fonts.body,
        },
        clearBtn: { padding: 6 },
        sectionTitle: {
          fontSize: 22,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          color: colors.text,
          marginBottom: 10,
        },
        recentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        recentClear: { color: colors.primary, fontSize: FontSize.sm, fontFamily: Fonts.bodyMedium, paddingVertical: 6, paddingLeft: 12 },
        recentRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: 11,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
        recentText: { flex: 1, color: colors.text, fontSize: FontSize.md, fontFamily: Fonts.body },
        chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
        chip: {
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: Radius.full,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          maxWidth: '100%',
        },
        chipText: { color: colors.text, fontSize: FontSize.sm, fontFamily: Fonts.bodyMedium },
        discoverRow: { gap: 8, paddingBottom: 8 },
        discoverCard: {
          width: 132,
          height: 178,
          borderRadius: Radius.md,
          overflow: 'hidden',
          backgroundColor: colors.surfaceSecondary,
        },
        discoverImg: { width: '100%', height: '100%' },
        catGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: 10,
          paddingBottom: 16,
        },
        catCard: {
          width: catCardW,
          height: 112,
          borderRadius: Radius.md,
          backgroundColor: colors.surfaceSecondary,
          padding: 12,
          overflow: 'hidden',
        },
        catLabel: {
          fontSize: 14,
          fontFamily: Fonts.bodyBold,
          color: colors.text,
          width: '70%',
        },
        catThumb: {
          position: 'absolute',
          right: 10,
          bottom: 10,
          width: 72,
          height: 72,
          borderRadius: 10,
          backgroundColor: colors.surfaceTertiary,
        },
        filtersScroll: { flexGrow: 0, marginBottom: 10 },
        filters: { flexDirection: 'row', gap: 8, paddingRight: Spacing.md },
        filterChip: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: Radius.full,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        },
        filterChipActive: {
          borderColor: colors.primary,
          backgroundColor: `${colors.primary}22`,
        },
        filterText: { color: colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.bodyMedium },
        filterTextActive: { color: colors.primary, fontFamily: Fonts.bodyBold },
        statusLine: { color: colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.body, marginBottom: 8 },
        results: { paddingBottom: 110, gap: 8 },
        sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, paddingBottom: 2 },
        sectionHeadTitle: { color: colors.text, fontSize: FontSize.lg, fontFamily: Fonts.bodyBold },
        sectionHeadCount: { color: colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.body },
        resultRow: {
          flexDirection: 'row',
          gap: 10,
          borderRadius: Radius.md,
          backgroundColor: colors.surfaceSecondary,
          padding: 10,
        },
        staleRow: { opacity: 0.45 },
        resultCover: { width: 56, height: 76, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
        skeletonLine: { height: 12, borderRadius: 6, backgroundColor: colors.surfaceTertiary },
        userCover: {
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: colors.surfaceTertiary,
          overflow: 'hidden',
        },
        userCoverText: { color: '#fff', fontFamily: Fonts.bodyBold, fontSize: FontSize.lg },
        resultInfo: { flex: 1, justifyContent: 'center', gap: 3 },
        resultTitle: { color: colors.text, fontSize: FontSize.md, fontFamily: Fonts.bodyBold },
        resultMeta: { color: colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.body },
        messageHint: { color: colors.primary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
        seeAllRow: { alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 },
        seeAllText: { flex: 1, color: colors.primary, fontSize: FontSize.md, fontFamily: Fonts.bodyBold },
        failedRow: { alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
        failedText: { flex: 1, color: colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.body },
        retryText: { color: colors.primary, fontSize: FontSize.sm, fontFamily: Fonts.bodyBold },
        empty: { paddingTop: 24 },
      }),
    [colors, catCardW],
  );

  const renderRow = useCallback(({ item: row }: { item: Row }) => {
    switch (row.kind) {
      case 'header': {
        const { view } = row;
        return (
          <View style={s.sectionHead} accessibilityRole="header">
            <Text style={s.sectionHeadTitle}>{view.label}</Text>
            {view.status === 'pending' ? (
              <ActivityIndicator size="small" color={colors.textTertiary} />
            ) : view.status === 'done' && !view.stale ? (
              <Text style={s.sectionHeadCount}>{view.items.length}{view.full ? '+' : ''}</Text>
            ) : null}
          </View>
        );
      }
      case 'skeleton':
        return (
          <View style={s.resultRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={s.resultCover} />
            <View style={[s.resultInfo, { gap: 8 }]}>
              <View style={[s.skeletonLine, { width: '70%' }]} />
              <View style={[s.skeletonLine, { width: '35%', height: 9 }]} />
            </View>
          </View>
        );
      case 'failed':
        return (
          <TouchableOpacity style={[s.resultRow, s.failedRow]} activeOpacity={0.85} onPress={retrySearch} accessibilityRole="button">
            <Text style={s.failedText} numberOfLines={2}>
              {row.view.slow ? `${row.view.label} is taking too long to answer.` : `${row.view.label} didn’t respond.`}
            </Text>
            <Text style={s.retryText}>Try again</Text>
          </TouchableOpacity>
        );
      case 'section-empty':
        return <EmptyState compact title={`No ${row.view.label === 'People' ? 'people' : row.view.label.toLowerCase()} match “${activeQueryRef.current}”`} style={s.empty} />;
      case 'more':
        return (
          <TouchableOpacity style={[s.resultRow, s.seeAllRow]} activeOpacity={0.85} accessibilityRole="button" onPress={() => showSection(row.view)}>
            <Text style={s.seeAllText} numberOfLines={1}>View all {row.view.items.length} {row.view.label === 'People' ? 'people' : row.view.label.toLowerCase()}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.primary} />
          </TouchableOpacity>
        );
      case 'browse':
        return (
          <TouchableOpacity style={[s.resultRow, s.seeAllRow]} activeOpacity={0.85} accessibilityRole="link" onPress={() => openBrowse(row.view)}>
            <Text style={s.seeAllText} numberOfLines={1}>
              See all {row.view.label.toLowerCase()} for “{activeQueryRef.current}”
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.primary} />
          </TouchableOpacity>
        );
      case 'item': {
        const { item } = row;
        const isUser = item.type === 'user';
        const seed = item.user?.avatar_seed ?? item.user?.wallet_address.slice(0, 8) ?? '?';
        const busy = isUser && messagingUser === item.user?.wallet_address;
        return (
          // Capped stagger: an uncapped index * 30 ms made row 40 wait 1.2 s.
          <Animated.View entering={FadeInDown.delay(Math.min(row.index, 6) * 30).duration(240)} style={row.stale ? s.staleRow : undefined}>
            <TouchableOpacity
              style={s.resultRow}
              activeOpacity={0.85}
              disabled={!!busy}
              onPress={() => {
                rememberCurrent();
                handleResultPress(item);
              }}
            >
              {isUser ? (
                <View
                  style={[
                    s.userCover,
                    !item.cover && { backgroundColor: avatarColor(seed), alignItems: 'center', justifyContent: 'center' },
                  ]}
                >
                  {item.cover ? (
                    <Image source={{ uri: item.cover }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  ) : (
                    <Text style={s.userCoverText}>{item.title.slice(0, 1).toUpperCase()}</Text>
                  )}
                </View>
              ) : (
                <CoverImage source={{ uri: item.cover }} style={s.resultCover} contentFit="cover" />
              )}
              <View style={s.resultInfo}>
                <Text style={s.resultTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={s.resultMeta} numberOfLines={1}>
                  {item.meta}
                </Text>
                {isUser ? (
                  busy ? (
                    <ActivityIndicator size="small" color={colors.primary} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                  ) : (
                    <Text style={s.messageHint}>Tap to message</Text>
                  )
                ) : null}
              </View>
              {isUser && !busy ? (
                <Ionicons name="chatbubble-outline" size={20} color={colors.primary} />
              ) : null}
            </TouchableOpacity>
          </Animated.View>
        );
      }
      default:
        return null;
    }
  }, [s, colors, messagingUser, retrySearch, showSection, openBrowse, rememberCurrent, handleResultPress]);

  const overview = filter === 'All';
  const rows = useMemo(() => buildRows(views, overview), [views, overview]);

  if (Platform.OS === 'web') {
    return <MangaCatalogWeb
      query={query}
      onQueryChange={onChangeQuery}
      onSubmit={() => submitQuery(query)}
      filter={filter}
      filters={filters}
      onFilterChange={setFilter}
      sections={views}
      summary={summary}
      discoverCards={discoverCards}
      discoverLoading={discoverLoading}
      discoverError={discoverError}
      messagingUser={messagingUser}
      suggestions={suggestions}
      recentSearches={recentSearches}
      onRecentPress={submitQuery}
      onRemoveRecent={(value) => void removeRecentSearch(value)}
      onClearRecent={() => void clearRecentSearches()}
      onRemember={rememberCurrent}
      onResultPress={handleResultPress}
      onDiscoverPress={id => router.push(`/manga/${encodeURIComponent(id)}` as never)}
      onRetry={retrySearch}
      onRetryDiscover={() => setDiscoverAttempt(attempt => attempt + 1)}
    />;
  }

  const searching = query.trim().length >= SEARCH_MIN_CHARS;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        <Animated.Text entering={FadeIn.duration(220)} style={s.title}>
          Search
        </Animated.Text>

        <Animated.View entering={FadeInDown.duration(260)} style={s.searchWrap}>
          <SearchIcon color={colors.textTertiary} />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={onChangeQuery}
            onSubmitEditing={(e) => submitQuery(e.nativeEvent.text)}
            placeholder="Series, creators, users, and more"
            placeholderTextColor={colors.textTertiary}
            style={s.input}
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <TouchableOpacity
              style={s.clearBtn}
              onPress={() => { onChangeQuery(''); inputRef.current?.focus(); }}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </Animated.View>

        {!searching ? (
          <ScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            scrollIndicatorInsets={{ bottom: 90 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 110 }}
          >
            {recentSearches.length > 0 ? (
              <View style={{ marginBottom: 18 }}>
                <View style={s.recentHead}>
                  <Text style={s.sectionTitle}>Recent searches</Text>
                  <TouchableOpacity onPress={() => void clearRecentSearches()} accessibilityRole="button" accessibilityLabel="Clear recent searches">
                    <Text style={s.recentClear}>Clear</Text>
                  </TouchableOpacity>
                </View>
                {recentSearches.map((value) => (
                  <View key={value} style={s.recentRow}>
                    <Ionicons name="time-outline" size={18} color={colors.textTertiary} />
                    <TouchableOpacity style={{ flex: 1 }} onPress={() => submitQuery(value)} accessibilityRole="button" accessibilityLabel={`Search ${value}`}>
                      <Text style={s.recentText} numberOfLines={1}>{value}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => void removeRecentSearch(value)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${value} from recent searches`}>
                      <Ionicons name="close" size={18} color={colors.textTertiary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}

            {suggestions.length > 0 ? (
              <>
                <Text style={s.sectionTitle}>Try searching</Text>
                <View style={s.chipRow}>
                  {suggestions.map((suggestion) => (
                    <TouchableOpacity key={suggestion.label} style={s.chip} activeOpacity={0.8} onPress={() => submitQuery(suggestion.query)}>
                      <Text style={s.chipText} numberOfLines={1}>{suggestion.query}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={s.sectionTitle}>What Everyone&apos;s Searching</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.discoverRow}>
              {discoverCards.slice(0, 6).map((card, idx) => (
                <Animated.View key={card.id} entering={FadeInDown.delay(idx * 40).duration(280)}>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={s.discoverCard}
                    onPress={() => router.push(`/manga/${card.id}` as never)}
                  >
                    <CoverImage source={{ uri: card.cover }} style={s.discoverImg} contentFit="cover" />
                  </TouchableOpacity>
                </Animated.View>
              ))}
            </ScrollView>

            <Text style={[s.sectionTitle, { marginTop: 12 }]}>Browse Categories</Text>
            <View style={s.catGrid}>
              {categoryCards.map((cat, idx) => (
                <Animated.View key={cat.label} entering={FadeInDown.delay(idx * 35).duration(260)}>
                  <TouchableOpacity activeOpacity={0.85} style={s.catCard} onPress={() => submitQuery(cat.query)}>
                    <Text style={s.catLabel}>{cat.label}</Text>
                    {!!cat.cover && <CoverImage source={{ uri: cat.cover }} style={s.catThumb} contentFit="cover" />}
                  </TouchableOpacity>
                </Animated.View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={s.filtersScroll}
              contentContainerStyle={s.filters}
            >
              {filters.map((f) => (
                <TouchableOpacity
                  key={f}
                  style={[s.filterChip, filter === f && s.filterChipActive]}
                  onPress={() => setFilter(f)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === f }}
                >
                  <Text style={[s.filterText, filter === f && s.filterTextActive]}>{f}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {summary.loading && summary.anyFresh ? (
              <Text style={s.statusLine}>{summary.count} results so far · still searching</Text>
            ) : null}

            <FlatList
              ref={resultsRef}
              data={rows}
              keyExtractor={(row) => row.key}
              renderItem={renderRow}
              showsVerticalScrollIndicator={false}
              scrollIndicatorInsets={{ bottom: 90 }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={s.results}
              initialNumToRender={12}
              windowSize={7}
              ListEmptyComponent={
                summary.failed.length ? (
                  // An outage must read as an outage. Saying "no results"
                  // when the source is down tells users the title doesn't
                  // exist, which is how a broken backend gets reported as
                  // missing content.
                  <EmptyState
                    compact
                    title="Couldn’t reach some sources"
                    subtitle={`${summary.failed.join(', ')} didn’t respond. Check your connection and try again.`}
                    style={s.empty}
                  />
                ) : (
                  <EmptyState compact title={`No results for "${query.trim()}"`} style={s.empty} />
                )
              }
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
