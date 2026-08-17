import React from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TouchableOpacity, Switch } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const ACCENT = '#E84545';

export interface ReaderSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  readingMode: 'page' | 'scroll';
  onChangeReadingMode: (mode: 'page' | 'scroll') => void;
  readDirection: 'ltr' | 'rtl';
  onChangeReadDirection: (direction: 'ltr' | 'rtl') => void;
  continuous: boolean;
  onChangeContinuous: (value: boolean) => void;
  continuousBack: boolean;
  onChangeContinuousBack: (value: boolean) => void;
  /** Opens the Ask Sakura sheet. Omitted on adult sources, which hides the row. */
  onAskSakura?: () => void;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        s.segmented,
        { backgroundColor: colors.surfaceSecondary },
        disabled && s.dimmed,
      ]}
      pointerEvents={disabled ? 'none' : 'auto'}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[s.segment, active && { backgroundColor: ACCENT }]}
            activeOpacity={0.85}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[s.segmentText, { color: active ? '#fff' : colors.textSecondary }]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/**
 * In-reader display settings.
 *
 * Replaces a single pill that showed one word and left it ambiguous whether it
 * named the current mode or the one you'd get by tapping. It also had no
 * direction control at all, despite right-to-left mattering most to exactly the
 * readers who need it.
 */
export default function ReaderSettingsSheet({
  visible,
  onClose,
  readingMode,
  onChangeReadingMode,
  readDirection,
  onChangeReadDirection,
  continuous,
  onChangeContinuous,
  continuousBack,
  onChangeContinuousBack,
  onAskSakura,
}: ReaderSettingsSheetProps) {
  const { colors } = useTheme();

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Animated.View
          entering={FadeInDown.duration(200)}
          style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
        >
          <Text style={[s.title, { color: colors.text }]}>Reading</Text>

          {/* Second entry point: the overlay button is easy to miss, and this is
              where people already come looking for reader controls. */}
          {onAskSakura ? (
            <TouchableOpacity
              style={[s.askRow, { borderColor: colors.borderLight }]}
              activeOpacity={0.85}
              onPress={onAskSakura}
            >
              <View style={s.rowText}>
                <Text style={[s.rowTitle, { color: colors.text }]}>Ask Sakura</Text>
                <Text style={[s.rowSub, { color: colors.textSecondary }]}>
                  Questions about this chapter, without losing your place.
                </Text>
              </View>
              <Text style={[s.askChevron, { color: ACCENT }]}>›</Text>
            </TouchableOpacity>
          ) : null}

          <Text style={[s.label, { color: colors.textSecondary }]}>Layout</Text>
          <Segmented
            options={[
              { value: 'scroll', label: 'Webtoon' },
              { value: 'page', label: 'Paged' },
            ]}
            value={readingMode}
            onChange={onChangeReadingMode}
          />

          <Text style={[s.label, { color: colors.textSecondary }]}>Direction</Text>
          <Segmented
            options={[
              { value: 'ltr', label: 'L → R' },
              { value: 'rtl', label: 'R → L' },
            ]}
            value={readDirection}
            onChange={onChangeReadDirection}
            // Webtoon scrolls vertically, so direction has nothing to act on.
            disabled={readingMode !== 'page'}
          />
          {readingMode !== 'page' ? (
            <Text style={[s.hint, { color: colors.textSecondary }]}>
              Direction applies to paged reading.
            </Text>
          ) : null}

          <View style={[s.row, { borderTopColor: colors.borderLight }]}>
            <View style={s.rowText}>
              <Text style={[s.rowTitle, { color: colors.text }]}>Continuous chapters</Text>
              <Text style={[s.rowSub, { color: colors.textSecondary }]}>
                Keep reading into the next chapter without leaving the page.
              </Text>
            </View>
            <Switch value={continuous} onValueChange={onChangeContinuous} />
          </View>

          <View style={[s.row, { borderTopColor: colors.borderLight }]}>
            <View style={s.rowText}>
              <Text style={[s.rowTitle, { color: colors.text }]}>Scroll back too</Text>
              <Text style={[s.rowSub, { color: colors.textSecondary }]}>
                Also flow into the previous chapter. Turn off if scrolling up ever jumps.
              </Text>
            </View>
            <Switch
              value={continuous && continuousBack}
              onValueChange={onChangeContinuousBack}
              disabled={!continuous}
            />
          </View>

          <TouchableOpacity style={s.done} activeOpacity={0.85} onPress={onClose}>
            <Text style={s.doneText}>Done</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: { width: '100%', maxWidth: 420, borderRadius: 28, borderWidth: 1, padding: 22 },
  title: {
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
    fontSize: 20,
    marginBottom: 16,
  },
  label: {
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    marginBottom: 8,
    marginTop: 4,
  },
  segmented: { flexDirection: 'row', borderRadius: Radius.full, padding: 4, marginBottom: 12 },
  segment: { flex: 1, paddingVertical: 9, borderRadius: Radius.full, alignItems: 'center' },
  segmentText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  dimmed: { opacity: 0.45 },
  askRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: Radius.lg,
    marginBottom: 16,
  },
  askChevron: { fontSize: 24, fontWeight: FontWeight.semibold },
  hint: { fontSize: FontSize.xs, marginTop: -6, marginBottom: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderTopWidth: 1,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.xs, marginTop: 2, lineHeight: 16 },
  done: {
    backgroundColor: ACCENT,
    borderRadius: Radius.full,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 16,
  },
  doneText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
  },
});
