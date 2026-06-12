import React, { useEffect } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface ShimmerProps {
  width: number | string;
  height: number;
  borderRadius?: number;
  style?: object;
}

export function ShimmerBox({ width, height, borderRadius = Radius.md, style }: ShimmerProps) {
  const { isDark, colors } = useTheme();
  const translateX = useSharedValue(-SCREEN_WIDTH);

  useEffect(() => {
    translateX.value = withRepeat(
      withTiming(SCREEN_WIDTH, { duration: 1200, easing: Easing.linear }),
      -1,
      false
    );
  }, []);

  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={[{ width, height, borderRadius, backgroundColor: isDark ? colors.surfaceSecondary : '#E8E8EE', overflow: 'hidden' }, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, shimmerStyle]}>
        <LinearGradient
          colors={
            isDark
              ? ['transparent', 'rgba(255,255,255,0.14)', 'transparent']
              : ['transparent', 'rgba(255,255,255,0.6)', 'transparent']
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </View>
  );
}

export function HomeScreenSkeleton() {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.skeleton, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.skRow}>
        <ShimmerBox width={112} height={34} borderRadius={8} />
        <ShimmerBox width={44} height={44} borderRadius={22} />
      </View>

      <ShimmerBox width="100%" height={52} borderRadius={Radius.full} style={{ marginTop: 18 }} />

      <View style={styles.skTabs}>
        {[82, 92, 92, 76].map((w, i) => (
          <ShimmerBox key={i} width={w} height={36} borderRadius={Radius.full} />
        ))}
      </View>

      <View style={styles.skCards}>
        <ShimmerBox width={SCREEN_WIDTH * 0.24} height={190} borderRadius={Radius.lg} style={{ opacity: 0.45 }} />
        <ShimmerBox width={SCREEN_WIDTH * 0.56} height={290} borderRadius={Radius.lg} />
        <ShimmerBox width={SCREEN_WIDTH * 0.24} height={190} borderRadius={Radius.lg} style={{ opacity: 0.45 }} />
      </View>

      <View style={styles.sectionHeader}>
        <ShimmerBox width={110} height={16} borderRadius={6} />
        <ShimmerBox width={54} height={14} borderRadius={6} />
      </View>

      <View style={styles.rowCards}>
        {[0, 1, 2].map((i) => (
          <ShimmerBox key={i} width={SCREEN_WIDTH - 40} height={92} borderRadius={Radius.md} />
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    flex: 1,
    padding: 20,
  },
  skRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  skTabs: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  skCards: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
  },
  sectionHeader: {
    marginTop: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowCards: {
    marginTop: 12,
    gap: 10,
  },
});
