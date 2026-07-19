import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView, TouchableOpacity } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';

const ACCENT = '#E84545';

export type InstallFlavor = 'ios' | 'android' | 'desktop';

const STEPS: Record<InstallFlavor, { title: string; steps: string[]; tip?: string }> = {
  ios: {
    title: 'Add Sakura to your Home Screen',
    steps: [
      'Tap the Share button in the browser toolbar — the square with an arrow pointing up.',
      'Scroll down the share sheet and tap "Add to Home Screen".',
      'Tap "Add" in the top-right. Sakura now opens full-screen, just like an app.',
    ],
    tip: 'On iPhone and iPad this works best in Safari. Chrome on iOS works too — the Share button sits in the address bar.',
  },
  android: {
    title: 'Install Sakura',
    steps: [
      'Open the browser menu — the ⋮ icon in the top-right.',
      'Tap "Install app" (or "Add to Home screen").',
      'Confirm, and Sakura appears with your other apps.',
    ],
    tip: 'Chrome usually offers an "Install" banner too — either way works.',
  },
  desktop: {
    title: 'Install Sakura',
    steps: [
      'In Chrome or Edge: click the install icon in the address bar — a small screen with a downward arrow.',
      'In Safari on Mac: choose File → Add to Dock.',
      'Confirm, and Sakura opens in its own window.',
    ],
  },
};

/** Which install instructions apply to the current browser. Safe on native/SSR. */
export function detectInstallFlavor(): InstallFlavor {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as MacIntel but is touch-capable
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
  if (iOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/** True when already launched as an installed app (so we stop nagging). */
export function isStandaloneWebApp(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    (window.navigator as any)?.standalone === true
  );
}

/**
 * Step-by-step "add to home screen" tutorial. Shown from the install banner and
 * from Settings, so users can find it again after dismissing the banner.
 */
export default function InstallGuideModal({
  visible,
  onClose,
  flavor,
}: {
  visible: boolean;
  onClose: () => void;
  flavor?: InstallFlavor;
}) {
  const { colors } = useTheme();
  const resolved = flavor ?? detectInstallFlavor();
  const guide = STEPS[resolved];

  const s = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        card: {
          width: '100%',
          maxWidth: 420,
          backgroundColor: colors.surface,
          borderRadius: 28,
          borderWidth: 1,
          borderColor: colors.borderLight,
          padding: 22,
        },
        badge: {
          alignSelf: 'center',
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: `${ACCENT}18`,
          borderWidth: 1,
          borderColor: `${ACCENT}40`,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        },
        badgeText: { fontSize: 28 },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 20,
          color: colors.text,
          textAlign: 'center',
        },
        sub: {
          color: colors.textSecondary,
          fontSize: FontSize.sm,
          textAlign: 'center',
          marginTop: 6,
          lineHeight: 20,
        },
        stepRow: { flexDirection: 'row', gap: 12, marginTop: 16, alignItems: 'flex-start' },
        stepNum: {
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: `${ACCENT}18`,
          borderWidth: 1,
          borderColor: `${ACCENT}40`,
          alignItems: 'center',
          justifyContent: 'center',
        },
        stepNumText: { color: ACCENT, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
        stepText: { flex: 1, color: colors.text, fontSize: FontSize.sm, lineHeight: 21 },
        tip: {
          marginTop: 16,
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.md,
          borderWidth: 1,
          borderColor: colors.borderLight,
          padding: 12,
        },
        tipText: { color: colors.textSecondary, fontSize: FontSize.xs, lineHeight: 18 },
        done: {
          backgroundColor: ACCENT,
          borderRadius: Radius.full,
          paddingVertical: 14,
          alignItems: 'center',
          marginTop: 20,
        },
        doneText: {
          color: '#fff',
          fontSize: FontSize.md,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
        },
      }),
    [colors],
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" />
        <Animated.View entering={FadeInDown.duration(240)} style={s.card}>
          <View style={s.badge}>
            <Text style={s.badgeText}>🌸</Text>
          </View>
          <Text style={s.title}>{guide.title}</Text>
          <Text style={s.sub}>
            Sakura runs full-screen with its own icon — no app store needed.
          </Text>
          <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 320 }}>
            {guide.steps.map((step, i) => (
              <View key={i} style={s.stepRow}>
                <View style={s.stepNum}>
                  <Text style={s.stepNumText}>{i + 1}</Text>
                </View>
                <Text style={s.stepText}>{step}</Text>
              </View>
            ))}
            {guide.tip ? (
              <View style={s.tip}>
                <Text style={s.tipText}>{guide.tip}</Text>
              </View>
            ) : null}
          </ScrollView>
          <TouchableOpacity style={s.done} activeOpacity={0.85} onPress={onClose}>
            <Text style={s.doneText}>Got it</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}
