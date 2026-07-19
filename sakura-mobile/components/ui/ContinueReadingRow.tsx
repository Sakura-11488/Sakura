import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import type { ContinueReadingItem } from '@/lib/reader-progress';
import { playTap } from '@/lib/sound';
import SectionHeader from '@/components/ui/SectionHeader';

const CARD_W = Dimensions.get('window').width * 0.58;
const CARD_H = CARD_W * 0.38;
const THUMB_W = CARD_H * 0.62;

interface ContinueReadingRowProps {
  items: ContinueReadingItem[];
  title?: string;
}

export default function ContinueReadingRow({ items, title = 'Continue Reading' }: ContinueReadingRowProps) {
  const { colors } = useTheme();
  const router = useRouter();

  if (items.length === 0) return null;

  const open = (item: ContinueReadingItem) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    if (item.kind === 'manga' && item.mangaId && item.chapterId) {
      router.push({
        pathname: '/chapter/[id]',
        params: {
          id: `${item.mangaId}~${item.chapterId}`,
          p: String(item.page || 1),
          title: item.title,
          cover: item.cover || '',
          chapter: item.subtitle.split(' · ')[0] || '',
          // Comics/18+ must carry their source or the reader falls back to the
          // manga backend and renders an empty "No pages found" screen.
          ...(item.source ? { source: item.source } : {}),
        },
      });
      return;
    }
    if (item.kind === 'novel' && item.novelPath) {
      router.push({
        pathname: '/novel/read',
        params: {
          path: item.novelPath,
          o: String(item.progress),
          title: item.title,
          cover: item.cover || '',
        },
      });
    }
  };

  return (
    <View style={s.wrap}>
      <SectionHeader title={title} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.list}>
        {items.map((item) => {
          const pct = Math.round(item.progress * 100);
          const thumb = item.cover;
          const badge = item.kind === 'manga' ? 'Manga' : 'Novel';
          return (
            <TouchableOpacity
              key={item.id}
              activeOpacity={0.88}
              onPress={() => open(item)}
              style={[s.card, { backgroundColor: colors.white, borderColor: colors.border }]}
            >
              {thumb ? (
                <Image source={{ uri: thumb }} style={s.thumb} contentFit="cover" />
              ) : (
                <View style={[s.thumb, s.thumbPlaceholder, { backgroundColor: `${colors.primary}18` }]} />
              )}
              <View style={s.body}>
                <Text style={[s.badge, { color: colors.primary }]}>{badge}</Text>
                <Text style={[s.title, { color: colors.text }]} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={[s.sub, { color: colors.textSecondary }]} numberOfLines={1}>
                  {item.subtitle}
                </Text>
                <View style={[s.track, { backgroundColor: `${colors.primary}22` }]}>
                  <View style={[s.fill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: Spacing.sm },
  list: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
    paddingBottom: 2,
  },
  card: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: Radius.md,
    overflow: 'hidden',
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
  },
  thumb: {
    width: THUMB_W,
    height: '100%',
  },
  thumbPlaceholder: {},
  body: {
    flex: 1,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    justifyContent: 'center',
    gap: 2,
  },
  badge: {
    fontSize: 9,
    fontWeight: FontWeight.bold,
    fontFamily: Fonts.body,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  title: {
    fontSize: FontSize.xs,
    fontWeight: FontWeight.semibold,
    lineHeight: 15,
  },
  sub: {
    fontSize: 10,
    fontFamily: Fonts.body,
  },
  track: {
    height: 3,
    borderRadius: 2,
    marginTop: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});
