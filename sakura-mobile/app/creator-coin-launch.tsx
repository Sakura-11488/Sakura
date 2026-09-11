import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { requestCreatorCoinLaunch, verifyCreatorCoinLaunch } from '@/lib/creator-social';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import { executeCreatorCoinLaunch } from '@/lib/wallet/creator-coin';
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
  // Signing and confirming take real seconds against mainnet; without this the
  // button just sits there and a creator taps again.
  const [stage, setStage] = useState<string | null>(null);

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
      showAlert('Wallet required', 'Connect your creator wallet first.');
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
      if (!result.unsigned_transaction || !result.mint_address) {
        // No builder configured: the request is recorded, nothing is minted.
        showAlert('Launch requested', 'Your launch request is queued for building.');
        router.replace('/creator-dashboard');
        return;
      }

      // Sign and submit. Everything below is irreversible once it confirms, so
      // it is deliberately NOT wrapped in a retry — a second attempt after an
      // ambiguous failure is how a creator ends up with two coins.
      setStage('Signing…');
      const submitted = await executeCreatorCoinLaunch({
        unsignedTransaction: result.unsigned_transaction,
        mintAddress: result.mint_address,
        lastValidBlockHeight: result.last_valid_block_height ?? 0,
        keypair,
      });

      // A confirmed signature is not success on its own. Verification is what
      // moves the coin to `launched` and marks the vanity mint consumed, and
      // skipping it would leave the reservation able to expire back into the
      // pool while the coin exists on chain.
      setStage('Confirming…');
      await verifyCreatorCoinLaunch({
        coinId: result.coin_id,
        launchRequestId: result.launch_request_id,
        signature: submitted.signature,
        mintAddress: submitted.mintAddress,
        authHeaders: buildWalletAuthHeaders(keypair, 'creator-coin-verify'),
      });

      showAlert('Coin launched', `${symbol.toUpperCase()} is live at ${submitted.mintAddress}`);
      router.replace('/creator-dashboard');
    } catch (error) {
      showAlert('Coin launch failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setSubmitting(false);
      setStage(null);
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
          <Text style={styles.btnText}>{stage ?? (submitting ? 'Requesting...' : 'Request Launch')}</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
