import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { FontSize, FontWeight, Radius } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

export interface ReaderRangeProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  accessibilityLabel: string;
}

/**
 * A stepped value control for the reader settings sheet (width, brightness).
 *
 * Native gets − / + steps: there is no slider in the dependency set, and a
 * hand-rolled gesture slider (ReaderChapterBar has one) inside a Modal fights
 * the modal's own touch handling. The web twin is a real range input, which
 * also gives keyboard and screen-reader support for free.
 */
export default function ReaderRange({ value, min, max, step, onChange, format, accessibilityLabel }: ReaderRangeProps) {
  const { colors } = useTheme();
  const nudge = (dir: -1 | 1) => {
    const next = Math.min(max, Math.max(min, Math.round((value + dir * step) / step) * step));
    if (next !== value) onChange(next);
  };
  return (
    <View style={s.row} accessibilityLabel={accessibilityLabel}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${accessibilityLabel}`}
        style={[s.step, { backgroundColor: colors.surfaceSecondary }, value <= min && s.off]}
        disabled={value <= min}
        onPress={() => nudge(-1)}
      >
        <Text style={[s.stepText, { color: colors.text }]}>−</Text>
      </TouchableOpacity>
      <Text style={[s.value, { color: colors.text }]}>{format(value)}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Increase ${accessibilityLabel}`}
        style={[s.step, { backgroundColor: colors.surfaceSecondary }, value >= max && s.off]}
        disabled={value >= max}
        onPress={() => nudge(1)}
      >
        <Text style={[s.stepText, { color: colors.text }]}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  step: { width: 40, height: 36, borderRadius: Radius.full, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 20, fontWeight: FontWeight.semibold },
  value: { flex: 1, textAlign: 'center', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  off: { opacity: 0.4 },
});
