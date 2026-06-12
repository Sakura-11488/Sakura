import React, { useEffect } from 'react';
import { StyleSheet, Dimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import Svg, { Path, G } from 'react-native-svg';

const { width: W, height: H } = Dimensions.get('window');

interface LeafConfig {
  x: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
  opacity: number;
  color: string;
}

const LEAVES: LeafConfig[] = [
  { x: W * 0.08, size: 14, duration: 9000,  delay: 0,    drift: 38,  opacity: 0.45, color: '#FFB7C5' },
  { x: W * 0.22, size: 10, duration: 11500, delay: 1200, drift: -28, opacity: 0.35, color: '#FF8FAB' },
  { x: W * 0.38, size: 16, duration: 8500,  delay: 2600, drift: 44,  opacity: 0.40, color: '#FFB7C5' },
  { x: W * 0.52, size: 11, duration: 13000, delay: 400,  drift: -36, opacity: 0.30, color: '#FFCAD4' },
  { x: W * 0.65, size: 13, duration: 10000, delay: 3400, drift: 30,  opacity: 0.42, color: '#FF8FAB' },
  { x: W * 0.78, size: 9,  duration: 12000, delay: 1800, drift: -22, opacity: 0.28, color: '#FFB7C5' },
  { x: W * 0.90, size: 15, duration: 9500,  delay: 5200, drift: 40,  opacity: 0.38, color: '#FFCAD4' },
  { x: W * 0.14, size: 12, duration: 14000, delay: 700,  drift: -30, opacity: 0.32, color: '#FF8FAB' },
  { x: W * 0.46, size: 10, duration: 10500, delay: 4100, drift: 26,  opacity: 0.36, color: '#FFB7C5' },
  { x: W * 0.72, size: 14, duration: 11000, delay: 2200, drift: -42, opacity: 0.40, color: '#FFCAD4' },
];

function PetalSvg({ size, color }: { size: number; color: string }) {
  const s = size;
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <G>
        <Path
          d="M12 2 C8 2 4 6 4 10 C4 14 8 18 12 22 C16 18 20 14 20 10 C20 6 16 2 12 2Z"
          fill={color}
          opacity={0.9}
        />
        <Path
          d="M12 2 C12 2 12 12 12 22"
          stroke="rgba(255,255,255,0.4)"
          strokeWidth={0.8}
          fill="none"
        />
      </G>
    </Svg>
  );
}

function Leaf({ config }: { config: LeafConfig }) {
  const y       = useSharedValue(-30);
  const xDrift  = useSharedValue(0);
  const rotate  = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    const easeIn = Easing.out(Easing.quad);

    y.value = withDelay(
      config.delay,
      withRepeat(
        withSequence(
          withTiming(H + 40, { duration: config.duration, easing: easeIn }),
          withTiming(-30, { duration: 0 })
        ),
        -1
      )
    );

    xDrift.value = withDelay(
      config.delay,
      withRepeat(
        withSequence(
          withTiming(config.drift * 0.5, { duration: config.duration * 0.35, easing: Easing.inOut(Easing.sin) }),
          withTiming(config.drift,       { duration: config.duration * 0.3,  easing: Easing.inOut(Easing.sin) }),
          withTiming(config.drift * 0.4, { duration: config.duration * 0.35, easing: Easing.inOut(Easing.sin) })
        ),
        -1
      )
    );

    rotate.value = withDelay(
      config.delay,
      withRepeat(
        withTiming(360, { duration: config.duration * 1.2, easing: Easing.linear }),
        -1
      )
    );

    opacity.value = withDelay(
      config.delay,
      withRepeat(
        withSequence(
          withTiming(config.opacity, { duration: 600 }),
          withTiming(config.opacity, { duration: config.duration - 1200 }),
          withTiming(0,              { duration: 600 })
        ),
        -1
      )
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: y.value },
      { translateX: xDrift.value },
      { rotate: `${rotate.value}deg` },
    ],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[styles.leaf, { left: config.x }, style]}
      pointerEvents="none"
    >
      <PetalSvg size={config.size} color={config.color} />
    </Animated.View>
  );
}

export default function FallingLeaves() {
  return (
    <Animated.View style={styles.container} pointerEvents="none">
      {LEAVES.map((cfg, i) => (
        <Leaf key={i} config={cfg} />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
  },
  leaf: {
    position: 'absolute',
    top: 0,
  },
});
