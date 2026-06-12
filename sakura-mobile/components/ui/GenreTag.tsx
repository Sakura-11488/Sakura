import React, { useMemo } from 'react';
import { Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

interface GenreTagProps {
  label: string;
  onPress?: () => void;
  variant?: 'outline' | 'filled';
}

export default function GenreTag({ label, onPress, variant = 'outline' }: GenreTagProps) {
  const { colors } = useTheme();

  const styles = useMemo(() => StyleSheet.create({
    tag: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    tagFilled: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    text: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.medium,
      color: colors.textSecondary,
    },
    textFilled: {
      color: '#fff',
    },
  }), [colors]);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
      style={[styles.tag, variant === 'filled' && styles.tagFilled]}
    >
      <Text style={[styles.text, variant === 'filled' && styles.textFilled]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}
