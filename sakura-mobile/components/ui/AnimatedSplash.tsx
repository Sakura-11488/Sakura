import React, { useEffect, useState } from 'react';
import { StyleSheet, Dimensions, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import Svg, { Path, G } from 'react-native-svg';
import { useTheme } from '@/lib/theme';

const { width: W, height: H } = Dimensions.get('window');

function Petal({
  delay,
  startX,
  driftX,
  size,
  opacity: baseOpacity,
}: {
  delay: number;
  startX: number;
  driftX: number;
  size: number;
  opacity: number;
}) {
  const y = useSharedValue(-size * 2);
  const x = useSharedValue(startX);
  const rot = useSharedValue(0);
  const op = useSharedValue(0);

  useEffect(() => {
    op.value = withDelay(delay, withTiming(baseOpacity, { duration: 400 }));
    y.value = withDelay(
      delay,
      withTiming(H + 40, { duration: 4200, easing: Easing.out(Easing.sin) })
    );
    x.value = withDelay(
      delay,
      withTiming(startX + driftX, { duration: 4200, easing: Easing.inOut(Easing.sin) })
    );
    rot.value = withDelay(
      delay,
      withTiming(540 + Math.random() * 360, { duration: 4200 })
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: op.value,
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: `${rot.value}deg` },
    ],
  }));

  return (
    <Animated.View style={style}>
      <Svg width={size} height={size * 1.3} viewBox="0 0 20 26">
        <G>
          <Path
            d="M10 0 C16 4 18 12 10 26 C2 12 4 4 10 0Z"
            fill="rgba(232,80,130,0.75)"
          />
          <Path
            d="M10 2 C10 8 10 16 10 24"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={1}
          />
        </G>
      </Svg>
    </Animated.View>
  );
}

interface Props {
  onFinish: () => void;
}

export default function AnimatedSplash({ onFinish }: Props) {
  const { colors } = useTheme();
  const [blockTouches, setBlockTouches] = useState(true);

  const logoY = useSharedValue(22);
  const logoScale = useSharedValue(0.92);
  const logoOpacity = useSharedValue(0);
  const exitOpacity = useSharedValue(1);
  const exitScale = useSharedValue(1);

  useEffect(() => {
    // Safety fallback in case the exit-animation callback never fires; kept just
    // past the animated exit (~2.15s) so it doesn't cut the splash short.
    const t = setTimeout(onFinish, 2800);
    return () => clearTimeout(t);
  }, [onFinish]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      setBlockTouches(false);
      return;
    }
    const unlock = setTimeout(() => setBlockTouches(false), 1800);
    return () => clearTimeout(unlock);
  }, []);

  useEffect(() => {
    logoOpacity.value = withDelay(120, withTiming(1, { duration: 380, easing: Easing.out(Easing.cubic) }));
    logoY.value = withDelay(120, withTiming(0, { duration: 420, easing: Easing.out(Easing.cubic) }));
    logoScale.value = withDelay(
      120,
      withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) })
    );

    exitOpacity.value = withDelay(1500, withTiming(0, { duration: 650 }, (done) => {
      if (done) runOnJS(onFinish)();
    }));
    exitScale.value = withDelay(
      1500,
      withTiming(1.08, { duration: 650, easing: Easing.in(Easing.quad) })
    );
  }, [onFinish]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ translateY: logoY.value }, { scale: logoScale.value }],
  }));

  const containerStyle = useAnimatedStyle(() => ({
    opacity: exitOpacity.value,
    transform: [{ scale: exitScale.value }],
  }));

  const PETALS = [
    { delay: 600,  startX: W * 0.12, driftX:  55, size: 14, opacity: 0.7 },
    { delay: 850,  startX: W * 0.35, driftX: -40, size: 11, opacity: 0.55 },
    { delay: 400,  startX: W * 0.62, driftX:  48, size: 16, opacity: 0.65 },
    { delay: 1050, startX: W * 0.78, driftX: -30, size: 10, opacity: 0.5  },
    { delay: 750,  startX: W * 0.50, driftX:  35, size: 13, opacity: 0.6  },
    { delay: 950,  startX: W * 0.22, driftX: -50, size: 9,  opacity: 0.5  },
  ];

  return (
    <Animated.View
      pointerEvents={blockTouches ? 'auto' : 'none'}
      style={[StyleSheet.absoluteFill, s.container, { backgroundColor: colors.background }, containerStyle]}
    >
      {PETALS.map((p, i) => (
        <Petal key={i} {...p} />
      ))}

      <Animated.View style={logoStyle}>
        <Image
          source={require('@/assets/images/sakura-textlogo.png')}
          style={s.logo}
          contentFit="contain"
        />
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  logo: {
    width: W * 0.68,
    height: W * 0.27,
  },
});
