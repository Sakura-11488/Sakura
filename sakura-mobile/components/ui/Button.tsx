import React from 'react';
import { Text, StyleSheet, TouchableOpacity, ActivityIndicator, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { Colors, Radius, FontSize, FontWeight } from '@/constants/theme';

interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'outline' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  icon?: React.ReactNode;
}

export default function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  style,
  icon,
}: ButtonProps) {
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.96, { damping: 15 });
  };
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 12 });
  };

  return (
    <Animated.View style={[animStyle, style]}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled || loading}
        activeOpacity={0.9}
        style={[
          styles.base,
          variant === 'primary' && styles.primary,
          variant === 'outline' && styles.outline,
          variant === 'ghost' && styles.ghost,
          (disabled || loading) && styles.disabled,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={variant === 'primary' ? Colors.white : Colors.primary} size="small" />
        ) : (
          <>
            {icon}
            <Text
              style={[
                styles.label,
                variant === 'primary' && styles.labelPrimary,
                variant === 'outline' && styles.labelOutline,
                variant === 'ghost' && styles.labelGhost,
              ]}
            >
              {label}
            </Text>
          </>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: Radius.full,
    gap: 8,
  },
  primary: {
    backgroundColor: Colors.primary,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    letterSpacing: 0.2,
  },
  labelPrimary: {
    color: Colors.white,
  },
  labelOutline: {
    color: Colors.primary,
  },
  labelGhost: {
    color: Colors.textSecondary,
  },
});
