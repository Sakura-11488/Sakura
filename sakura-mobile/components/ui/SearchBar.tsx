import React, { useMemo } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Line } from 'react-native-svg';
import { Radius, Spacing, Shadow, FontSize } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const SearchIcon = ({ focused, color }: { focused: boolean; color: string }) => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
    <Circle cx="11" cy="11" r="7" stroke={focused ? '#E84545' : color} strokeWidth={2} />
    <Line x1="16.5" y1="16.5" x2="22" y2="22" stroke={focused ? '#E84545' : color} strokeWidth={2.2} strokeLinecap="round" />
  </Svg>
);

interface Props {
  value?: string;
  onChangeText?: (t: string) => void;
  placeholder?: string;
  onSearchPress?: () => void;
  onFocus?: () => void;
  autoFocus?: boolean;
}

export default function SearchBar({ onSearchPress, onFocus, ...props }: Props) {
  const { colors } = useTheme();
  const focused = useSharedValue(false);

  const containerStyle = useAnimatedStyle(() => ({
    borderWidth: 1.8,
    borderColor: withTiming(focused.value ? '#E84545' : 'transparent', { duration: 200 }),
    transform: Platform.OS === 'web'
      ? []
      : [{ scale: withSpring(focused.value ? 1.012 : 1, { damping: 18, stiffness: 220 }) }],
  }));

  const iconScale = useAnimatedStyle(() => ({
    transform: [{ scale: withSpring(focused.value ? 1.15 : 1, { damping: 14 }) }],
  }));

  const s = useMemo(() => StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.white,
      borderRadius: Radius.full,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === 'ios' ? 9 : 7,
      ...Shadow.sm,
    },
    input: {
      flex: 1,
      fontSize: Platform.OS === 'web' ? 16 : FontSize.sm,
      color: colors.text,
    },
    iconBtn: { padding: 3 },
  }), [colors]);

  return (
    <Animated.View style={[s.container, containerStyle]}>
      <TextInput
        style={s.input}
        placeholderTextColor={colors.textTertiary}
        onFocus={() => {
          focused.value = true;
          onFocus?.();
        }}
        onBlur={() => { focused.value = false; }}
        returnKeyType="search"
        {...props}
      />
      <Animated.View style={iconScale}>
        <TouchableOpacity onPress={onSearchPress} style={s.iconBtn} activeOpacity={0.7}>
          <SearchIcon focused={false} color={colors.textTertiary} />
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}
