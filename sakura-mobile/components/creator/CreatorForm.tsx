import React from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, type TextInputProps } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path, Circle } from 'react-native-svg';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import type { AppColors } from '@/lib/theme';
import type { CreatorWorkKind } from '@/lib/creator';

export function CreatorScreenHeader({
  title,
  subtitle,
  onBack,
  colors,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  colors: AppColors;
}) {
  return (
    <View style={[hdr.wrap, { borderBottomColor: colors.borderLight }]}>
      <TouchableOpacity onPress={onBack} style={hdr.back} activeOpacity={0.7} hitSlop={8}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
          <Path d="M15 18l-6-6 6-6" stroke={colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </TouchableOpacity>
      <View style={hdr.textCol}>
        <Text style={[hdr.title, { color: colors.text }]}>{title}</Text>
        {subtitle ? <Text style={[hdr.sub, { color: colors.textSecondary }]}>{subtitle}</Text> : null}
      </View>
      <View style={hdr.spacer} />
    </View>
  );
}

export function StepIndicator({ step, colors }: { step: 1 | 2 | 3; colors: AppColors }) {
  const labels = ['Type', 'Details', 'Release'];
  return (
    <View style={stepStyles.wrap}>
      {labels.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <View key={label} style={stepStyles.item}>
            <View
              style={[
                stepStyles.dot,
                {
                  backgroundColor: active || done ? colors.primary : colors.surfaceSecondary,
                  borderColor: active ? colors.primary : colors.border,
                },
              ]}
            >
              {done ? (
                <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
                  <Path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                </Svg>
              ) : (
                <Text style={[stepStyles.dotText, { color: active ? '#fff' : colors.textTertiary }]}>{n}</Text>
              )}
            </View>
            <Text style={[stepStyles.label, { color: active ? colors.primary : colors.textTertiary }]}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const KIND_META: Record<CreatorWorkKind, { label: string; hint: string }> = {
  novel: { label: 'Novel', hint: 'Long-form chapters with rich text' },
  manga: { label: 'Manga', hint: 'Illustrated chapters & page art' },
  anime: { label: 'Anime', hint: 'Episodes, trailers & video releases' },
};

function KindIcon({ kind, color }: { kind: CreatorWorkKind; color: string }) {
  if (kind === 'novel') {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
        <Path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke={color} strokeWidth={2} strokeLinecap="round" />
        <Path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke={color} strokeWidth={2} />
      </Svg>
    );
  }
  if (kind === 'manga') {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
        <Path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      </Svg>
    );
  }
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} />
      <Path d="M10 8l6 4-6 4V8z" fill={color} />
    </Svg>
  );
}

export function KindSelector({
  value,
  onChange,
  colors,
}: {
  value: CreatorWorkKind;
  onChange: (k: CreatorWorkKind) => void;
  colors: AppColors;
}) {
  return (
    <View style={kindStyles.list}>
      {(Object.keys(KIND_META) as CreatorWorkKind[]).map((key) => {
        const meta = KIND_META[key];
        const selected = value === key;
        const accent = colors.primary;
        return (
          <TouchableOpacity
            key={key}
            style={[
              kindStyles.card,
              {
                backgroundColor: selected ? `${accent}10` : colors.surface,
                borderColor: selected ? accent : colors.borderLight,
              },
            ]}
            onPress={() => onChange(key)}
            activeOpacity={0.85}
          >
            <View style={[kindStyles.iconWrap, { backgroundColor: `${accent}18` }]}>
              <KindIcon kind={key} color={selected ? accent : colors.textSecondary} />
            </View>
            <View style={kindStyles.textCol}>
              <Text style={[kindStyles.label, { color: selected ? accent : colors.text }]}>{meta.label}</Text>
              <Text style={[kindStyles.hint, { color: colors.textSecondary }]}>{meta.hint}</Text>
            </View>
            <View
              style={[
                kindStyles.radio,
                {
                  borderColor: selected ? accent : colors.border,
                  backgroundColor: selected ? accent : 'transparent',
                },
              ]}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function FormSection({
  title,
  subtitle,
  children,
  colors,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  colors: AppColors;
}) {
  return (
    <View style={[section.wrap, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <Text style={[section.title, { color: colors.text }]}>{title}</Text>
      {subtitle ? <Text style={[section.sub, { color: colors.textSecondary }]}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

export function FormField({
  label,
  hint,
  colors,
  inputStyle,
  ...props
}: {
  label: string;
  hint?: string;
  colors: AppColors;
  inputStyle?: object;
} & TextInputProps) {
  return (
    <View style={field.wrap}>
      <Text style={[field.label, { color: colors.text }]}>{label}</Text>
      {hint ? <Text style={[field.hint, { color: colors.textTertiary }]}>{hint}</Text> : null}
      <TextInput
        {...props}
        placeholderTextColor={colors.textTertiary}
        style={[
          field.input,
          {
            backgroundColor: colors.surfaceSecondary,
            borderColor: colors.border,
            color: colors.text,
          },
          inputStyle,
        ]}
      />
    </View>
  );
}

export function CoverPicker({
  uri,
  onPress,
  colors,
}: {
  uri: string | null;
  onPress: () => void;
  colors: AppColors;
}) {
  return (
    <TouchableOpacity
      style={[cover.wrap, { borderColor: uri ? colors.primary : colors.border, backgroundColor: colors.surfaceSecondary }]}
      onPress={onPress}
      activeOpacity={0.9}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />
      ) : (
        <>
          <View style={[cover.iconCircle, { backgroundColor: `${colors.primary}14` }]}>
            <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
              <Path d="M12 16V8M8 12h8" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" />
              <Path
                d="M3 16.8V7.2a2 2 0 0 1 1.2-1.8l7.2-3.6a2 2 0 0 1 1.8 0l7.2 3.6A2 2 0 0 1 21 7.2v9.6a2 2 0 0 1-1.2 1.8l-7.2 3.6a2 2 0 0 1-1.8 0l-7.2-3.6A2 2 0 0 1 3 16.8z"
                stroke={colors.primary}
                strokeWidth={1.5}
              />
            </Svg>
          </View>
          <Text style={[cover.title, { color: colors.text }]}>Add cover art</Text>
          <Text style={[cover.sub, { color: colors.textSecondary }]}>2:3 ratio recommended · JPG or PNG</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const hdr = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1, alignItems: 'center' },
  title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: FontSize.lg },
  sub: { fontSize: FontSize.xs, marginTop: 2 },
  spacer: { width: 40 },
});

const stepStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  item: { alignItems: 'center', flex: 1 },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    marginBottom: 6,
  },
  dotText: { fontSize: 12, fontWeight: FontWeight.bold },
  label: { fontSize: 11, fontWeight: FontWeight.semibold },
});

const kindStyles = StyleSheet.create({
  list: { gap: Spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    gap: Spacing.md,
  },
  iconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1 },
  label: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  hint: { fontSize: FontSize.xs, marginTop: 2, lineHeight: 16 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2 },
});

const section = StyleSheet.create({
  wrap: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    ...Shadow.sm,
  },
  title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginBottom: 4 },
  sub: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.md },
});

const field = StyleSheet.create({
  wrap: { marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, marginBottom: 4 },
  hint: { fontSize: FontSize.xs, marginBottom: 6 },
  input: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.md,
    paddingVertical: 13,
    fontSize: FontSize.md,
  },
});

const cover = StyleSheet.create({
  wrap: {
    height: 220,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  filled: { ...StyleSheet.absoluteFillObject },
  iconCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  title: { fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  sub: { fontSize: FontSize.xs, marginTop: 4 },
});

export { KIND_META };
