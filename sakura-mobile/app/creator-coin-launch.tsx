import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { creatorTokenErrorMessage, requestCreatorCoinLaunch, verifyCreatorCoinLaunch } from '@/lib/creator-social';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import { executeCreatorCoinLaunch } from '@/lib/wallet/creator-coin';
import { clearPendingCreatorCoinLaunch, savePendingCreatorCoinLaunch } from '@/lib/creator-coin-recovery';
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
        keyboard: { flex: 1 },
        wrap: { flexGrow: 1, padding: Spacing.md, paddingBottom: Spacing.xxl, gap: Spacing.md },
        title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 28, color: colors.text },
        sub: { fontSize: FontSize.sm, color: colors.textSecondary, lineHeight: 20 },
        hint: { fontSize: FontSize.xs, color: colors.textSecondary, lineHeight: 18 },
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
    if (name.trim().length < 2) {
      showAlert('Name your token', 'Choose a name with at least two characters.');
      return;
    }
    if (!/^[A-Z0-9]{2,10}$/.test(symbol.trim().toUpperCase())) {
      showAlert('Short symbol', 'Use 2–10 letters or numbers for your token symbol.');
      return;
    }
    if (!metadataUri.trim() && !imageUrl.trim()) {
      showAlert('Add token artwork', 'Add an artwork URL or a metadata link to continue.');
      return;
    }
    setSubmitting(true);
    let signed = false;
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
        showAlert('Request received', 'Your Japanese Stock setup request is in progress. You can check its status from your creator dashboard.');
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
        intent: {
          name: name.trim().slice(0, 80),
          symbol: symbol.trim().toUpperCase(),
          metadataUri: metadataUri.trim(),
        },
        onSigned: async (signature) => {
          await savePendingCreatorCoinLaunch({
            creatorWallet: address,
            coinId: result.coin_id,
            launchRequestId: result.launch_request_id,
            mintAddress: result.mint_address!,
            signature,
          });
          signed = true;
        },
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
      await clearPendingCreatorCoinLaunch(address).catch(() => {});

      showAlert('Japanese Stock is live', `Your ${symbol.toUpperCase()} token is live. Address: ${submitted.mintAddress}`);
      router.replace('/creator-dashboard');
    } catch (error) {
      if (signed) {
        showAlert('Check token status', 'Your wallet signed the transaction, but confirmation is incomplete. Finish verification from your creator dashboard before trying again.');
        router.replace('/creator-dashboard');
      } else {
        showAlert('Token setup failed', creatorTokenErrorMessage(error));
      }
    } finally {
      setSubmitting(false);
      setStage(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboard}>
        <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.back}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Tokenise your work with Japanese Stock</Text>
          <Text style={styles.sub}>
            Give your creator community one token inspired by the work you publish on Sakura. This is a digital token,
            not company shares or ownership of your work. Your wallet approves any creation on Solana through pump.fun.
          </Text>
          <TextInput style={styles.input} placeholder="Token name" placeholderTextColor={colors.textTertiary} value={name} onChangeText={setName} />
          <TextInput
            style={styles.input}
            placeholder="Short symbol, e.g. BURNIE"
            placeholderTextColor={colors.textTertiary}
            value={symbol}
            autoCapitalize="characters"
            onChangeText={setSymbol}
          />
          <TextInput
            style={[styles.input, styles.field]}
            placeholder="What should readers know about this token?"
            placeholderTextColor={colors.textTertiary}
            multiline
            value={description}
            onChangeText={setDescription}
          />
          <TextInput style={styles.input} placeholder="Metadata link for final creation" placeholderTextColor={colors.textTertiary} value={metadataUri} onChangeText={setMetadataUri} />
          <TextInput style={styles.input} placeholder="Artwork image URL" placeholderTextColor={colors.textTertiary} value={imageUrl} onChangeText={setImageUrl} />
          <Text style={styles.hint}>Add an artwork URL or metadata link. A hosted metadata link is needed before the token can be created on Solana.</Text>
          <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={submit} disabled={submitting} activeOpacity={0.88}>
            <Text style={styles.btnText}>{stage ?? (submitting ? 'Preparing…' : 'Continue with wallet')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
