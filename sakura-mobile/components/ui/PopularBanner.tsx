import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { playTap } from '@/lib/sound';
import { useRouter } from 'expo-router';
import { Colors, Radius, Shadow, FontSize, FontWeight, Spacing } from '@/constants/theme';

const { width: W } = Dimensions.get('window');
const BANNER_W = W - Spacing.md * 2 - 20;
const BANNER_H = 156;

export interface BannerItem {
  id: string;
  title: string;
  cover: string;
  type: 'anime' | 'manga' | 'novel';
  episodes?: number;
}

const PlayIcon = () => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="white">
    <Path d="M5 3l14 9-14 9V3z" fill="white" />
  </Svg>
);

export default function PopularBanner({ item }: { item: BannerItem }) {
  const router = useRouter();
  const scale = useSharedValue(1);
  const brightness = useSharedValue(1);

  const wrapStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const imgStyle = useAnimatedStyle(() => ({
    opacity: brightness.value,
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 15 });
    brightness.value = withSpring(0.88);
  };
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 12 });
    brightness.value = withSpring(1);
  };
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    router.push(`/${item.type}/${item.id}` as any);
  };

  return (
    <Animated.View style={[s.wrapper, wrapStyle]}>
      <TouchableOpacity
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={handlePress}
        activeOpacity={1}
        style={s.container}
      >
        <Animated.View style={imgStyle}>
          <Image source={{ uri: item.cover }} style={s.image} contentFit="cover" transition={350} />
        </Animated.View>

        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.78)']}
          locations={[0.2, 0.6, 1]}
          style={s.gradient}
        />

        {/* Bottom row */}
        <View style={s.bottom}>
          <View style={s.bottomLeft}>
            <Text style={s.title}>{item.title}</Text>
            {item.episodes && (
              <Text style={s.sub}>{item.episodes} Episodes</Text>
            )}
          </View>
          <View style={s.playBtn}>
            <PlayIcon />
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrapper: {
    marginHorizontal: Spacing.md + 10,
    marginBottom: 10,
    borderRadius: Radius.lg,
    ...Shadow.md,
    shadowColor: '#000',
  },
  container: {
    width: BANNER_W,
    height: BANNER_H,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '70%',
  },
  bottom: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bottomLeft: { flex: 1, marginRight: 12 },
  title: {
    color: Colors.white,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.3,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  sub: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: FontSize.xs,
    marginTop: 2,
    fontWeight: FontWeight.medium,
  },
  playBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
});
