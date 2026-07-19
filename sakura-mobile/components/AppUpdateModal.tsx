import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Radius, FontSize, FontWeight, Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { playTap } from '@/lib/sound';
import { CURRENT_APP_VERSION, type AppUpdateInfo } from '@/lib/app-update';

const ACCENT = '#E84545';

interface Props {
  info: AppUpdateInfo | null;
  onUpdate: () => void;
  onLater: () => void;
}

/**
 * "New version available" prompt. Styled to match the app's modal language
 * (fade backdrop, surface card, display-font heading, sakura-red primary CTA).
 * Rendered only on native — the bridge never surfaces this on web.
 */
export default function AppUpdateModal({ info, onUpdate, onLater }: Props) {
  const { colors } = useTheme();

  const s = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 28,
        },
        card: {
          width: '100%',
          maxWidth: 400,
          backgroundColor: colors.surface,
          borderRadius: 28,
          padding: 22,
          borderWidth: 1,
          borderColor: colors.borderLight,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.28,
          shadowRadius: 28,
          elevation: 12,
        },
        badge: {
          alignSelf: 'center',
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: `${ACCENT}18`,
          borderWidth: 1,
          borderColor: `${ACCENT}40`,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        },
        badgeEmoji: { fontSize: 30 },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 22,
          color: colors.text,
          textAlign: 'center',
        },
        versionRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          marginTop: 8,
          marginBottom: 4,
        },
        versionChip: {
          paddingHorizontal: 10,
          paddingVertical: 3,
          borderRadius: Radius.full,
          backgroundColor: colors.surfaceSecondary,
          borderWidth: 1,
          borderColor: colors.border,
        },
        versionChipText: {
          fontSize: FontSize.xs,
          color: colors.textSecondary,
          fontWeight: FontWeight.semibold,
        },
        versionChipNew: {
          backgroundColor: `${ACCENT}14`,
          borderColor: `${ACCENT}40`,
        },
        versionChipNewText: { color: ACCENT, fontWeight: FontWeight.bold },
        arrow: { color: colors.textTertiary, fontSize: FontSize.sm },
        notesWrap: {
          marginTop: 14,
          maxHeight: 200,
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.md,
          borderWidth: 1,
          borderColor: colors.borderLight,
        },
        notesLabel: {
          fontSize: FontSize.xs,
          color: colors.textSecondary,
          fontWeight: FontWeight.semibold,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          paddingHorizontal: 14,
          paddingTop: 12,
        },
        notesText: {
          fontSize: FontSize.sm,
          color: colors.text,
          lineHeight: 21,
          paddingHorizontal: 14,
          paddingTop: 6,
          paddingBottom: 14,
        },
        updateBtn: {
          backgroundColor: ACCENT,
          borderRadius: Radius.full,
          paddingVertical: 15,
          alignItems: 'center',
          marginTop: 18,
          shadowColor: ACCENT,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.35,
          shadowRadius: 12,
          elevation: 6,
        },
        updateText: {
          color: '#fff',
          fontSize: FontSize.lg,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          letterSpacing: 0.3,
        },
        laterBtn: { paddingVertical: 12, alignItems: 'center', marginTop: 2 },
        laterText: {
          color: colors.textSecondary,
          fontSize: FontSize.sm,
          fontWeight: FontWeight.medium,
        },
      }),
    [colors],
  );

  const handleUpdate = () => {
    playTap();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (info?.apkUrl) Linking.openURL(info.apkUrl).catch(() => {});
    onUpdate();
  };

  const handleLater = () => {
    playTap();
    onLater();
  };

  return (
    <Modal
      transparent
      visible={!!info}
      animationType="fade"
      onRequestClose={info?.forceUpdate ? undefined : handleLater}
      statusBarTranslucent
    >
      <View style={s.backdrop}>
        {/* Tapping outside dismisses, unless the release is forced. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={info?.forceUpdate ? undefined : handleLater}
          accessibilityRole="button"
        />
        <Animated.View entering={FadeInDown.duration(260)} style={s.card}>
          <View style={s.badge}>
            <Text style={s.badgeEmoji}>🌸</Text>
          </View>

          <Text style={s.title}>Update Available</Text>

          <View style={s.versionRow}>
            <View style={s.versionChip}>
              <Text style={s.versionChipText}>v{CURRENT_APP_VERSION}</Text>
            </View>
            <Text style={s.arrow}>→</Text>
            <View style={[s.versionChip, s.versionChipNew]}>
              <Text style={[s.versionChipText, s.versionChipNewText]}>v{info?.version}</Text>
            </View>
          </View>

          {info?.releaseNotes ? (
            <View style={s.notesWrap}>
              <Text style={s.notesLabel}>What's new</Text>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={s.notesText}>{info.releaseNotes}</Text>
              </ScrollView>
            </View>
          ) : null}

          <TouchableOpacity style={s.updateBtn} activeOpacity={0.85} onPress={handleUpdate}>
            <Text style={s.updateText}>Update Now</Text>
          </TouchableOpacity>

          {!info?.forceUpdate ? (
            <TouchableOpacity style={s.laterBtn} activeOpacity={0.7} onPress={handleLater}>
              <Text style={s.laterText}>Maybe later</Text>
            </TouchableOpacity>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}
