import React, { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { submitCreatorVerification } from '@/lib/creator-social';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { useWallet } from '@/lib/wallet/context';
import { Fonts, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

export default function CreatorVerificationScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { address, signWithBiometrics } = useWallet();
  const [reason, setReason] = useState('');
  const [links, setLinks] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        wrap: { flex: 1, padding: Spacing.md, gap: Spacing.md },
        title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 28, color: colors.text },
        sub: { fontSize: FontSize.sm, color: colors.textSecondary, lineHeight: 20 },
        field: {
          minHeight: 150,
          borderRadius: Radius.lg,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: colors.surface,
          color: colors.text,
          padding: Spacing.md,
          textAlignVertical: 'top',
        },
        input: {
          borderRadius: Radius.lg,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: colors.surface,
          color: colors.text,
          padding: Spacing.md,
        },
        btn: { borderRadius: Radius.full, backgroundColor: colors.primary, paddingVertical: 15, alignItems: 'center' },
        btnDisabled: { opacity: 0.55 },
        btnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
        back: { color: colors.primary, fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  async function submit() {
    if (!address) {
      Alert.alert('Wallet required', 'Connect your creator wallet first.');
      return;
    }
    setSubmitting(true);
    try {
      const keypair = await signWithBiometrics();
      if (!keypair) throw new Error('Wallet approval is required.');
      const socialLinks = links
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((acc, value, index) => {
          acc[`link_${index + 1}`] = value;
          return acc;
        }, {});
      await submitCreatorVerification({
        reason,
        socialLinks,
        authHeaders: buildWalletAuthHeaders(keypair, 'creator-verification-request'),
      });
      Alert.alert('Submitted', 'Your verification request is ready for review.', [
        { text: 'Done', onPress: () => router.replace('/creator-dashboard') },
      ]);
    } catch (error) {
      Alert.alert('Verification failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Request Verification</Text>
        <Text style={styles.sub}>
          Verified creators can unlock revenue tools after admin review. Tell Sakura who you are, what you publish,
          and where reviewers can confirm your creator presence.
        </Text>
        <TextInput
          style={styles.field}
          placeholder="Why should this creator profile be verified?"
          placeholderTextColor={colors.textTertiary}
          multiline
          value={reason}
          onChangeText={setReason}
        />
        <TextInput
          style={styles.input}
          placeholder="Social links, one per line"
          placeholderTextColor={colors.textTertiary}
          multiline
          value={links}
          onChangeText={setLinks}
        />
        <TouchableOpacity
          style={[styles.btn, submitting && styles.btnDisabled]}
          onPress={submit}
          disabled={submitting}
          activeOpacity={0.88}
        >
          <Text style={styles.btnText}>{submitting ? 'Submitting...' : 'Submit Request'}</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
