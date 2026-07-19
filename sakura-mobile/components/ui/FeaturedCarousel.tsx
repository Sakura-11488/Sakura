import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, useWindowDimensions, Platform, TouchableOpacity } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  withRepeat,
  withSequence,
  withDelay,
  withTiming,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { playTap } from '@/lib/sound';
import { useRouter } from 'expo-router';
import { Radius, FontSize, FontWeight, Fonts, Shadow } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { MAX_CAROUSEL_CARD_WIDTH, contentWidth } from '@/constants/layout';

const INFO_H = 72;
const GAP = 16;

type CarouselMetrics = {
  CARD_W: number;
  CARD_H: number;
  SNAP: number;
  PAD: number;
};

function useCarouselMetrics(): CarouselMetrics {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const w = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    const CARD_W =
      Platform.OS === 'web'
        ? Math.min(w * 0.38, MAX_CAROUSEL_CARD_WIDTH)
        : w * 0.58;
    const CARD_H = CARD_W * 1.5;
    const SNAP = CARD_W + GAP;
    const PAD = (w - CARD_W) / 2;
    return { CARD_W, CARD_H, SNAP, PAD };
  }, [windowW]);
}

export interface CarouselItem {
  id: string;
  title: string;
  cover: string;
  /** Local require() asset — takes precedence over cover URI when set */
  localCover?: any;
  genres: string[];
  type: 'anime' | 'manga' | 'novel';
  /** For manga-type items, which backing source to read from. Defaults to atsu manga. */
  source?: 'manga' | 'comics' | 'hentai';
}

// ─── Card ─────────────────────────────────────────────────────────────────────
function Card({
  item,
  index,
  scrollX,
  metrics,
}: {
  item: CarouselItem;
  index: number;
  scrollX: SharedValue<number>;
  metrics: CarouselMetrics;
}) {
  const { CARD_W, CARD_H, SNAP } = metrics;
  const cardStyles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          width: CARD_W,
          borderRadius: Radius.lg,
          ...Shadow.sm,
        },
        card: {
          width: CARD_W,
          borderRadius: Radius.lg,
          overflow: 'hidden',
        },
        imgWrap: {
          width: CARD_W,
          height: CARD_H,
          overflow: 'hidden',
          borderTopLeftRadius: Radius.lg,
          borderTopRightRadius: Radius.lg,
          padding: 8,
        },
        img: {
          width: '100%',
          height: '100%',
          borderRadius: Radius.sm,
          overflow: 'hidden',
        },
        shine: {
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 70,
        },
        shineInner: {
          flex: 1,
          backgroundColor: 'rgba(255,255,255,0.18)',
        },
        info: {
          paddingHorizontal: 12,
          paddingVertical: 12,
          borderBottomLeftRadius: Radius.lg,
          borderBottomRightRadius: Radius.lg,
          height: INFO_H,
          justifyContent: 'center',
          gap: 3,
        },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 15,
          letterSpacing: 0.2,
        },
        genres: {
          fontFamily: Fonts.body,
          fontSize: 12,
        },
      }),
    [CARD_W, CARD_H],
  );
  const router = useRouter();
  const { colors } = useTheme();
  const ir = [(index - 1) * SNAP, index * SNAP, (index + 1) * SNAP];

  const shineX = useSharedValue(-CARD_W);
  useEffect(() => {
    shineX.value = withDelay(
      index * 700,
      withRepeat(
        withSequence(
          withDelay(2400, withTiming(CARD_W * 1.8, { duration: 700 })),
          withTiming(-CARD_W, { duration: 0 })
        ),
        -1
      )
    );
  }, []);

  const cardStyle = useAnimatedStyle(() => {
    const scale  = interpolate(scrollX.value, ir, [0.82, 1, 0.82], Extrapolation.CLAMP);
    const rotY   = interpolate(scrollX.value, ir, [20, 0, -20],    Extrapolation.CLAMP);
    const transY = interpolate(scrollX.value, ir, [22, 0, 22],     Extrapolation.CLAMP);
    const opacity= interpolate(scrollX.value, ir, [0.52, 1, 0.52], Extrapolation.CLAMP);
    return {
      transform: [
        { perspective: 900 },
        { scale },
        { rotateY: `${rotY}deg` },
        { translateY: transY },
      ],
      opacity,
    };
  });

  const shineStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shineX.value }, { rotate: '18deg' }],
  }));

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
    <Animated.View style={[cardStyles.wrap, { backgroundColor: colors.white }, cardStyle]}>
      <TouchableOpacity onPress={handlePress} activeOpacity={0.97} style={[cardStyles.card, { backgroundColor: colors.white }]}>
        <View style={[cardStyles.imgWrap, { backgroundColor: colors.white }]}>
          <Image
            source={item.localCover || { uri: item.cover }}
            style={cardStyles.img}
            contentFit="cover"
            transition={350}
          />
          <Animated.View style={[cardStyles.shine, shineStyle]} pointerEvents="none">
            <View style={cardStyles.shineInner} />
          </Animated.View>
        </View>

        <View style={[cardStyles.info, { backgroundColor: colors.white }]}>
          <Text style={[cardStyles.title, { color: colors.text }]} numberOfLines={1}>
            {item.title.toUpperCase()}
          </Text>
          <Text style={[cardStyles.genres, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.genres.join(', ')}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function FeaturedCarousel({ data }: { data: CarouselItem[] }) {
  const metrics = useCarouselMetrics();
  const { SNAP, PAD } = metrics;
  const scrollX      = useSharedValue(0);
  const listRef      = useRef<any>(null);
  const currentIdx   = useRef(0);
  const [inited, setInited] = useState(false);

  const updateCurrentIndex = useCallback((idx: number) => {
    currentIdx.current = idx;
  }, []);

  const handler = useAnimatedScrollHandler({
    onScroll:       (e) => { scrollX.value = e.contentOffset.x; },
    onMomentumEnd:  (e) => {
      const idx = Math.round(e.contentOffset.x / SNAP);
      runOnJS(updateCurrentIndex)(idx);
    },
  });

  return (
    <Animated.FlatList
      ref={listRef}
      data={data}
      keyExtractor={(i) => i.id}
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={SNAP}
      decelerationRate="fast"
      contentContainerStyle={{
        paddingHorizontal: PAD,
        gap: GAP,
        paddingTop: 16,
        paddingBottom: 12,
        alignItems: 'flex-start',
      }}
      onScroll={handler}
      scrollEventThrottle={16}
      onLayout={() => {
        if (!inited && data.length > 1) {
          const mid = Math.floor(data.length / 2);
          currentIdx.current = mid;
          listRef.current?.scrollToOffset({ offset: mid * SNAP, animated: false });
          setInited(true);
        }
      }}
      renderItem={({ item, index }) => (
        <Card item={item} index={index} scrollX={scrollX} metrics={metrics} />
      )}
    />
  );
}
