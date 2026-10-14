import React from 'react';
import { View, Text, StyleSheet, Modal, Pressable, TouchableOpacity, Switch, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  NOVEL_READER_DEFAULTS,
  NOVEL_READER_PALETTES,
  novelFontFamily,
  type NovelReaderPalette,
  type NovelReaderPrefs,
} from '@/lib/novel-reader-prefs';

/** react-native-web paints the active thumb teal unless told otherwise; native has no such prop. */
const WEB_SWITCH = (Platform.OS === 'web' ? { activeThumbColor: '#ffffff' } : {}) as object;

export interface NovelReaderSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  prefs: NovelReaderPrefs;
  /** Resolved tap-zone default for this device, shown when the pref is "auto". */
  tapZonesDefault: boolean;
  palette: NovelReaderPalette;
  appIsDark: boolean;
  onChange: (patch: Partial<NovelReaderPrefs>) => void;
  /** Closes the sheet and starts hands-free scrolling. */
  onStartAutoScroll: () => void;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  palette,
  label,
}: {
  options: { value: T; label: string; fontFamily?: string }[];
  value: T;
  onChange: (v: T) => void;
  palette: NovelReaderPalette;
  label: string;
}) {
  return (
    <View style={[s.segmented, { backgroundColor: palette.card }]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            accessibilityLabel={`${label}: ${opt.label}`}
            style={[s.segment, active && { backgroundColor: palette.accent }]}
            activeOpacity={0.85}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[s.segmentText, { color: active ? palette.bg : palette.text }, opt.fontFamily ? { fontFamily: opt.fontFamily } : null]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Stepper({
  label,
  value,
  display,
  onDecrease,
  onIncrease,
  canDecrease,
  canIncrease,
  palette,
  smallGlyph,
  bigGlyph,
}: {
  label: string;
  value: string | number;
  display: string;
  onDecrease: () => void;
  onIncrease: () => void;
  canDecrease: boolean;
  canIncrease: boolean;
  palette: NovelReaderPalette;
  smallGlyph: string;
  bigGlyph: string;
}) {
  return (
    // Not role "adjustable": react-native-web renders that as an ARIA slider,
    // whose children are presentational, so screen readers lost the two
    // buttons and the slider itself did not respond to arrow keys. The value
    // is announced on its own instead, and politely when it changes.
    <View style={[s.stepper, { backgroundColor: palette.card }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${label.toLowerCase()}`}
        disabled={!canDecrease}
        onPress={onDecrease}
        style={[s.stepBtn, !canDecrease && s.dim]}
      >
        <Text style={[s.stepGlyph, { color: palette.text, fontSize: 15 }]}>{smallGlyph}</Text>
      </TouchableOpacity>
      <Text style={[s.stepValue, { color: palette.text }]} accessibilityLabel={`${label} ${value}`} accessibilityLiveRegion="polite">{display}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Increase ${label.toLowerCase()}`}
        disabled={!canIncrease}
        onPress={onIncrease}
        style={[s.stepBtn, !canIncrease && s.dim]}
      >
        <Text style={[s.stepGlyph, { color: palette.text, fontSize: 21 }]}>{bigGlyph}</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * "Aa" — the reader's typography and theme sheet.
 *
 * Replaces two A-/A+ buttons and four theme chips that were forgotten on every
 * chapter. Everything applies live (the backdrop is light so the chapter stays
 * visible behind the sheet) and persists through lib/novel-reader-prefs.ts.
 */
export default function NovelReaderSettingsSheet({
  visible,
  onClose,
  prefs,
  tapZonesDefault,
  palette,
  appIsDark,
  onChange,
  onStartAutoScroll,
}: NovelReaderSettingsSheetProps) {
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === 'web';
  const themes: { id: NovelReaderPrefs['theme']; label: string; bg: string; text: string }[] = [
    {
      id: 'auto',
      label: 'Auto',
      bg: appIsDark ? NOVEL_READER_PALETTES.dark.bg : NOVEL_READER_PALETTES.light.bg,
      text: appIsDark ? NOVEL_READER_PALETTES.dark.text : NOVEL_READER_PALETTES.light.text,
    },
    ...(['light', 'sepia', 'dark', 'black'] as const).map((id) => ({
      id,
      label: NOVEL_READER_PALETTES[id].label,
      bg: NOVEL_READER_PALETTES[id].bg,
      text: NOVEL_READER_PALETTES[id].text,
    })),
  ];
  const tapZones = prefs.tapZones ?? tapZonesDefault;

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close text settings" />
        <View style={[s.sheet, { backgroundColor: palette.bg, borderColor: palette.rule, paddingBottom: insets.bottom + 16 }]}>
          <View style={[s.grabber, { backgroundColor: palette.rule }]} />
          <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
            <View style={s.titleRow}>
              <Text style={[s.title, { color: palette.text }]} accessibilityRole="header">Text & display</Text>
              <TouchableOpacity accessibilityRole="button" onPress={onClose} style={s.doneBtn}>
                <Text style={[s.doneText, { color: palette.accent }]}>Done</Text>
              </TouchableOpacity>
            </View>

            <Text style={[s.label, { color: palette.muted }]}>Theme</Text>
            <View style={s.themeRow} accessibilityRole="radiogroup" accessibilityLabel="Reading theme">
              {themes.map((t) => {
                const active = prefs.theme === t.id;
                return (
                  <TouchableOpacity
                    key={t.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={t.id === 'auto' ? 'Theme: follow app' : `Theme: ${t.label}`}
                    onPress={() => onChange({ theme: t.id })}
                    style={s.themeItem}
                    activeOpacity={0.85}
                  >
                    <View style={[s.swatch, { backgroundColor: t.bg, borderColor: active ? palette.accent : palette.rule, borderWidth: active ? 2 : 1 }]}>
                      <Text style={{ color: t.text, fontSize: 15, fontFamily: novelFontFamily('serif') }}>Aa</Text>
                    </View>
                    <Text style={[s.themeLabel, { color: active ? palette.accent : palette.muted }]}>{t.id === 'auto' ? 'Follow app' : t.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={s.twoCol}>
              <View style={s.col}>
                <Text style={[s.label, { color: palette.muted }]}>Size</Text>
                <Stepper
                  label="Text size"
                  value={prefs.fontSize}
                  display={`${prefs.fontSize}`}
                  canDecrease={prefs.fontSize > FONT_SIZE_RANGE.min}
                  canIncrease={prefs.fontSize < FONT_SIZE_RANGE.max}
                  onDecrease={() => onChange({ fontSize: prefs.fontSize - 1 })}
                  onIncrease={() => onChange({ fontSize: prefs.fontSize + 1 })}
                  palette={palette}
                  smallGlyph="A"
                  bigGlyph="A"
                />
              </View>
              <View style={s.col}>
                <Text style={[s.label, { color: palette.muted }]}>Line spacing</Text>
                <Stepper
                  label="Line spacing"
                  value={prefs.lineHeight.toFixed(1)}
                  display={prefs.lineHeight.toFixed(1)}
                  canDecrease={prefs.lineHeight > LINE_HEIGHT_RANGE.min + 0.001}
                  canIncrease={prefs.lineHeight < LINE_HEIGHT_RANGE.max - 0.001}
                  onDecrease={() => onChange({ lineHeight: Math.round((prefs.lineHeight - 0.1) * 10) / 10 })}
                  onIncrease={() => onChange({ lineHeight: Math.round((prefs.lineHeight + 0.1) * 10) / 10 })}
                  palette={palette}
                  smallGlyph="≡"
                  bigGlyph="☰"
                />
              </View>
            </View>

            <Text style={[s.label, { color: palette.muted }]}>Font</Text>
            <Segmented
              label="Font"
              palette={palette}
              value={prefs.font}
              onChange={(font) => onChange({ font })}
              options={[
                { value: 'serif', label: 'Serif', fontFamily: novelFontFamily('serif') },
                { value: 'sans', label: 'Sans', fontFamily: novelFontFamily('sans') },
                { value: 'system', label: 'System', fontFamily: novelFontFamily('system') },
              ]}
            />

            <Text style={[s.label, { color: palette.muted }]}>Margins</Text>
            <Segmented
              label="Margins"
              palette={palette}
              value={prefs.margin}
              onChange={(margin) => onChange({ margin })}
              options={[
                { value: 'narrow', label: 'Narrow' },
                { value: 'normal', label: 'Normal' },
                { value: 'wide', label: 'Wide' },
              ]}
            />

            <Text style={[s.label, { color: palette.muted }]}>Alignment</Text>
            <Segmented
              label="Alignment"
              palette={palette}
              value={prefs.justify ? 'justify' : 'left'}
              onChange={(v) => onChange({ justify: v === 'justify' })}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'justify', label: 'Justified' },
              ]}
            />

            <View style={[s.row, { borderTopColor: palette.rule }]}>
              <View style={s.rowText}>
                <Text style={[s.rowTitle, { color: palette.text }]}>Auto-scroll</Text>
                <Text style={[s.rowSub, { color: palette.muted }]}>Hands-free reading at your pace. Tap the page to pause.</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Start auto-scroll"
                onPress={onStartAutoScroll}
                style={[s.startBtn, { borderColor: palette.accent }]}
              >
                <Text style={[s.startText, { color: palette.accent }]}>Start</Text>
              </TouchableOpacity>
            </View>

            <View style={[s.row, { borderTopColor: palette.rule, marginTop: 0 }]}>
              <View style={s.rowText}>
                <Text style={[s.rowTitle, { color: palette.text }]}>Tap edges to turn pages</Text>
                <Text style={[s.rowSub, { color: palette.muted }]}>Left or right edge scrolls one screen; the middle shows the controls.</Text>
              </View>
              <Switch
                accessibilityLabel="Tap edges to turn pages"
                value={tapZones}
                onValueChange={(value) => onChange({ tapZones: value })}
                trackColor={{ true: palette.accent, false: palette.rule }}
                thumbColor="#ffffff"
                {...WEB_SWITCH}
              />
            </View>
            {isWeb ? (
              <View style={[s.row, { borderTopColor: palette.rule, marginTop: 0 }]}>
                <View style={s.rowText}>
                  <Text style={[s.rowTitle, { color: palette.text }]}>Keep screen on</Text>
                  <Text style={[s.rowSub, { color: palette.muted }]}>Stops the screen dimming while you read (released after 10 idle minutes).</Text>
                </View>
                <Switch
                  accessibilityLabel="Keep screen on while reading"
                  value={prefs.keepAwake}
                  onValueChange={(keepAwake) => onChange({ keepAwake })}
                  trackColor={{ true: palette.accent, false: palette.rule }}
                  thumbColor="#ffffff"
                  {...WEB_SWITCH}
                />
              </View>
            ) : null}

            <TouchableOpacity
              accessibilityRole="button"
              // Typography only: behaviour settings and the learned reading speed are kept.
              onPress={() => onChange({ ...NOVEL_READER_DEFAULTS, keepAwake: prefs.keepAwake, tapZones: prefs.tapZones, wpm: prefs.wpm, ttsRate: prefs.ttsRate, autoScrollSpeed: prefs.autoScrollSpeed })}
              style={s.reset}
            >
              <Text style={[s.resetText, { color: palette.muted }]}>Reset text settings</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.18)' },
  sheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '82%',
    alignSelf: 'center',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  title: { fontSize: 18, fontWeight: '700' },
  doneBtn: { paddingVertical: 10, paddingLeft: 16 },
  doneText: { fontSize: 15, fontWeight: '700' },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, marginTop: 14, marginBottom: 8 },
  themeRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  themeItem: { alignItems: 'center', flex: 1, gap: 6 },
  swatch: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  themeLabel: { fontSize: 11, fontWeight: '600' },
  twoCol: { flexDirection: 'row', gap: 12 },
  col: { flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, height: 46 },
  stepBtn: { width: 52, height: 46, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { fontWeight: '600' },
  stepValue: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '700' },
  dim: { opacity: 0.35 },
  segmented: { flexDirection: 'row', borderRadius: 14, padding: 4 },
  segment: { flex: 1, minHeight: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segmentText: { fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 14 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2, lineHeight: 17 },
  startBtn: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 18, height: 36, justifyContent: 'center' },
  startText: { fontSize: 14, fontWeight: '700' },
  reset: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 12 },
  resetText: { fontSize: 13, fontWeight: '600' },
});
