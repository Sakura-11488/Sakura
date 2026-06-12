import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontSize, FontWeight, Radius, Spacing, Fonts } from '@/constants/theme';

type Props = {
  chapterLabel: string;
  detail?: string;
  progress: number;
  colors: {
    text: string;
    textSecondary: string;
    primary: string;
    border: string;
    surfaceSecondary: string;
  };
};

export default function ResumeReadingHint({ chapterLabel, detail, progress, colors }: Props) {
  const pct = Math.round(progress * 100);
  return (
    <View
      style={[
        s.wrap,
        {
          backgroundColor: colors.surfaceSecondary,
          borderColor: colors.border,
        },
      ]}
    >
      <Text style={[s.label, { color: colors.textSecondary }]}>Continue from</Text>
      <Text style={[s.chapter, { color: colors.text }]} numberOfLines={1}>
        {chapterLabel}
      </Text>
      {detail ? (
        <Text style={[s.detail, { color: colors.textSecondary }]} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      <View style={[s.track, { backgroundColor: `${colors.primary}22` }]}>
        <View style={[s.fill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    width: '100%',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    marginBottom: 10,
    gap: 2,
  },
  label: {
    fontSize: 10,
    fontFamily: Fonts.body,
    fontWeight: FontWeight.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chapter: {
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyBold,
    fontWeight: FontWeight.bold,
  },
  detail: {
    fontSize: FontSize.xs,
    fontFamily: Fonts.body,
  },
  track: {
    height: 3,
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});
