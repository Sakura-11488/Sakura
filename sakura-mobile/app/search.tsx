import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Keyboard,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import Svg, { Path, Circle } from 'react-native-svg';
import SearchBar from '@/components/ui/SearchBar';
import EmptyState from '@/components/ui/EmptyState';
import { Spacing, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { searchManga, toContentItem } from '@/lib/manga';
import { searchAnime } from '@/lib/anime';
import { searchNovels } from '@/lib/allnovel';
import { onTap, playTap } from '@/lib/sound';

const RECENT = ['Chainsaw Man', 'Attack on Titan', 'One Piece', 'Naruto'];
const FILTERS = ['All', 'Manga', 'Anime', 'Novel'] as const;
type Filter = (typeof FILTERS)[number];

interface SearchResult {
  key: string;
  title: string;
  cover: string;
  type: 'manga' | 'anime' | 'novel';
  meta: string;
  navTarget: string;
}

const TYPE_BADGE_BG: Record<string, string> = {
  manga: '#E8454520',
  anime: '#5856D620',
  novel: '#34C75920',
};
const TYPE_BADGE_TEXT: Record<string, string> = {
  manga: '#E84545',
  anime: '#5856D6',
  novel: '#34C759',
};

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ClockIcon({ color }: { color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth={2} />
      <Path d="M12 7v5l3 3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function SearchScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const s = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.sm,
      paddingHorizontal: Spacing.md,
      paddingVertical: 8,
    },
    backBtn: { padding: 8 },
    filters: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: Spacing.md,
      paddingBottom: 12,
    },
    filterChip: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    filterChipActive: {
      backgroundColor: '#E84545',
      borderColor: '#E84545',
    },
    filterText: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.medium,
      color: colors.textSecondary,
    },
    filterTextActive: { color: '#fff', fontWeight: FontWeight.semibold },
    recentSection: { paddingHorizontal: Spacing.md },
    sectionLabel: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: colors.textSecondary,
      marginBottom: Spacing.sm,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    recentRow: {
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    recentText: {
      fontSize: FontSize.md,
      color: colors.text,
      fontWeight: FontWeight.medium,
      flex: 1,
    },
    resultList: { padding: Spacing.md, gap: Spacing.sm },
    resultRow: {
      flexDirection: 'row',
      gap: Spacing.md,
      backgroundColor: colors.white,
      borderRadius: Radius.lg,
      padding: Spacing.sm,
      ...Shadow.sm,
    },
    resultThumb: { width: 60, height: 80, borderRadius: Radius.sm },
    resultInfo: { flex: 1, justifyContent: 'center', gap: 3 },
    resultTitle: {
      fontSize: FontSize.md,
      fontWeight: FontWeight.semibold,
      color: colors.text,
    },
    resultMeta: {
      fontSize: FontSize.sm,
      color: colors.textSecondary,
    },
    typeBadge: {
      alignSelf: 'flex-start',
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: Radius.full,
    },
    typeBadgeText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.bold,
      letterSpacing: 0.5,
    },
    loader: { paddingTop: 80, alignItems: 'center' },
    empty: { paddingTop: 40 },
  }), [colors]);

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [mangaRes, animeRes, novelRes] = await Promise.allSettled([
        searchManga(q, 10),
        searchAnime(q),
        searchNovels(q),
      ]);

      const all: SearchResult[] = [];

      if (mangaRes.status === 'fulfilled') {
        mangaRes.value.slice(0, 8).forEach((item) => {
          const ci = toContentItem(item);
          all.push({
            key: `manga-${item.id}`,
            title: item.title,
            cover: ci.cover,
            type: 'manga',
            meta: item.type ? item.type : 'Manga',
            navTarget: `/manga/${item.id}`,
          });
        });
      }

      if (animeRes.status === 'fulfilled') {
        animeRes.value.slice(0, 8).forEach((item) => {
          const parts = ['Anime'];
          if (item.year) parts.push(String(item.year));
          if (item.score) parts.push(`★ ${item.score}`);
          all.push({
            key: `anime-${item.id}`,
            title: item.title,
            cover: item.image,
            type: 'anime',
            meta: parts.join(' · '),
            navTarget: `/anime/${item.id}`,
          });
        });
      }

      if (novelRes.status === 'fulfilled') {
        novelRes.value.slice(0, 6).forEach((item) => {
          all.push({
            key: `novel-${item.path}`,
            title: item.name,
            cover: item.cover || item.originalCover || '',
            type: 'novel',
            meta: 'Novel',
            navTarget: `/novel/ext?path=${encodeURIComponent(item.path)}`,
          });
        });
      }

      setResults(all);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback((text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => runSearch(text), 400);
  }, [runSearch]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const filtered = useMemo(() => {
    if (filter === 'All') return results;
    const t = filter.toLowerCase() as 'manga' | 'anime' | 'novel';
    return results.filter((r) => r.type === t);
  }, [results, filter]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <Animated.View entering={FadeIn.duration(200)} style={s.header}>
        <TouchableOpacity onPress={onTap(() => router.back())} style={s.backBtn} activeOpacity={0.7}>
          <BackIcon color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <SearchBar
            value={query}
            onChangeText={handleSearch}
            autoFocus
            placeholder="Anime, manga, novels..."
            onSearchPress={() => Keyboard.dismiss()}
          />
        </View>
      </Animated.View>

      {/* Filter chips */}
      {query.length > 0 && (
        <Animated.View entering={FadeIn.duration(180)} style={s.filters}>
          {FILTERS.map((f) => (
            <TouchableOpacity
              key={f}
              onPress={() => setFilter(f)}
              style={[s.filterChip, filter === f && s.filterChipActive]}
              activeOpacity={0.7}
            >
              <Text style={[s.filterText, filter === f && s.filterTextActive]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      )}

      {query.length === 0 ? (
        /* Recent searches */
        <Animated.View entering={FadeInDown.duration(300)} style={s.recentSection}>
          <Text style={s.sectionLabel}>Recent Searches</Text>
          {RECENT.map((r, i) => (
            <Animated.View key={r} entering={FadeInDown.delay(i * 40).duration(300)}>
              <TouchableOpacity onPress={() => handleSearch(r)} style={s.recentRow} activeOpacity={0.7}>
                <ClockIcon color={colors.textTertiary} />
                <Text style={s.recentText}>{r}</Text>
              </TouchableOpacity>
            </Animated.View>
          ))}
        </Animated.View>
      ) : loading ? (
        <Animated.View entering={FadeIn.duration(200)} style={s.loader}>
          <ActivityIndicator color="#E84545" size="large" />
        </Animated.View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => i.key}
          contentContainerStyle={s.resultList}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item, index }) => (
            <Animated.View entering={FadeInDown.delay(index * 35).duration(280)}>
              <TouchableOpacity
                onPress={() => { playTap(); Keyboard.dismiss(); router.push(item.navTarget as any); }}
                style={s.resultRow}
                activeOpacity={0.8}
              >
                <Image
                  source={{ uri: item.cover }}
                  style={s.resultThumb}
                  contentFit="cover"
                />
                <View style={s.resultInfo}>
                  <Text style={s.resultTitle} numberOfLines={2}>{item.title}</Text>
                  <Text style={s.resultMeta} numberOfLines={1}>{item.meta}</Text>
                  <View style={[s.typeBadge, { backgroundColor: TYPE_BADGE_BG[item.type] }]}>
                    <Text style={[s.typeBadgeText, { color: TYPE_BADGE_TEXT[item.type] }]}>
                      {item.type.toUpperCase()}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            </Animated.View>
          )}
          ListEmptyComponent={
            <Animated.View entering={FadeIn.duration(300)}>
              <EmptyState compact title={`No results for "${query}"`} style={s.empty} />
            </Animated.View>
          }
        />
      )}
    </SafeAreaView>
  );
}
