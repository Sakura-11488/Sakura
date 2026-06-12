import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Svg, { Text as SvgText, Defs, LinearGradient, Stop, Path } from 'react-native-svg';
import { Spacing, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

interface Props {
  title: string;
  onSeeAll?: () => void;
  chineseLabel?: string;
  centered?: boolean;
}

function GradientChineseText({ label }: { label: string }) {
  const charW = 38;
  const svgW = label.length * charW + 24;
  return (
    <Svg width={svgW} height={42}>
      <Defs>
        <LinearGradient id="cg" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#FF6B8A" stopOpacity="1" />
          <Stop offset="0.45" stopColor="#E84545" stopOpacity="1" />
          <Stop offset="1" stopColor="#FF9500" stopOpacity="1" />
        </LinearGradient>
      </Defs>
      <SvgText
        fill="url(#cg)"
        fontSize="28"
        fontWeight="bold"
        x={svgW / 2}
        y="34"
        textAnchor="middle"
      >
        {label}
      </SvgText>
    </Svg>
  );
}

function CaretRight({ color }: { color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path d="M9 6l6 6-6 6" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function SectionHeader({ title, onSeeAll, chineseLabel, centered }: Props) {
  const { colors } = useTheme();

  const s = useMemo(() => StyleSheet.create({
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Spacing.md,
      marginBottom: 12,
    },
    title: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: 15,
      color: colors.text,
      letterSpacing: 0.5,
    },
    centeredBlock: {
      alignItems: 'center',
      paddingHorizontal: Spacing.md,
      marginTop: 6,
      marginBottom: 10,
      gap: 2,
    },
    centeredRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    centeredTitle: {
      fontFamily: Fonts.bodyBold,
      fontSize: FontSize.md,
      color: colors.textSecondary,
      letterSpacing: 0.2,
    },
    seeAllBtn: { marginLeft: 4 },
    seeAllIconWrap: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
  }), [colors]);

  if (chineseLabel || centered) {
    return (
      <View style={s.centeredBlock}>
        {chineseLabel && <GradientChineseText label={chineseLabel} />}
        <View style={s.centeredRow}>
          <Text style={s.centeredTitle}>{title}</Text>
          {onSeeAll && (
            <TouchableOpacity onPress={onSeeAll} activeOpacity={0.7} style={s.seeAllBtn}>
              <View style={s.seeAllIconWrap}>
                <CaretRight color={colors.primary} />
              </View>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={s.row}>
      <Text style={s.title}>{title.toUpperCase()}</Text>
      {onSeeAll && (
        <TouchableOpacity onPress={onSeeAll} activeOpacity={0.7}>
          <View style={s.seeAllIconWrap}>
            <CaretRight color={colors.primary} />
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
}
