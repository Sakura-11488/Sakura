import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme';
import { AppSettings } from '@/lib/settings';
import LegalMarkdown from '@/components/legal/LegalMarkdown';
import {
  COPYRIGHT_CONTENT,
  LEGAL_LAST_UPDATED,
  PRIVACY_CONTENT,
  TERMS_CONTENT,
} from '@/lib/legal-content';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

type LegalTab = 'terms' | 'privacy' | 'copyright';

const TABS: { key: LegalTab; label: string }[] = [
  { key: 'terms', label: 'Terms of Service' },
  { key: 'privacy', label: 'Privacy Policy' },
  { key: 'copyright', label: 'Copyright' },
];

const TAB_CONTENT: Record<LegalTab, string> = {
  terms: TERMS_CONTENT,
  privacy: PRIVACY_CONTENT,
  copyright: COPYRIGHT_CONTENT,
};

export default function WelcomeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<LegalTab>('terms');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { alignItems: 'center', paddingTop: Spacing.lg, paddingHorizontal: Spacing.lg },
        logo: { width: 72, height: 72, marginBottom: Spacing.md },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 28,
          color: colors.text,
          letterSpacing: 0.2,
        },
        subtitle: {
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          textAlign: 'center',
          marginTop: 8,
          lineHeight: 20,
          paddingHorizontal: Spacing.md,
        },
        tabBar: {
          flexDirection: 'row',
          marginTop: Spacing.lg,
          marginHorizontal: Spacing.md,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
        },
        tabBtn: {
          flex: 1,
          alignItems: 'center',
          paddingVertical: 12,
          borderBottomWidth: 2,
          borderBottomColor: 'transparent',
        },
        tabBtnActive: { borderBottomColor: colors.primary },
        tabText: { fontSize: FontSize.xs, fontWeight: FontWeight.semibold, color: colors.textTertiary },
        tabTextActive: { color: colors.primary },
        docScroll: {
          flex: 1,
          marginTop: Spacing.md,
          marginHorizontal: Spacing.md,
          backgroundColor: colors.surface,
          borderRadius: Radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
        },
        docInner: { padding: Spacing.lg },
        updated: {
          fontSize: FontSize.xs,
          color: colors.textTertiary,
          marginBottom: Spacing.sm,
        },
        footer: {
          paddingHorizontal: Spacing.lg,
          paddingTop: Spacing.md,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.borderLight,
          backgroundColor: colors.background,
        },
        agreeRow: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: Spacing.md,
        },
        checkbox: {
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 2,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        },
        agreeText: { flex: 1, fontSize: FontSize.sm, color: colors.textSecondary, lineHeight: 20 },
        agreeBold: { fontWeight: FontWeight.bold, color: colors.text },
        continueBtn: {
          borderRadius: Radius.full,
          paddingVertical: 16,
          alignItems: 'center',
          ...Shadow.sm,
        },
        continueText: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  const handleContinue = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      await AppSettings.setLegalAccepted(true);
      await AppSettings.setLegalAcceptedAt(new Date().toISOString());
      router.replace('/(tabs)');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Image
          source={require('@/assets/images/logo.png')}
          style={styles.logo}
          contentFit="contain"
        />
        <Text style={styles.title}>Welcome to Sakura</Text>
        <Text style={styles.subtitle}>
          Please review and accept our terms before continuing.
        </Text>
      </View>

      <View style={styles.tabBar}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tabBtn, active && styles.tabBtnActive]}
              onPress={() => setTab(t.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView style={styles.docScroll} contentContainerStyle={styles.docInner} showsVerticalScrollIndicator>
        <Text style={styles.updated}>Last updated: {LEGAL_LAST_UPDATED}</Text>
        <LegalMarkdown content={TAB_CONTENT[tab]} colors={colors} />
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.agreeRow}
          onPress={() => setAgreed((v) => !v)}
          activeOpacity={0.8}
        >
          <View
            style={[
              styles.checkbox,
              {
                borderColor: agreed ? colors.primary : colors.border,
                backgroundColor: agreed ? colors.primary : 'transparent',
              },
            ]}
          >
            {agreed ? (
              <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
                <Path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            ) : null}
          </View>
          <Text style={styles.agreeText}>
            I have read and agree to the{' '}
            <Text style={styles.agreeBold}>Terms of Service</Text>,{' '}
            <Text style={styles.agreeBold}>Privacy Policy</Text>, and{' '}
            <Text style={styles.agreeBold}>Copyright Notice</Text>.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.continueBtn,
            { backgroundColor: colors.primary, opacity: agreed && !submitting ? 1 : 0.45 },
          ]}
          onPress={handleContinue}
          disabled={!agreed || submitting}
          activeOpacity={0.85}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={[styles.continueText, { color: '#fff' }]}>Continue to Sakura</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
