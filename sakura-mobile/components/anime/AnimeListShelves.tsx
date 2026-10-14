import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { rememberAnimePreviews } from '@/lib/anime';
import { WATCHLIST_STATUSES, type WatchlistStatus } from '@/lib/anime-watchlist';
import { playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import useAnimeLists from './useAnimeLists';

export type AnimeListShelvesProps = { section: 'new' | 'list' };

const CARD_W = 108;
const CARD_H = CARD_W * 1.44;

/**
 * Native "New episodes for you" and "My list" rows for the Anime tab. The web
 * build resolves AnimeListShelves.web.tsx instead; both read the same hook.
 */
export default function AnimeListShelves({ section }: AnimeListShelvesProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const { entries, newEpisodes } = useAnimeLists(section === 'new');
  const [filter, setFilter] = useState<WatchlistStatus | 'all'>('all');
  const styles = useMemo(() => StyleSheet.create({
    section: { marginTop: 24 },
    title: { color: colors.text, fontSize: FontSize.lg, fontWeight: '700', fontFamily: Fonts.bodyBold, marginBottom: 12, paddingHorizontal: Spacing.md },
    scroll: { paddingHorizontal: Spacing.md, paddingBottom: 4 },
    chips: { paddingHorizontal: Spacing.md, gap: 7, paddingBottom: 12 },
    chip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: Radius.full, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    chipTextActive: { color: '#fff' },
    card: { width: CARD_W, marginRight: 8 },
    cover: { width: CARD_W, height: CARD_H, borderRadius: Radius.sm, overflow: 'hidden', backgroundColor: colors.surfaceSecondary },
    badge: { position: 'absolute', top: 5, left: 5, backgroundColor: colors.primary, borderRadius: Radius.full, paddingHorizontal: 6, paddingVertical: 2 },
    badgeText: { color: '#fff', fontSize: 8, fontFamily: Fonts.bodyBold, letterSpacing: 0.5 },
    cardTitle: { color: colors.text, fontSize: 10, fontFamily: Fonts.bodyMedium, marginTop: 5, lineHeight: 13 },
    cardMeta: { color: colors.textSecondary, fontSize: 9, fontFamily: Fonts.body, marginTop: 2 },
  }), [colors]);

  const counts = useMemo(() => {
    const map = new Map<WatchlistStatus, number>();
    for (const entry of entries) map.set(entry.status, (map.get(entry.status) ?? 0) + 1);
    return map;
  }, [entries]);

  if (section === 'new') {
    if (!newEpisodes.length) return null;
    return (
      <View style={styles.section}>
        <Text style={styles.title}>New episodes for you</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
          {newEpisodes.map((item) => (
            <TouchableOpacity
              key={item.animeId}
              style={styles.card}
              activeOpacity={0.8}
              accessibilityLabel={`${item.title}: play episode ${item.nextEpisode}`}
              onPress={() => {
                playTap();
                rememberAnimePreviews([{ id: item.animeId, title: item.title, image: item.cover }]);
                router.push({ pathname: '/anime/watch', params: { id: item.animeId, ep: `mal-${item.animeId}-${item.nextEpisode}` } });
              }}
            >
              <View style={styles.cover}>
                {!!item.cover && <Image source={{ uri: item.cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />}
                <View style={styles.badge}><Text style={styles.badgeText}>NEW · EP {item.latestAired}</Text></View>
              </View>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.cardMeta} numberOfLines={1}>
                {item.newCount > 1 ? `${item.newCount} new episodes` : `Episode ${item.nextEpisode} is out`}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  }

  if (!entries.length) return null;
  const active = filter !== 'all' && !counts.get(filter) ? 'all' : filter;
  const visible = active === 'all' ? entries : entries.filter((entry) => entry.status === active);
  return (
    <View style={styles.section}>
      <Text style={styles.title}>My list</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {[{ value: 'all' as const, label: 'All', count: entries.length }, ...WATCHLIST_STATUSES
          .filter((status) => counts.get(status.value))
          .map((status) => ({ ...status, count: counts.get(status.value) ?? 0 }))].map((option) => {
          const selected = active === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              onPress={() => { playTap(); setFilter(option.value); }}
              style={[styles.chip, selected && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.chipText, selected && styles.chipTextActive]}>{option.label} · {option.count}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {visible.map((entry) => (
          <TouchableOpacity
            key={entry.animeId}
            style={styles.card}
            activeOpacity={0.8}
            onPress={() => {
              playTap();
              rememberAnimePreviews([{ id: entry.animeId, title: entry.title, image: entry.cover }]);
              router.push({ pathname: '/anime/[id]', params: { id: entry.animeId } });
            }}
          >
            <View style={styles.cover}>
              {!!entry.cover && <Image source={{ uri: entry.cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />}
            </View>
            <Text style={styles.cardTitle} numberOfLines={2}>{entry.title || 'Untitled'}</Text>
            {active === 'all' && (
              <Text style={styles.cardMeta} numberOfLines={1}>
                {WATCHLIST_STATUSES.find((status) => status.value === entry.status)?.label}
              </Text>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}
