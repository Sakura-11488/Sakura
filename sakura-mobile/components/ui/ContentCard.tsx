import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { playTap } from '@/lib/sound';
import { useRouter } from 'expo-router';
// Type-only, so the mutual reference with the source registry is erased at
// compile time and creates no runtime cycle.
import type { ScrapedSource } from '@/lib/scraped-sources';
import { Colors, Radius, FontSize, FontWeight, Shadow } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

// Neutral placeholder shown while a poster loads — kills the white flash that a
// blank <Image> would otherwise show in dark mode. Reused from the anime screens.
const POSTER_BLURHASH = 'L02?U100~A~qIURjofWB~qxuRjWB';

export interface ContentItem {
  id: string;
  title: string;
  cover: string;
  type: 'anime' | 'manga' | 'novel';
  /**
   * For manga-type items, which backing source to read from. Defaults to atsu
   * manga. Widened from the source registry so adding a scraper can't leave a
   * card silently unable to represent it.
   */
  source?: 'manga' | ScrapedSource;
  badge?: string;
  score?: number;
}

const CARD_W = 112;
const CARD_H = CARD_W * 1.46;

function ContentCard({ item }: { item: ContentItem }) {
  const router = useRouter();
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const shadow = useSharedValue(0.06);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    shadowOpacity: shadow.value,
  }));

  const handlePressIn = () => {
    scale.value = withTiming(0.95, { duration: 80 });
    shadow.value = withTiming(0.14, { duration: 80 });
  };
  const handlePressOut = () => {
    scale.value = withTiming(1, { duration: 120 });
    shadow.value = withTiming(0.06, { duration: 120 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    if (item.type === 'manga' && item.source && item.source !== 'manga') {
      router.push({ pathname: '/manga/[id]', params: { id: item.id, source: item.source } } as any);
      return;
    }
    router.push(`/${item.type}/${item.id}` as any);
  };

  return (
    <Animated.View style={[s.wrap, { backgroundColor: colors.surface }, style, Shadow.md]}>
      <TouchableOpacity
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={handlePress}
        activeOpacity={1}
        style={s.card}
      >
        <Image
          source={{ uri: item.cover }}
          style={[s.img, { backgroundColor: colors.surface }]}
          contentFit="cover"
          transition={220}
          cachePolicy="memory-disk"
          recyclingKey={item.id}
          placeholder={{ blurhash: POSTER_BLURHASH }}
          placeholderContentFit="cover"
        />

        {item.badge && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{item.badge}</Text>
          </View>
        )}

        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.75)']}
          style={s.gradient}
        />
        <View style={s.info}>
          <Text style={s.title} numberOfLines={2}>{item.title}</Text>
          {item.score && (
            <View style={s.scoreRow}>
              <Text style={s.star}>★</Text>
              <Text style={s.score}>{item.score.toFixed(1)}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {
    width: CARD_W,
    borderRadius: Radius.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
  },
  card: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  img: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    top: 7,
    left: 7,
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    color: Colors.white,
    fontSize: 9,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.4,
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '55%',
  },
  info: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
  },
  title: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: FontWeight.semibold,
    lineHeight: 13,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 2,
  },
  star: { color: Colors.gold, fontSize: 10 },
  score: { color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold },
});

// Memoized: these render in long horizontal rails and grids that re-render on
// scroll/category changes; the item identity is stable so re-renders are skipped.
export default React.memo(ContentCard);
