import React, { useEffect, useMemo } from 'react';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
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
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { contentWidth } from '@/constants/layout';

/**
 * Read reactively. This was a module constant off Dimensions.get('window'),
 * captured once at bundle evaluation and never re-read — no listener exists
 * anywhere in the app. contentWidth() rather than the window width, because on
 * desktop web the sidebar is a sibling of the content column and anything sized
 * off the window overflows by exactly SIDEBAR_WIDTH.
 */
function useScreenWidth() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => (Platform.OS === 'web' ? contentWidth(windowW) : windowW), [windowW]);
}

/**
 * How far the highlight travels. A constant on purpose.
 *
 * ShimmerBox is a LEAF that mounts ~15 times on a loading screen, and
 * subscribing each instance to window dimensions put 15 resize listeners
 * behind every skeleton — react-native-web binds Dimensions to visualViewport
 * and replaces the dimensions object on every event with no equality guard,
 * so all 15 re-rendered on events that changed nothing.
 *
 * The sweep never needed the window anyway: it only has to be wider than the
 * box it sweeps, and the box is at most the content column. Using the box
 * width when it is a number keeps the sweep proportional; the fallback covers
 * percentage widths like '100%'.
 */
const SWEEP_FALLBACK = 420;

interface ShimmerProps {
  width: number | string;
  height: number;
  borderRadius?: number;
  style?: object;
}

export function ShimmerBox({ width, height, borderRadius = Radius.md, style }: ShimmerProps) {
  const { isDark, colors } = useTheme();
  const SCREEN_WIDTH = typeof width === 'number' && width > 0 ? width : SWEEP_FALLBACK;
  const translateX = useSharedValue(-SCREEN_WIDTH);

  useEffect(() => {
    translateX.value = withRepeat(
      withTiming(SCREEN_WIDTH, { duration: 1200, easing: Easing.linear }),
      -1,
      false
    );
    // SCREEN_WIDTH in the deps: the sweep distance was frozen at the width
    // the box first mounted at, so after a resize the highlight either
    // stopped short of the edge or ran past it.
  }, [SCREEN_WIDTH]);

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
  const SCREEN_WIDTH = useScreenWidth();
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

export function MessagesInboxSkeleton({ rows = 8 }: { rows?: number }) {
  const { colors } = useTheme();
  return (
    <View style={[msgSk.wrap, { backgroundColor: colors.background }]}>
      {Array.from({ length: rows }).map((_, i) => (
        <View
          key={i}
          style={[
            msgSk.row,
            i < rows - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
          ]}
        >
          <ShimmerBox width={48} height={48} borderRadius={24} />
          <View style={msgSk.textCol}>
            <ShimmerBox width={`${55 + (i % 3) * 10}%`} height={14} borderRadius={4} />
            <ShimmerBox width={`${70 - (i % 2) * 12}%`} height={12} borderRadius={4} style={{ marginTop: 8 }} />
          </View>
          <ShimmerBox width={24} height={10} borderRadius={4} />
        </View>
      ))}
    </View>
  );
}

export function ChatThreadSkeleton() {
  const { colors } = useTheme();
  const widths = ['68%', '52%', '74%', '44%'];
  return (
    <View style={[msgSk.thread, { backgroundColor: colors.background }]}>
      {widths.map((w, i) => (
        <View
          key={i}
          style={[msgSk.bubbleRow, i % 2 === 1 && msgSk.bubbleRowMine]}
        >
          <ShimmerBox width={w} height={i === 1 ? 36 : 48} borderRadius={16} />
        </View>
      ))}
    </View>
  );
}

const msgSk = StyleSheet.create({
  wrap: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
  },
  textCol: { flex: 1 },
  thread: { flex: 1, paddingHorizontal: Spacing.md, paddingTop: 16, gap: 10 },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
});

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
