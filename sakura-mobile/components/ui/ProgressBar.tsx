import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Colors, Radius } from '@/constants/theme';

interface ProgressBarProps {
  progress: number; // 0-1
  color?: string;
  height?: number;
}

export default function ProgressBar({ progress, color = Colors.primary, height = 4 }: ProgressBarProps) {
  const width = useSharedValue(0);

  useEffect(() => {
    width.value = withTiming(progress, {
      duration: 600,
      easing: Easing.out(Easing.cubic),
    });
  }, [progress]);

  const animStyle = useAnimatedStyle(() => ({
    width: `${width.value * 100}%`,
  }));

  return (
    <View style={[styles.track, { height }]}>
      <Animated.View style={[styles.fill, animStyle, { backgroundColor: color, height }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    backgroundColor: '#E5E5EA',
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  fill: {
    borderRadius: Radius.full,
  },
});
