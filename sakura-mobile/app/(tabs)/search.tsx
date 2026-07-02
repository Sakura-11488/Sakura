import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Dimensions,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useScrollToTop, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import EmptyState from '@/components/ui/EmptyState';
import { fetchTrendingManga, searchManga, toContentItem } from '@/lib/manga';
import { searchAnime } from '@/lib/anime';
import { searchNovels } from '@/lib/allnovel';
import { searchUsersByUsername, type UserSearchResult } from '@/lib/creator';
import { navigateToUserChat, userDisplayLabel } from '@/lib/user-chat-nav';

const { width: W } = Dimensions.get('window');
const FILTERS = ['All', 'Manga', 'Anime', 'Novel', 'Users'] as const;
type Filter = (typeof FILTERS)[number];

type SearchResult = {
  key: string;
  title: string;
  cover: string;
  type: 'manga' | 'anime' | 'novel' | 'user';
  meta: string;
  navTarget?: string;
  user?: UserSearchResult;
};

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

export default function SearchTabScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address, unlockForAppSession } = useWallet();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<any>(null);
  const inputRef = useRef<TextInput>(null);
  useScrollToTop(scrollRef);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [messagingUser, setMessagingUser] = useState<string | null>(null);
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
      const [mangaRes, animeRes, novelRes, userRes] = await Promise.allSettled([
        searchManga(q, 12),
        searchAnime(q),
        searchNovels(q),
        searchUsersByUsername(q, 12),
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
      if (userRes.status === 'fulfilled') {
        userRes.value
          .filter((user) => !address || user.wallet_address !== address)
          .slice(0, 10)
          .forEach((user) => {
            merged.push({
              key: `user-${user.wallet_address}`,
              title: userDisplayLabel(user),
              cover: user.avatar_url ?? '',
              type: 'user',
              meta: `@${user.username}`,
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
  }, [address]);

  const onChangeQuery = useCallback(
    (text: string) => {
      setQuery(text);
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

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      return () => {
        setQuery('');
        setFilter('All');
        setResults([]);
        setLoading(false);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        inputRef.current?.blur();
      };
    }, []),
  );

  const filteredResults = useMemo(() => {
    if (filter === 'All') return results;
    if (filter === 'Users') return results.filter((r) => r.type === 'user');
    return results.filter((r) => r.type === filter.toLowerCase());
  }, [filter, results]);

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
          fontSize: Platform.OS === 'web' ? 16 : FontSize.md,
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
        loader: { paddingTop: 48, alignItems: 'center' },
        empty: { paddingTop: 24 },
      }),
    [colors],
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
            ref={inputRef}
            value={query}
            onChangeText={onChangeQuery}
            placeholder="Series, creators, users, and more"
            placeholderTextColor={colors.textTertiary}
            style={s.input}
            autoCorrect={false}
            returnKeyType="search"
          />
        </Animated.View>

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
            ) : (
              <FlatList
                data={filteredResults}
                keyExtractor={(item) => item.key}
                showsVerticalScrollIndicator={false}
                scrollIndicatorInsets={{ bottom: 90 }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={s.results}
                renderItem={({ item, index }) => {
                  const isUser = item.type === 'user';
                  const seed = item.user?.avatar_seed ?? item.user?.wallet_address.slice(0, 8) ?? '?';
                  const busy = isUser && messagingUser === item.user?.wallet_address;

                  return (
                    <Animated.View entering={FadeInDown.delay(index * 30).duration(240)}>
                      <TouchableOpacity
                        style={s.resultRow}
                        activeOpacity={0.85}
                        disabled={!!busy}
                        onPress={() => handleResultPress(item)}
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
                          <Image source={{ uri: item.cover }} style={s.resultCover} contentFit="cover" />
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
                }}
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
