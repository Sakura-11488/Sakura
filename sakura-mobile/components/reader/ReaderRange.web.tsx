import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import type { ReaderRangeProps } from './ReaderRange';

const ACCENT = '#E84545';

/** Web: a native range input (keyboard arrows, screen readers, fine drags). */
export default function ReaderRange({ value, min, max, step, onChange, format, accessibilityLabel }: ReaderRangeProps) {
  const { colors } = useTheme();
  return (
    <View style={s.row}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={accessibilityLabel}
        aria-valuetext={format(value)}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && next !== value) onChange(next);
        }}
        style={{ flex: 1, minWidth: 0, accentColor: ACCENT, cursor: 'pointer' }}
      />
      <Text style={[s.value, { color: colors.text }]}>{format(value)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  value: { minWidth: 72, textAlign: 'right', fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
