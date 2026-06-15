import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  SectionList,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import EmptyState from '@/components/ui/EmptyState';
import { fetchTrendingManga, searchManga, toContentItem } from '@/lib/manga';
import { searchAnime } from '@/lib/anime';
import { searchNovels } from '@/lib/allnovel';

import { searchUsers, type UserSearchResult } from '@/lib/user-search';
import { lookupUsernamePrefix, normalizeUserQuery } from '@/lib/user-resolve';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import { useWallet } from '@/lib/wallet/context';
import { formatUserSearchTitle, formatUserSearchMeta } from '@/lib/user-identity';

const { width: W } = Dimensions.get('window');
const FILTERS = ['All', 'Manga', 'Anime', 'Novel', 'Users'] as const;
type Filter = (typeof FILTERS)[number];

const SECTION_ORDER: Array<{ key: SearchResult['type']; title: string }> = [
  { key: 'user', title: 'People' },
  { key: 'anime', title: 'Anime' },
  { key: 'manga', title: 'Manga' },
  { key: 'novel', title: 'Novels' },
];

type SearchResult = {
  key: string;
  title: string;
  cover: string;
  type: 'manga' | 'anime' | 'novel' | 'user';
  meta: string;
  navTarget: string;
  user?: UserSearchResult;
};

function SearchIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Circle cx="11" cy="11" r="8" stroke={color} strokeWidth={2} />
      <Path d="M21 21l-4.35-4.35" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export default function SearchTabScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address: walletAddress } = useWallet();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autocompleteRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<any>(null);
  useScrollToTop(scrollRef);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [discoverCards, setDiscoverCards] = useState<Array<{ id: string; title: string; cover: string }>>([]);

  useEffect(() => {
    fetchTrendingManga(12)
      .then((items) => {
        setDiscoverCards(items.slice(0, 10).map((m) => ({ id: m.id, title: m.title, cover: toContentItem(m).cover })));
      })
      .catch(() => setDiscoverCards([]));
  }, []);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [mangaRes, animeRes, novelRes, usersRes] = await Promise.allSettled([
        searchManga(q, 12),
        searchAnime(q),
        searchNovels(q),
        searchUsers(q, 12),
      ]);

      const merged: SearchResult[] = [];

      if (mangaRes.status === 'fulfilled') {
        mangaRes.value.slice(0, 10).forEach((item) => {
          merged.push({
            key: `manga-${item.id}`,
            title: item.title,
            cover: toContentItem(item).cover,
            type: 'manga',
            meta: item.type || 'Manga',
            navTarget: `/manga/${item.id}`,
          });
        });
      }
      if (animeRes.status === 'fulfilled') {
        animeRes.value.slice(0, 10).forEach((item) => {
          merged.push({
            key: `anime-${item.id}`,
            title: item.title,
            cover: item.image,
            type: 'anime',
            meta: [item.type || 'Anime', item.year ? String(item.year) : null].filter(Boolean).join(' · '),
            navTarget: `/anime/${item.id}`,
          });
        });
      }
      if (novelRes.status === 'fulfilled') {
        novelRes.value.slice(0, 8).forEach((item) => {
          merged.push({
            key: `novel-${item.path}`,
            title: item.name,
            cover: item.cover || item.originalCover || '',
            type: 'novel',
            meta: 'Novel',
            navTarget: `/novel/ext?path=${encodeURIComponent(item.path)}`,
          });
        });
      }
      if (usersRes.status === 'fulfilled') {
        usersRes.value.forEach((user) => {
          merged.push({
            key: `user-${user.wallet_address}`,
            title: formatUserSearchTitle(user),
            cover: user.avatar_url || '',
            type: 'user',
            meta: formatUserSearchMeta(user),
            navTarget: `/user/${encodeURIComponent(user.wallet_address)}`,
            user,
          });
        });
      }

      setResults(merged);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  const onChangeQuery = useCallback(
    (text: string) => {
      setQuery(text);
      if (text.trim().startsWith('@')) {
        setFilter('Users');
      }

      if (autocompleteRef.current) clearTimeout(autocompleteRef.current);
      const prefix = normalizeUserQuery(text);
      if (prefix.length >= 2 && (text.includes('@') || text.trim().startsWith('@'))) {
        autocompleteRef.current = setTimeout(() => {
          lookupUsernamePrefix(prefix, 8)
            .then((rows) => {
              setSuggestions(rows);
              setShowSuggestions(rows.length > 0);
            })
            .catch(() => {
              setSuggestions([]);
              setShowSuggestions(false);
            });
        }, 250);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }

      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (text.trim().length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      debounceRef.current = setTimeout(() => runSearch(text), 400);
    },
    [runSearch],
  );

  const pickSuggestion = useCallback(
    (username: string) => {
      const next = `@${username}`;
      setQuery(next);
      setFilter('Users');
      setShowSuggestions(false);
      setSuggestions([]);
      setLoading(true);
      runSearch(next);
    },
    [runSearch],
  );

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (autocompleteRef.current) clearTimeout(autocompleteRef.current);
  }, []);

  const filteredResults = useMemo(() => {
    if (filter === 'All') return results;
    if (filter === 'Users') return results.filter((r) => r.type === 'user');
    return results.filter((r) => r.type === filter.toLowerCase());
  }, [filter, results]);

  const groupedSections = useMemo(() => {
    if (filter !== 'All') return [];
    return SECTION_ORDER
      .map((section) => ({
        title: section.title,
        data: filteredResults.filter((item) => item.type === section.key),
      }))
      .filter((section) => section.data.length > 0);
  }, [filter, filteredResults]);

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
          marginBottom: 20,
          height: 46,
        },
        input: {
          flex: 1,
          fontSize: FontSize.md,
          color: colors.text,
          fontFamily: Fonts.body,
        },
        sectionTitle: {
          fontSize: 22,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          color: colors.text,
          marginBottom: 10,
        },
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
          width: (W - Spacing.md * 2 - 10) / 2,
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
        filters: { flexDirection: 'row', gap: 8, marginBottom: 10 },
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
        results: { paddingBottom: 110, gap: 8 },
        resultRow: {
          flexDirection: 'row',
          gap: 10,
          borderRadius: Radius.md,
          backgroundColor: colors.surfaceSecondary,
          padding: 10,
        },
        resultCover: { width: 56, height: 76, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
        userAvatar: { width: 56, height: 56, borderRadius: 28 },
        resultInfo: { flex: 1, justifyContent: 'center', gap: 3 },
        resultTitle: { color: colors.text, fontSize: FontSize.md, fontFamily: Fonts.bodyBold },
        resultMeta: { color: colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.body },
        youChip: {
          alignSelf: 'flex-start',
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: Radius.full,
          backgroundColor: `${colors.primary}22`,
          marginBottom: 2,
        },
        youChipText: { color: colors.primary, fontSize: FontSize.xs, fontFamily: Fonts.bodyBold },
        sectionHeading: {
          fontSize: FontSize.md,
          fontFamily: Fonts.bodyBold,
          color: colors.textSecondary,
          marginTop: 4,
          marginBottom: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        },
        loader: { paddingTop: 48, alignItems: 'center' },
        empty: { paddingTop: 24 },
        suggestBox: {
          marginTop: -12,
          marginBottom: 12,
          borderRadius: Radius.md,
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          overflow: 'hidden',
        },
        suggestRow: {
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
        },
        suggestText: { color: colors.primary, fontSize: FontSize.md, fontFamily: Fonts.bodyMedium },
      }),
    [colors],
  );

  const renderResultRow = useCallback(
    (item: SearchResult, index: number) => {
      const isSelfUser = item.type === 'user' && Boolean(
        walletAddress && item.user?.wallet_address === walletAddress,
      );

      return (
      <Animated.View entering={FadeInDown.delay(index * 30).duration(240)}>
        <TouchableOpacity
          style={s.resultRow}
          activeOpacity={0.85}
          onPress={() => router.push(item.navTarget as never)}
        >
          {item.type === 'user' && item.user ? (
            <ProfileAvatar
              profile={{
                wallet_address: item.user.wallet_address,
                avatar_url: item.user.avatar_url,
                avatar_seed: item.user.avatar_seed ?? item.user.wallet_address,
              }}
              size={56}
              style={s.userAvatar}
            />
          ) : (
            <Image source={{ uri: item.cover }} style={s.resultCover} contentFit="cover" />
          )}
          <View style={s.resultInfo}>
            {isSelfUser ? (
              <View style={s.youChip}>
                <Text style={s.youChipText}>You</Text>
              </View>
            ) : null}
            <Text style={s.resultTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={s.resultMeta} numberOfLines={2}>
              {item.meta}
            </Text>
          </View>
        </TouchableOpacity>
      </Animated.View>
      );
    },
    [router, s, walletAddress],
  );

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        <Animated.Text entering={FadeIn.duration(220)} style={s.title}>
          Search
        </Animated.Text>

        <Animated.View entering={FadeInDown.duration(260)} style={s.searchWrap}>
          <SearchIcon color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={onChangeQuery}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="Series, @users, categories…"
            placeholderTextColor={colors.textTertiary}
            style={s.input}
            autoCorrect={false}
            returnKeyType="search"
          />
        </Animated.View>

        {showSuggestions && suggestions.length > 0 ? (
          <View style={s.suggestBox}>
            {suggestions.map((username) => (
              <TouchableOpacity
                key={username}
                style={s.suggestRow}
                onPress={() => pickSuggestion(username)}
                activeOpacity={0.85}
              >
                <Text style={s.suggestText}>@{username}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {query.trim().length < 2 ? (
          <ScrollView
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
            scrollIndicatorInsets={{ bottom: 90 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 110 }}
          >
            <Text style={s.sectionTitle}>What Everyone&apos;s Searching</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.discoverRow}>
              {discoverCards.slice(0, 6).map((card, idx) => (
                <Animated.View key={card.id} entering={FadeInDown.delay(idx * 40).duration(280)}>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={s.discoverCard}
                    onPress={() => router.push(`/manga/${card.id}` as never)}
                  >
                    <Image source={{ uri: card.cover }} style={s.discoverImg} contentFit="cover" />
                  </TouchableOpacity>
                </Animated.View>
              ))}
            </ScrollView>

            <Text style={[s.sectionTitle, { marginTop: 12 }]}>Browse Categories</Text>
            <View style={s.catGrid}>
              {categoryCards.map((cat, idx) => (
                <Animated.View key={cat.label} entering={FadeInDown.delay(idx * 35).duration(260)}>
                  <TouchableOpacity activeOpacity={0.85} style={s.catCard} onPress={() => onChangeQuery(cat.query)}>
                    <Text style={s.catLabel}>{cat.label}</Text>
                    {!!cat.cover && <Image source={{ uri: cat.cover }} style={s.catThumb} contentFit="cover" />}
                  </TouchableOpacity>
                </Animated.View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <>
            <View style={s.filters}>
              {FILTERS.map((f) => (
                <TouchableOpacity
                  key={f}
                  style={[s.filterChip, filter === f && s.filterChipActive]}
                  onPress={() => setFilter(f)}
                  activeOpacity={0.8}
                >
                  <Text style={[s.filterText, filter === f && s.filterTextActive]}>{f}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {loading ? (
              <View style={s.loader}>
                <ActivityIndicator color={colors.primary} size="large" />
              </View>
            ) : filter === 'All' ? (
              <SectionList
                sections={groupedSections}
                keyExtractor={(item) => item.key}
                showsVerticalScrollIndicator={false}
                scrollIndicatorInsets={{ bottom: 90 }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={groupedSections.length === 0 ? undefined : s.results}
                stickySectionHeadersEnabled={false}
                renderSectionHeader={({ section }) => (
                  <Text style={s.sectionHeading}>{section.title}</Text>
                )}
                renderItem={({ item, index }) => renderResultRow(item, index)}
                ListEmptyComponent={
                  <EmptyState compact title={`No results for "${query}"`} style={s.empty} />
                }
              />
            ) : (
              <FlatList
                data={filteredResults}
                keyExtractor={(item) => item.key}
                showsVerticalScrollIndicator={false}
                scrollIndicatorInsets={{ bottom: 90 }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={filteredResults.length === 0 ? undefined : s.results}
                renderItem={({ item, index }) => renderResultRow(item, index)}
                ListEmptyComponent={
                  <EmptyState compact title={`No results for "${query}"`} style={s.empty} />
                }
              />
            )}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
