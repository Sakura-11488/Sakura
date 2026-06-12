import React, { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { requestCreatorCoinLaunch } from '@/lib/creator-social';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { useWallet } from '@/lib/wallet/context';
import { Fonts, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

export default function CreatorCoinLaunchScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { address, signWithBiometrics } = useWallet();
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [metadataUri, setMetadataUri] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        wrap: { flex: 1, padding: Spacing.md, gap: Spacing.md },
        title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 28, color: colors.text },
        sub: { fontSize: FontSize.sm, color: colors.textSecondary, lineHeight: 20 },
        input: {
          borderRadius: Radius.lg,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: colors.surface,
          color: colors.text,
          padding: Spacing.md,
        },
        field: { minHeight: 110, textAlignVertical: 'top' },
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
      const result = await requestCreatorCoinLaunch({
        name,
        symbol,
        description,
        metadataUri: metadataUri.trim() || undefined,
        imageUrl: imageUrl.trim() || undefined,
        authHeaders: buildWalletAuthHeaders(keypair, 'creator-coin-launch'),
      });
      Alert.alert(
        'Launch requested',
        result.unsigned_transaction
          ? 'Unsigned launch transaction is ready for the next signing step.'
          : 'Your launch request is queued for review/building.',
        [{ text: 'Done', onPress: () => router.replace('/creator-dashboard') }],
      );
    } catch (error) {
      Alert.alert('Coin launch failed', error instanceof Error ? error.message : 'Please try again.');
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
        <Text style={styles.title}>Revenue Generation</Text>
        <Text style={styles.sub}>
          This creates a reviewed coin launch request. Sakura never asks for creator private keys; launch providers
          must return unsigned transactions for your wallet to sign.
        </Text>
        <TextInput style={styles.input} placeholder="Coin name" placeholderTextColor={colors.textTertiary} value={name} onChangeText={setName} />
        <TextInput
          style={styles.input}
          placeholder="Symbol, e.g. BURNIE"
          placeholderTextColor={colors.textTertiary}
          value={symbol}
          autoCapitalize="characters"
          onChangeText={setSymbol}
        />
        <TextInput
          style={[styles.input, styles.field]}
          placeholder="Description"
          placeholderTextColor={colors.textTertiary}
          multiline
          value={description}
          onChangeText={setDescription}
        />
        <TextInput style={styles.input} placeholder="Metadata URI or IPFS URL" placeholderTextColor={colors.textTertiary} value={metadataUri} onChangeText={setMetadataUri} />
        <TextInput style={styles.input} placeholder="Image URL" placeholderTextColor={colors.textTertiary} value={imageUrl} onChangeText={setImageUrl} />
        <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={submit} disabled={submitting} activeOpacity={0.88}>
          <Text style={styles.btnText}>{submitting ? 'Requesting...' : 'Request Launch'}</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
