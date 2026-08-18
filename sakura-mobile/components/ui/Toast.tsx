import React, { useEffect } from 'react';
import { Text, StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts } from '@/constants/theme';

interface ToastProps {
  message: string;
  visible: boolean;
  onHide: () => void;
  bottomOffset?: number;
  /** How long the message stays up. Defaults to the 2s tap-acknowledgement. */
  durationMs?: number;
}

export function Toast({ message, visible, onHide, bottomOffset, durationMs }: ToastProps) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(10);
  const insets = useSafeAreaInsets();
  const bottom = bottomOffset !== undefined ? bottomOffset : insets.bottom + 96;

  useEffect(() => {
    if (!visible) return;
    opacity.value = withTiming(1, { duration: 200 });
    translateY.value = withTiming(0, { duration: 200 });
    const t = setTimeout(() => {
      opacity.value = withTiming(0, { duration: 180 });
      translateY.value = withTiming(10, { duration: 180 });
      onHide();
      // A download result needs longer than a tap acknowledgement: it can
      // carry a partial-failure count the user has to actually read.
    }, durationMs ?? 2000);
    return () => clearTimeout(t);
  }, [visible, durationMs]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View style={[ts.wrap, { bottom }, style]} pointerEvents="none">
      <Text style={ts.text}>{message}</Text>
    </Animated.View>
  );
}

const ts = StyleSheet.create({
  wrap: {
    position: 'absolute',
    alignSelf: 'center',
    left: 24,
    right: 24,
    backgroundColor: 'rgba(28,28,30,0.93)',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 22,
    alignItems: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 14,
    fontFamily: Fonts.bodyMedium,
    textAlign: 'center',
  },
});
