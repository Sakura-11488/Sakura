import React, { useMemo } from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import LottieView from 'lottie-react-native';
import { Fonts, FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

type Props = {
  title: string;
  subtitle?: string;
  style?: StyleProp<ViewStyle>;
  /** Smaller animation for inline list empty states. */
  compact?: boolean;
  /** Light text for dark backgrounds (e.g. manga reader). */
  inverted?: boolean;
};

export default function EmptyState({ title, subtitle, style, compact, inverted }: Props) {
  const { colors } = useTheme();
  const lottieSize = compact ? 120 : 180;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: Spacing.lg,
          gap: 8,
        },
        lottie: {
          width: lottieSize,
          height: lottieSize,
          marginBottom: 4,
        },
        title: {
          fontSize: compact ? FontSize.md : FontSize.lg,
          fontFamily: Fonts.bodyBold,
          fontWeight: '700',
          color: inverted ? '#fff' : colors.text,
          textAlign: 'center',
        },
        subtitle: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: inverted ? 'rgba(255,255,255,0.72)' : colors.textSecondary,
          textAlign: 'center',
          lineHeight: 20,
          maxWidth: 320,
        },
      }),
    [colors, compact, inverted, lottieSize],
  );

  return (
    <View style={[styles.wrap, style]}>
      <LottieView
        source={require('@/assets/lottie/empty.json')}
        style={styles.lottie}
        autoPlay
        loop
        speed={0.85}
      />
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}
