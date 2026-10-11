import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import AntDesign from '@expo/vector-icons/AntDesign';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { contentWidth } from '@/constants/layout';
import { removeFromContinueWatching, type AnimeWatchProgress } from '@/lib/watch-progress';
import { playTap } from '@/lib/sound';
import SectionHeader from '@/components/ui/SectionHeader';

/**
 * Card width for the current window.
 *
 * This used to be `Dimensions.get('window').width * 0.65` evaluated at module
 * load. Two things were wrong with that: the fraction is a phone heuristic, so
 * on a 1920px desktop it produced cards over 1200px wide; and because it ran at
 * import it never re-measured, so resizing the window did nothing.
 *
 * The cap is what makes it a row rather than one enormous card per screen.
 */
function cardWidth(windowW: number): number {
  const available = contentWidth(windowW);
  return Math.min(available * 0.65, 360);
}

interface ContinueWatchingRowProps {
  items: AnimeWatchProgress[];
  title?: string;
}

export default function ContinueWatchingRow({ items, title = 'Continue Watching' }: ContinueWatchingRowProps) {
  const { colors } = useTheme();
  const { width: windowW } = useWindowDimensions();
  const CARD_W = cardWidth(windowW);
  const CARD_H = CARD_W * 0.48;
  const s = useMemo(() => makeStyles(CARD_W, CARD_H), [CARD_W, CARD_H]);
  const router = useRouter();
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const visibleItems = items.filter(item => item.updatedAt > (dismissed[item.animeId] ?? -1));

  if (visibleItems.length === 0) return null;

  const open = (item: AnimeWatchProgress) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    router.push({
      pathname: '/anime/watch',
      params: { id: item.animeId, ep: item.episodeId },
    });
  };

  return (
    <View style={s.wrap}>
      <SectionHeader title={title} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.list}
      >
        {visibleItems.map((item) => {
          const pct = Math.round(item.progress * 100);
          const thumb = item.episodeThumbnail || item.cover;
          const epLabel =
            item.progress === 0
              ? `Ep ${item.episodeNumber} · Up next`
              : `Ep ${item.episodeNumber}${item.episodeTitle ? ` · ${item.episodeTitle}` : ''}`;
          return (
            <View key={item.animeId} style={[s.card, { backgroundColor: colors.white, borderColor: colors.border }]}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Continue ${item.title}, episode ${item.episodeNumber}`}
              activeOpacity={0.88}
              onPress={() => open(item)}
              style={s.cardContent}
            >
              <View style={s.thumbWrap}>
                {thumb ? (
                  <Image source={{ uri: thumb }} style={s.thumb} contentFit="cover" contentPosition="top" />
                ) : (
                  <View style={[s.thumb, s.thumbPlaceholder, { backgroundColor: colors.surfaceSecondary }]} />
                )}
              </View>

              <View style={s.body}>
                <Text style={[s.title, { color: colors.text }]} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={[s.sub, { color: colors.textSecondary }]} numberOfLines={1}>
                  {epLabel}
                </Text>
                <View style={[s.track, { backgroundColor: `${colors.primary}22` }]}>
                  <View style={[s.fill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
                </View>
              </View>

              <View style={s.thumbOverlay} pointerEvents="none">
                <LinearGradient
                  colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.65)']}
                  locations={[0, 0.45, 1]}
                  style={StyleSheet.absoluteFill}
                />
                <View style={s.playStack}>
                  <View style={s.rippleOuter} />
                  <View style={s.rippleMid} />
                  <View style={s.rippleInner} />
                  <View style={s.playIconWrap}>
                    <AntDesign name="play-circle" size={26} color="#fff" />
                  </View>
                </View>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.title} from Continue Watching`}
              accessibilityHint="Keeps your episode history and watched status"
              style={[s.remove, { backgroundColor: colors.white }]}
              onPress={() => {
                setDismissed(value => ({ ...value, [item.animeId]: item.updatedAt }));
                void removeFromContinueWatching(item.animeId);
              }}
            ><AntDesign name="close" size={14} color={colors.textSecondary} /></TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (CARD_W: number, CARD_H: number) => {
  const THUMB_W = CARD_H * 1.15;
  return StyleSheet.create({
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
    position: 'relative',
  },
  cardContent: { flex: 1, flexDirection: 'row' },
  remove: { position: 'absolute', right: 2, top: 2, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', zIndex: 40 },
  thumbWrap: {
    width: THUMB_W,
    height: CARD_H,
    overflow: 'hidden',
  },
  thumb: {
    width: THUMB_W,
    height: CARD_H,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: THUMB_W,
    height: CARD_H,
    zIndex: 30,
    elevation: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playStack: {
    width: 62,
    height: 62,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rippleOuter: {
    position: 'absolute',
    width: 62,
    height: 62,
    borderRadius: 31,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rippleMid: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  rippleInner: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.38)',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  playIconWrap: {
    zIndex: 3,
    elevation: 3,
  },
  body: {
    flex: 1,
    paddingHorizontal: Spacing.sm,
    paddingTop: 24,
    paddingBottom: 8,
    justifyContent: 'center',
    gap: 3,
  },
  title: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    lineHeight: 17,
  },
  sub: {
    fontSize: FontSize.xs,
    fontFamily: Fonts.body,
  },
  track: {
    height: 4,
    borderRadius: 2,
    marginTop: 4,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});
};
