import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  Clipboard,
  Linking,
  Platform,
} from 'react-native';
import { PublicKey } from '@solana/web3.js';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import Animated, { FadeInRight, FadeOutLeft } from 'react-native-reanimated';
import Svg, { Path, Polygon } from 'react-native-svg';
import LottieView from 'lottie-react-native';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/lib/wallet/context';
import { getWalletWithBiometrics } from '@/lib/wallet/storage';
import { getSakuraSwapQuote, executeSakuraSwap, type SwapQuote } from '@/lib/wallet/swap';
import { sendSol, sendSakura } from '@/lib/wallet/connection';
import {
  maxSendableSol,
  maxSendableSakura,
} from '@/lib/wallet/balances';
import { SAKURA_SEND_SOL_RESERVE } from '@/lib/wallet/config';
import { getSolanaNetworkLabel } from '@/lib/wallet/config';
import QRCode from 'react-native-qrcode-svg';
import { Radius, FontSize, FontWeight, Spacing, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { confirmDestructive } from '@/lib/confirm-alert';
import { playTap, onTap } from '@/lib/sound';
import { MAX_WALLET_MODAL_WIDTH } from '@/constants/layout';
import { getSendAuthLabel, getSwapAuthLabel, getWalletProtectionCopy } from '@/lib/wallet/platform-labels';

// ─── Icons ────────────────────────────────────────────────────────────────────
const CopyIcon = () => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
    <Path d="M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z" stroke="#E84545" strokeWidth={2} />
    <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="#E84545" strokeWidth={2} />
  </Svg>
);

const RefreshIcon = () => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
    <Path d="M23 4v6h-6" stroke="#E84545" strokeWidth={2} strokeLinecap="round" />
    <Path d="M1 20v-6h6" stroke="#E84545" strokeWidth={2} strokeLinecap="round" />
    <Path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="#E84545" strokeWidth={2} strokeLinecap="round" />
  </Svg>
);

const StarIcon = () => (
  <Svg width={14} height={14} viewBox="0 0 24 24" fill="#F5A623">
    <Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="#F5A623" />
  </Svg>
);

// ─── Balance card ─────────────────────────────────────────────────────────────
function BalanceCard({ label, value, sub, loading }: { label: string; value: string; sub?: string; loading: boolean }) {
  const { colors } = useTheme();

  const bc = useMemo(() => StyleSheet.create({
    card: {
      flex: 1,
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      padding: 14,
      alignItems: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    label: { fontSize: FontSize.xs, color: colors.textSecondary, fontWeight: FontWeight.medium, textTransform: 'uppercase', letterSpacing: 0.5 },
    value: { fontSize: FontSize.xl, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, color: colors.text },
    sub: { fontSize: FontSize.xs, color: '#E84545', fontWeight: FontWeight.bold },
  }), [colors]);

  return (
    <View style={bc.card}>
      <Text style={bc.label}>{label}</Text>
      {loading ? (
        <ActivityIndicator color="#E84545" size="small" style={{ marginTop: 6 }} />
      ) : (
        <>
          <Text style={bc.value}>{value}</Text>
          {sub && <Text style={bc.sub}>{sub}</Text>}
        </>
      )}
    </View>
  );
}

// ─── Receive sheet ────────────────────────────────────────────────────────────
function ReceiveSheet({ address, onClose }: { address: string; onClose: () => void }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);

  const rs = useMemo(() => StyleSheet.create({
    wrap: { gap: 16, alignItems: 'center', paddingBottom: 8 },
    title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: colors.text },
    sub: { fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
    qrWrap: {
      padding: 20,
      backgroundColor: '#FFFFFF',
      borderRadius: Radius.lg,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    addrBox: {
      width: '100%',
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      padding: 14,
      alignItems: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
    addrText: {
      fontSize: FontSize.sm,
      color: colors.text,
      fontFamily: Fonts.mono ?? undefined,
      fontWeight: FontWeight.medium,
      width: '100%',
      textAlign: 'center',
    },
    copyLabel: { fontSize: FontSize.xs, color: '#E84545', fontWeight: FontWeight.semibold },
    cancelBtn: { paddingVertical: 12, alignItems: 'center' },
    cancelText: { color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  }), [colors]);

  const handleCopy = () => {
    playTap();
    Clipboard.setString(address);
    setCopied(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={rs.wrap}>
      <Text style={rs.title}>Receive SOL / SAKURA</Text>
      <Text style={rs.sub}>
        Share this address to receive SOL or SAKURA. Send SOL to this exact Sakura wallet for network fees.
      </Text>
      <View style={rs.qrWrap}>
        <QRCode value={address} size={180} color={colors.text === '#F2F2F7' ? '#1A1A1A' : colors.text} backgroundColor="transparent" />
      </View>
      <TouchableOpacity onPress={handleCopy} style={rs.addrBox} activeOpacity={0.7}>
        <Text style={rs.addrText} numberOfLines={1} ellipsizeMode="middle">{address}</Text>
        <Text style={rs.copyLabel}>{copied ? '✓ Copied' : 'Tap to copy'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onClose} style={rs.cancelBtn} activeOpacity={0.7}>
        <Text style={rs.cancelText}>Close</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Send sheet ───────────────────────────────────────────────────────────────
type SendAsset = 'sakura' | 'sol';
type SendStep = 'input' | 'sending' | 'done' | 'error';

function SendSheet({
  solBalance,
  sakuraBalance,
  walletAddress,
  onClose,
  onComplete,
}: {
  solBalance: number | null;
  sakuraBalance: number | null;
  walletAddress: string | null;
  onClose: () => void;
  onComplete: () => void;
}) {
  const { colors } = useTheme();
  const [asset, setAsset] = useState<SendAsset>('sakura');
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<SendStep>('input');
  const [sendError, setSendError] = useState('');
  const [txid, setTxid] = useState('');
  const [maxSakura, setMaxSakura] = useState(0);

  const bs = useMemo(() => StyleSheet.create({
    wrap: { paddingBottom: 8, gap: 10 },
    title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: colors.text, textAlign: 'center' },
    sub: { fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
    assetRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 4 },
    assetChip: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceSecondary,
    },
    assetChipActive: { borderColor: '#E84545', backgroundColor: '#E8454518' },
    assetChipText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: colors.textSecondary },
    assetChipTextActive: { color: '#E84545' },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      marginTop: 6,
    },
    input: {
      flex: 1,
      fontSize: FontSize.xl,
      fontFamily: Fonts.display,
      fontWeight: FontWeight.bold,
      color: colors.text,
      paddingVertical: 14,
    },
    inputLabel: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: colors.textSecondary, marginHorizontal: 8 },
    maxBtn: { backgroundColor: '#E8454518', borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 5 },
    maxText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#E84545' },
    hint: { fontSize: FontSize.xs, color: colors.textTertiary, textAlign: 'center', lineHeight: 17 },
    btn: {
      backgroundColor: '#E84545',
      borderRadius: Radius.full,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 6,
      shadowColor: '#E84545',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 10,
      elevation: 5,
    },
    btnDisabled: { opacity: 0.45 },
    btnText: { color: '#fff', fontSize: FontSize.md, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight },
    cancelBtn: { paddingVertical: 12, alignItems: 'center' },
    cancelText: { color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
    link: { color: '#E84545', fontSize: FontSize.sm, textAlign: 'center', textDecorationLine: 'underline' },
    error: { color: '#FF3B30', fontSize: FontSize.sm, textAlign: 'center' },
  }), [colors]);

  const maxSol = maxSendableSol(solBalance);

  useEffect(() => {
    if (asset !== 'sakura' || !walletAddress) {
      setMaxSakura(asset === 'sakura' ? Math.floor(sakuraBalance ?? 0) : 0);
      return;
    }
    let active = true;
    maxSendableSakura(new PublicKey(walletAddress), sakuraBalance, solBalance, toAddress)
      .then((value) => {
        if (active) setMaxSakura(value);
      })
      .catch(() => {
        if (active) setMaxSakura(Math.floor(sakuraBalance ?? 0));
      });
    return () => {
      active = false;
    };
  }, [asset, sakuraBalance, solBalance, toAddress, walletAddress]);

  const availableLabel =
    asset === 'sol'
      ? `${(solBalance ?? 0).toFixed(4)} SOL`
      : `${(sakuraBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} SAKURA`;

  const isValidAddress = (addr: string) => {
    try {
      return new PublicKey(addr.trim()).toBase58() === addr.trim();
    } catch {
      return false;
    }
  };

  const handleMax = () => {
    if (asset === 'sol') {
      setAmount(maxSol > 0 ? maxSol.toString() : '');
      return;
    }
    setAmount(maxSakura > 0 ? maxSakura.toString() : '');
  };

  const handleSend = async () => {
    const val = parseFloat(amount);
    if (!isValidAddress(toAddress)) { setSendError('Invalid Solana address'); return; }
    if (!val || val <= 0) { setSendError('Enter an amount'); return; }

    if (asset === 'sol') {
      if (val > maxSol) {
        setSendError(`Max: ${maxSol} SOL (keeping fee reserve)`);
        return;
      }
    } else {
      if (val > maxSakura) {
        const lowSol = (solBalance ?? 0) < SAKURA_SEND_SOL_RESERVE;
        setSendError(
          lowSol
            ? `Keep at least ${SAKURA_SEND_SOL_RESERVE} SOL for network fees when sending SAKURA.`
            : `Max sendable right now: ${maxSakura.toLocaleString()} SAKURA`,
        );
        return;
      }
    }

    setStep('sending');
    setSendError('');
    try {
      const keypair = await getWalletWithBiometrics();
      if (!keypair) throw new Error('Could not unlock wallet');
      const id = asset === 'sol'
        ? await sendSol(keypair, toAddress, val)
        : await sendSakura(keypair, toAddress, val);
      setTxid(id);
      setStep('done');
      onComplete();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setSendError(e.message ?? 'Transaction failed');
      setStep('error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (step === 'done') {
    const unit = asset === 'sol' ? 'SOL' : 'SAKURA';
    return (
      <View style={bs.wrap}>
        <Text style={bs.title}>✓ Sent!</Text>
        <Text style={bs.sub}>{amount} {unit} sent successfully</Text>
        {txid ? (
          <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${txid}`)} activeOpacity={0.7}>
            <Text style={bs.link}>View on Solscan ↗</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={onClose} style={[bs.btn, { marginTop: 20 }]} activeOpacity={0.85}>
          <Text style={bs.btnText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={bs.wrap}>
      <Text style={bs.title}>Send</Text>
      <Text style={bs.sub}>Available: {availableLabel}</Text>
      <Text style={bs.hint}>
        SOL: {(solBalance ?? 0).toFixed(4)} · SAKURA: {(sakuraBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </Text>

      <View style={bs.assetRow}>
        {(['sakura', 'sol'] as const).map((option) => (
          <TouchableOpacity
            key={option}
            style={[bs.assetChip, asset === option && bs.assetChipActive]}
            onPress={() => {
              setAsset(option);
              setAmount('');
              setSendError('');
            }}
            activeOpacity={0.85}
          >
            <Text style={[bs.assetChipText, asset === option && bs.assetChipTextActive]}>
              {option === 'sakura' ? 'SAKURA' : 'SOL'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={[bs.inputRow, { marginTop: 12 }]}>
        <TextInput
          style={[bs.input, { fontSize: FontSize.sm }]}
          value={toAddress}
          onChangeText={setToAddress}
          placeholder="Recipient address (Base58)"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          editable={step === 'input' || step === 'error'}
        />
      </View>

      <View style={[bs.inputRow, { marginTop: 8 }]}>
        <TextInput
          style={bs.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="0"
          placeholderTextColor={colors.textTertiary}
          keyboardType="decimal-pad"
          editable={step === 'input' || step === 'error'}
        />
        <Text style={bs.inputLabel}>{asset === 'sol' ? 'SOL' : 'SAKURA'}</Text>
        <TouchableOpacity onPress={handleMax} style={bs.maxBtn} activeOpacity={0.7}>
          <Text style={bs.maxText}>MAX</Text>
        </TouchableOpacity>
      </View>

      {asset === 'sakura' && (solBalance ?? 0) < SAKURA_SEND_SOL_RESERVE ? (
        <Text style={bs.hint}>
          You need at least {SAKURA_SEND_SOL_RESERVE} SOL in this wallet to pay network fees when sending SAKURA.
        </Text>
      ) : null}

      {(sendError || step === 'error') && (
        <Text style={bs.error}>{sendError || 'Transaction failed. Try again.'}</Text>
      )}

      <TouchableOpacity
        onPress={handleSend}
        style={[bs.btn, step === 'sending' && bs.btnDisabled]}
        disabled={step === 'sending'}
        activeOpacity={0.85}
      >
        {step === 'sending' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={bs.btnText}>{getSendAuthLabel()}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={onClose} style={bs.cancelBtn} activeOpacity={0.7}>
        <Text style={bs.cancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Buy SAKURA sheet ─────────────────────────────────────────────────────────
type SwapStep = 'input' | 'quoting' | 'swapping' | 'done' | 'error';

function BuySakuraSheet({ solBalance, walletAddress, onClose, onComplete, onRefreshBalances }: {
  solBalance: number | null;
  walletAddress: string | null;
  onClose: () => void;
  onComplete: () => void;
  onRefreshBalances: () => Promise<void>;
}) {
  const { colors } = useTheme();
  const [solAmount, setSolAmount] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [step, setStep] = useState<SwapStep>('input');
  const [swapError, setSwapError] = useState('');
  const [txid, setTxid] = useState('');
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bs = useMemo(() => StyleSheet.create({
    wrap: { paddingBottom: 8, gap: 10 },
    title: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: colors.text, textAlign: 'center' },
    sub: { fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      marginTop: 6,
    },
    input: {
      flex: 1,
      fontSize: FontSize.xl,
      fontFamily: Fonts.display,
      fontWeight: FontWeight.bold,
      color: colors.text,
      paddingVertical: 14,
    },
    inputLabel: { fontSize: FontSize.md, fontWeight: FontWeight.semibold, color: colors.textSecondary, marginHorizontal: 8 },
    maxBtn: { backgroundColor: '#E8454518', borderRadius: Radius.sm, paddingHorizontal: 10, paddingVertical: 5 },
    maxText: { fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: '#E84545' },
    balanceHint: { fontSize: FontSize.xs, color: colors.textTertiary, marginTop: -4 },
    quoteRow: {
      backgroundColor: '#E845450D',
      borderRadius: Radius.md,
      padding: 14,
      borderWidth: 1,
      borderColor: '#E8454530',
      gap: 4,
    },
    quoteLabel: { fontSize: FontSize.xs, color: colors.textSecondary, fontWeight: FontWeight.medium },
    quoteValue: { fontSize: FontSize.xl, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, color: '#E84545' },
    quoteImpact: { fontSize: FontSize.xs, color: colors.textTertiary },
    btn: {
      backgroundColor: '#E84545',
      borderRadius: Radius.full,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 6,
      shadowColor: '#E84545',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 10,
      elevation: 5,
    },
    btnDisabled: { opacity: 0.45 },
    btnText: { color: '#fff', fontSize: FontSize.md, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight },
    cancelBtn: { paddingVertical: 12, alignItems: 'center' },
    cancelText: { color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
    link: { color: '#E84545', fontSize: FontSize.sm, textAlign: 'center', textDecorationLine: 'underline' },
    error: { color: '#FF3B30', fontSize: FontSize.sm, textAlign: 'center' },
  }), [colors]);

  const hasSol = (solBalance ?? 0) > 0.015;
  const maxSol = hasSol ? Math.floor(((solBalance ?? 0) - 0.015) * 10000) / 10000 : 0;

  const fetchQuote = useCallback(async (amt: string) => {
    const val = parseFloat(amt);
    if (!val || val <= 0) { setQuote(null); return; }
    setStep('quoting');
    try {
      const q = await getSakuraSwapQuote(val);
      setQuote(q);
    } catch (e: any) {
      setQuote(null);
    } finally {
      setStep('input');
    }
  }, []);

  useEffect(() => {
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => fetchQuote(solAmount), 600);
    return () => { if (quoteTimer.current) clearTimeout(quoteTimer.current); };
  }, [solAmount, fetchQuote]);

  const handleSwap = async () => {
    const val = parseFloat(solAmount);
    if (!val || val <= 0) return;
    if (val > maxSol) { setSwapError(`Max swappable: ${maxSol} SOL`); return; }
    if (!quote) { setSwapError('Fetching quote, please wait…'); return; }
    setStep('swapping');
    setSwapError('');
    try {
      const keypair = await getWalletWithBiometrics();
      if (!keypair) throw new Error('Could not unlock wallet');
      const result = await executeSakuraSwap(quote, keypair);
      if (!result.success) throw new Error(result.error ?? 'Swap failed');
      setTxid(result.txid ?? '');
      setStep('done');
      onComplete();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setSwapError(e.message ?? 'Swap failed');
      setStep('error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (step === 'done') {
    return (
      <View style={bs.wrap}>
        <Text style={bs.title}>🌸 Swap Complete!</Text>
        <Text style={bs.sub}>
          You received ~{quote?.outAmountSakura.toLocaleString(undefined, { maximumFractionDigits: 0 })} SAKURA
        </Text>
        {txid ? (
          <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${txid}`)} activeOpacity={0.7}>
            <Text style={bs.link}>View on Solscan ↗</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={onClose} style={[bs.btn, { marginTop: 20 }]} activeOpacity={0.85}>
          <Text style={bs.btnText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasSol) {
    return (
      <View style={bs.wrap}>
        <Text style={bs.title}>Get SOL First</Text>
        <Text style={bs.sub}>
          Send SOL to your Sakura wallet on {getSolanaNetworkLabel()}, then refresh your balance and swap to SAKURA here.
        </Text>
        {walletAddress ? (
          <Text style={bs.balanceHint} numberOfLines={1}>
            Sakura wallet: {walletAddress.slice(0, 6)}…{walletAddress.slice(-6)}
          </Text>
        ) : null}
        {swapError ? <Text style={bs.error}>{swapError}</Text> : null}
        <TouchableOpacity
          onPress={onRefreshBalances}
          style={bs.cancelBtn}
          activeOpacity={0.7}
        >
          <Text style={[bs.cancelText, { color: '#E84545' }]}>Refresh balance after sending SOL</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={bs.cancelBtn} activeOpacity={0.7}>
          <Text style={bs.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isLoading = step === 'quoting' || step === 'swapping';

  return (
    <>
      <View style={bs.wrap}>
      <Text style={bs.title}>Buy SAKURA</Text>
      <Text style={bs.sub}>Swap SOL → SAKURA via Jupiter ({getSolanaNetworkLabel()})</Text>
      <Text style={bs.link}>Need more SOL? Send SOL to your Sakura wallet, then refresh.</Text>

      <View style={bs.inputRow}>
        <TextInput
          style={bs.input}
          value={solAmount}
          onChangeText={setSolAmount}
          placeholder="0.00"
          placeholderTextColor={colors.textTertiary}
          keyboardType="decimal-pad"
          editable={!isLoading}
        />
        <Text style={bs.inputLabel}>SOL</Text>
        <TouchableOpacity onPress={() => setSolAmount(maxSol.toString())} style={bs.maxBtn} activeOpacity={0.7}>
          <Text style={bs.maxText}>MAX</Text>
        </TouchableOpacity>
      </View>
      <Text style={bs.balanceHint}>Available: {maxSol} SOL</Text>

      {step === 'quoting' && (
        <ActivityIndicator color="#E84545" style={{ marginVertical: 8 }} />
      )}
      {quote && step !== 'quoting' && (
        <View style={bs.quoteRow}>
          <Text style={bs.quoteLabel}>You receive</Text>
          <Text style={bs.quoteValue}>
            ~{quote.outAmountSakura.toLocaleString(undefined, { maximumFractionDigits: 0 })} SAKURA
          </Text>
          <Text style={bs.quoteImpact}>Price impact: {(parseFloat(quote.priceImpactPct) * 100).toFixed(2)}%</Text>
        </View>
      )}

      {(swapError || step === 'error') && (
        <Text style={bs.error}>{swapError || 'Swap failed. Try again.'}</Text>
      )}

      <TouchableOpacity
        onPress={handleSwap}
        style={[bs.btn, (!quote || isLoading) && bs.btnDisabled]}
        disabled={!quote || isLoading}
        activeOpacity={0.85}
      >
        {step === 'swapping' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={bs.btnText}>{getSwapAuthLabel()}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={onClose} style={bs.cancelBtn} activeOpacity={0.7}>
        <Text style={bs.cancelText}>Cancel</Text>
      </TouchableOpacity>
      </View>
    </>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────────────────
type Tab = 'wallet' | 'create' | 'import';
export type WalletSheetRoute = 'main' | 'receive' | 'send' | 'buy';

interface Props {
  visible: boolean;
  onClose: () => void;
  initialRoute?: WalletSheetRoute;
}

export default function WalletModal({ visible, onClose, initialRoute }: Props) {
  const wallet = useWallet();
  const { colors } = useTheme();
  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => (Platform.OS === 'web' ? ['90%', '98%'] : ['94%']), []);
  const [tab, setTab] = useState<Tab>(wallet.connected ? 'wallet' : 'create');
  const [route, setRoute] = useState<WalletSheetRoute>('main');
  const [importKey, setImportKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = useMemo(() => {
    return StyleSheet.create({
      sheetInner: {
        paddingHorizontal: 20,
        paddingBottom: Platform.OS === 'web' ? 108 : 28,
      },
      header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 12,
        paddingTop: 6,
      },
      headerLottie: {
        width: 42,
        height: 42,
      },
      heading: {
        flex: 1,
        fontFamily: Fonts.display,
        fontWeight: Fonts.displayWeight,
        fontSize: 18,
        color: colors.text,
        letterSpacing: 0.2,
      },
      headingSub: {
        color: colors.textSecondary,
        fontSize: FontSize.xs,
        marginTop: 2,
      },
      closeBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.borderLight,
      },
      closeX: { fontSize: 14, color: colors.textSecondary, fontWeight: FontWeight.bold },
      connectedHero: {
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: Radius.lg,
        padding: 14,
        marginBottom: 12,
        gap: 8,
      },
      connectedHeroTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      },
      connectedBadgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      },
      connectedBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: Radius.full,
        backgroundColor: '#34C7591F',
        borderWidth: 1,
        borderColor: '#34C75966',
      },
      connectedBadgeText: {
        color: '#2DB24A',
        fontSize: FontSize.xs,
        fontWeight: FontWeight.bold,
      },
      networkBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: Radius.full,
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.border,
      },
      networkBadgeText: {
        color: colors.textSecondary,
        fontSize: FontSize.xs,
        fontWeight: FontWeight.semibold,
      },
      sectionLabel: {
        color: colors.textSecondary,
        fontSize: FontSize.xs,
        fontWeight: FontWeight.semibold,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        marginBottom: 8,
      },
      addressRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surfaceSecondary,
        borderRadius: Radius.md,
        padding: 14,
        gap: 10,
        marginBottom: 14,
      },
      addressText: {
        flex: 1,
        fontFamily: Fonts.mono ?? undefined,
        fontSize: FontSize.md,
        color: colors.text,
        fontWeight: FontWeight.medium,
      },
      copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
      copyLabel: { fontSize: FontSize.sm, color: '#E84545', fontWeight: FontWeight.semibold },
      balanceRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
      refreshBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        justifyContent: 'center',
        paddingVertical: 8,
        marginBottom: 16,
      },
      refreshText: { fontSize: FontSize.sm, color: '#E84545', fontWeight: FontWeight.medium },
      balanceDebugWrap: {
        marginBottom: 16,
        padding: 12,
        borderRadius: Radius.md,
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.borderLight,
        gap: 4,
      },
      balanceDebugTitle: {
        fontSize: FontSize.xs,
        fontWeight: FontWeight.semibold,
        color: colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 4,
      },
      balanceDebugLine: { fontSize: FontSize.xs, color: colors.textSecondary },
      balanceDebugError: { color: '#FF3B30' },
      actionsRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
      actionBtn: {
        flex: 1,
        paddingVertical: 13,
        borderRadius: Radius.md,
        borderWidth: 1.5,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        backgroundColor: colors.surfaceSecondary,
      },
      actionBtnIcon: { fontSize: 14, color: colors.textSecondary },
      buyBtn: { backgroundColor: '#E84545', borderColor: '#E84545' },
      actionBtnText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: colors.text },
      disconnectBtn: {
        paddingVertical: 14,
        borderRadius: Radius.full,
        borderWidth: 1.5,
        borderColor: '#FF3B30',
        alignItems: 'center',
      },
      disconnectText: { color: '#FF3B30', fontWeight: FontWeight.semibold, fontSize: FontSize.md },
      tabs: {
        flexDirection: 'row',
        backgroundColor: colors.surfaceSecondary,
        borderRadius: Radius.md,
        padding: 4,
        marginBottom: 20,
      },
      tabBtn: {
        flex: 1,
        paddingVertical: 11,
        borderRadius: Radius.sm,
        alignItems: 'center',
      },
      tabBtnActive: {
        backgroundColor: colors.white,
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 4,
        elevation: 2,
      },
      tabText: { fontSize: FontSize.sm, fontWeight: FontWeight.medium, color: colors.textSecondary },
      tabTextActive: { color: colors.text, fontWeight: FontWeight.bold },
      tabContent: { gap: 14 },
      tabDesc: { fontSize: FontSize.sm, color: colors.textSecondary, lineHeight: 20, textAlign: 'center' },
      connectHero: {
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: Radius.lg,
        padding: 14,
        gap: 8,
      },
      connectTitle: {
        color: colors.text,
        fontSize: FontSize.md,
        fontWeight: FontWeight.bold,
      },
      connectSubtitle: {
        color: colors.textSecondary,
        fontSize: FontSize.sm,
        lineHeight: 20,
      },
      tipsRow: {
        gap: 8,
      },
      tipItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      },
      tipDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#E84545',
      },
      tipText: {
        color: colors.textSecondary,
        fontSize: FontSize.xs,
        flex: 1,
      },
      warnBox: {
        backgroundColor: '#FF950012',
        borderWidth: 1,
        borderColor: '#FF950055',
        borderRadius: Radius.md,
        padding: 10,
      },
      warnText: {
        color: colors.textSecondary,
        fontSize: FontSize.xs,
        lineHeight: 17,
      },
      primaryBtn: {
        backgroundColor: '#E84545',
        borderRadius: Radius.full,
        paddingVertical: 15,
        alignItems: 'center',
        shadowColor: '#E84545',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 6,
      },
      primaryBtnText: {
        color: '#fff',
        fontSize: FontSize.lg,
        fontFamily: Fonts.display,
        fontWeight: Fonts.displayWeight,
        letterSpacing: 0.3,
      },
      btnDisabled: { opacity: 0.45 },
      keyInput: {
        backgroundColor: colors.surfaceSecondary,
        borderRadius: Radius.md,
        padding: 12,
        fontSize: FontSize.sm,
        color: colors.text,
        minHeight: 92,
        textAlignVertical: 'top',
        borderWidth: 1,
        borderColor: colors.border,
      },
      error: {
        color: '#FF3B30',
        fontSize: FontSize.sm,
        textAlign: 'center',
        marginTop: 10,
      },
      backBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.borderLight,
      },
      backText: {
        color: colors.textSecondary,
        fontSize: 18,
        lineHeight: 20,
      },
    });
  }, [colors]);

  const webSheet = useMemo(() => StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
      alignItems: 'center',
      ...(Platform.OS === 'web' ? { position: 'fixed' as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000 } : {}),
    },
    card: {
      width: '100%',
      maxWidth: MAX_WALLET_MODAL_WIDTH,
      maxHeight: '92vh',
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      overflow: 'hidden',
    },
    handle: {
      alignSelf: 'center',
      width: 44,
      height: 5,
      borderRadius: 3,
      marginTop: 10,
      marginBottom: 4,
    },
  }), []);

  useEffect(() => {
    if (visible) {
      setTab(wallet.connected ? 'wallet' : 'create');
      setRoute(initialRoute ?? 'main');
    }
  }, [visible, wallet.connected, initialRoute]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || !wallet.connected) return;
    const t = setTimeout(() => sheetRef.current?.snapToIndex(1), 120);
    return () => clearTimeout(t);
  }, [visible, wallet.connected]);

  const handleCreate = async () => {
    setError(null);
    try {
      await wallet.createWallet();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleImport = async () => {
    if (!importKey.trim()) return;
    setError(null);
    try {
      await wallet.importWallet(importKey);
      setImportKey('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setError('Invalid private key. Please check and try again.');
    }
  };

  const handleDisconnect = () => {
    playTap();
    confirmDestructive(
      'Disconnect Wallet',
      'This will remove your wallet from this device. Make sure you have your private key backed up.',
    ).then(async (ok) => {
      if (!ok) return;
      await wallet.disconnect();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onClose();
    });
  };

  const handleCopy = () => {
    playTap();
    if (wallet.address) {
      Clipboard.setString(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const closeSheet = useCallback(() => {
    playTap();
    onClose();
  }, [onClose]);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.55}
        pressBehavior="close"
      />
    ),
    [],
  );

  const routeTitle = route === 'main'
    ? (wallet.connected ? 'YOUR SAKURA' : 'GET STARTED')
    : route === 'receive'
      ? 'RECEIVE'
      : route === 'send'
        ? 'SEND'
        : 'GET SKR';

  const scrollShowsIndicator = Platform.OS === 'web';

  const renderSheetHeader = () => (
    <View style={s.header}>
      {route === 'main' ? (
        <LottieView
          source={require('@/assets/lottie/wallet.json')}
          style={s.headerLottie}
          autoPlay
          loop
          speed={0.6}
          colorFilters={wallet.connected ? [{ keypath: '*', color: '#E84545' }] : []}
        />
      ) : (
        <TouchableOpacity onPress={onTap(() => setRoute('main'))} style={s.backBtn} activeOpacity={0.7}>
          <Text style={s.backText}>‹</Text>
        </TouchableOpacity>
      )}
      <View style={{ flex: 1 }}>
        <Text style={s.heading}>{routeTitle}</Text>
        <Text style={s.headingSub}>
          {route === 'main'
            ? (wallet.connected ? 'Balances, sends, and top-ups' : 'Create or restore your Sakura account')
            : 'Secure action'}
        </Text>
      </View>
      <TouchableOpacity onPress={closeSheet} style={s.closeBtn} activeOpacity={0.7}>
        <Text style={s.closeX}>✕</Text>
      </TouchableOpacity>
    </View>
  );

  const renderSheetInner = () => {
    if (route === 'receive' && wallet.address) {
      return (
        <>
          {renderSheetHeader()}
          <ReceiveSheet address={wallet.address} onClose={onTap(() => setRoute('main'))} />
        </>
      );
    }
    if (route === 'send') {
      return (
        <>
          {renderSheetHeader()}
          <SendSheet
            solBalance={wallet.solBalance}
            sakuraBalance={wallet.sakuraBalance}
            walletAddress={wallet.address}
            onClose={onTap(() => setRoute('main'))}
            onComplete={() => { playTap(); setRoute('main'); wallet.refreshBalances(); }}
          />
        </>
      );
    }
    if (route === 'buy') {
      return (
        <>
          {renderSheetHeader()}
          <BuySakuraSheet
            solBalance={wallet.solBalance}
            walletAddress={wallet.address}
            onClose={onTap(() => setRoute('main'))}
            onComplete={() => { playTap(); setRoute('main'); wallet.refreshBalances(); }}
            onRefreshBalances={wallet.refreshBalances}
          />
        </>
      );
    }
    if (wallet.connected) {
      return (
        <>
          {renderSheetHeader()}
          <View style={s.connectedHero}>
            <View style={s.connectedHeroTop}>
              <Text style={s.connectTitle}>You're connected</Text>
              <View style={s.connectedBadgeRow}>
                <View style={s.connectedBadge}>
                  <Text style={s.connectedBadgeText}>CONNECTED</Text>
                </View>
                <View style={s.networkBadge}>
                  <Text style={s.networkBadgeText}>{getSolanaNetworkLabel()}</Text>
                </View>
              </View>
            </View>
            <Text style={s.connectSubtitle}>
              Send, receive, and top up without leaving Sakura.
            </Text>
          </View>

          <Text style={s.sectionLabel}>Account</Text>
          <View style={s.addressRow}>
            <Text style={s.addressText}>{wallet.shortAddress}</Text>
            <TouchableOpacity onPress={handleCopy} style={s.copyBtn} activeOpacity={0.7}>
              <CopyIcon />
              <Text style={s.copyLabel}>{copied ? 'Copied!' : 'Copy'}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.balanceRow}>
            <BalanceCard
              label="SOL Balance"
              value={wallet.solBalance !== null ? `${wallet.solBalance.toFixed(4)} SOL` : '—'}
              loading={wallet.loadingBalances}
            />
            <BalanceCard
              label="SAKURA"
              value={wallet.sakuraBalance !== null ? wallet.sakuraBalance.toLocaleString() : '—'}
              sub="SAKURA"
              loading={wallet.loadingBalances}
            />
          </View>

          <TouchableOpacity onPress={wallet.refreshBalances} style={s.refreshBtn} activeOpacity={0.7}>
            <RefreshIcon />
            <Text style={s.refreshText}>Refresh Balances</Text>
          </TouchableOpacity>

          {Platform.OS !== 'web' ? (
            <View style={s.balanceDebugWrap}>
              <Text style={s.balanceDebugTitle}>Connection details</Text>
              <Text style={s.balanceDebugLine}>RPC · {wallet.rpcLabel}</Text>
              <Text style={s.balanceDebugLine}>SKR source · {wallet.sakuraBalanceSource}</Text>
              {wallet.lastBalanceRefreshAt ? (
                <Text style={s.balanceDebugLine}>
                  Last refresh · {new Date(wallet.lastBalanceRefreshAt).toLocaleTimeString()}
                </Text>
              ) : null}
              {wallet.balanceError ? (
                <Text style={[s.balanceDebugLine, s.balanceDebugError]}>{wallet.balanceError}</Text>
              ) : null}
            </View>
          ) : null}

          <Text style={s.sectionLabel}>Quick Actions</Text>
          <View style={s.actionsRow}>
            <TouchableOpacity style={s.actionBtn} activeOpacity={0.8} onPress={onTap(() => setRoute('send'))}>
              <Text style={s.actionBtnIcon}>↑</Text>
              <Text style={s.actionBtnText}>Send</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} activeOpacity={0.8} onPress={onTap(() => setRoute('receive'))}>
              <Text style={s.actionBtnIcon}>↓</Text>
              <Text style={s.actionBtnText}>Receive</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.actionBtn, s.buyBtn]} activeOpacity={0.8} onPress={onTap(() => setRoute('buy'))}>
              <StarIcon />
              <Text style={[s.actionBtnText, { color: '#fff' }]}>Get SKR</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={handleDisconnect} style={s.disconnectBtn} activeOpacity={0.8}>
            <Text style={s.disconnectText}>Sign out on this device</Text>
          </TouchableOpacity>
        </>
      );
    }

    return (
      <>
        {renderSheetHeader()}
        <View style={s.tabs}>
          {(['create', 'import'] as Tab[]).map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => { setTab(t); setError(null); }}
              style={[s.tabBtn, tab === t && s.tabBtnActive]}
              activeOpacity={0.8}
            >
              <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                {t === 'create' ? 'Create Wallet' : 'Import Existing'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'create' ? (
          <View style={s.tabContent}>
            <View style={s.connectHero}>
              <Text style={s.connectTitle}>Set up in seconds</Text>
              <Text style={s.connectSubtitle}>
                {getWalletProtectionCopy()}
              </Text>
              <View style={s.tipsRow}>
                <View style={s.tipItem}><View style={s.tipDot} /><Text style={s.tipText}>Stays on this device</Text></View>
                <View style={s.tipItem}><View style={s.tipDot} /><Text style={s.tipText}>Quick approval for purchases</Text></View>
                <View style={s.tipItem}><View style={s.tipDot} /><Text style={s.tipText}>Back up your account in Settings</Text></View>
              </View>
            </View>
            <TouchableOpacity
              onPress={handleCreate}
              style={s.primaryBtn}
              disabled={wallet.connecting}
              activeOpacity={0.85}
            >
              {wallet.connecting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.primaryBtnText}>Create Wallet</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.tabContent}>
            <View style={s.connectHero}>
              <Text style={s.connectTitle}>Restore your account</Text>
              <Text style={s.connectSubtitle}>
                Paste your Base58 private key to connect the wallet you already use.
              </Text>
              <View style={s.warnBox}>
                <Text style={s.warnText}>
                  Security tip: only import keys from trusted backups. Never share your private key with anyone.
                </Text>
              </View>
            </View>
            <TextInput
              value={importKey}
              onChangeText={setImportKey}
              style={s.keyInput}
              placeholder="Enter your private key..."
              placeholderTextColor={colors.textTertiary}
              multiline
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={handleImport}
              style={[s.primaryBtn, !importKey.trim() && s.btnDisabled]}
              disabled={!importKey.trim() || wallet.connecting}
              activeOpacity={0.85}
            >
              {wallet.connecting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.primaryBtnText}>Import Wallet</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
        {error && <Text style={s.error}>{error}</Text>}
      </>
    );
  };

  if (!visible) return null;

  const sheetBody = renderSheetInner();

  if (Platform.OS === 'web') {
    return (
      <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
        <View style={webSheet.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" />
          <View style={[webSheet.card, { backgroundColor: colors.surface }]}>
            <View style={[webSheet.handle, { backgroundColor: colors.border }]} />
            <ScrollView
              key={route}
              contentContainerStyle={s.sheetInner}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              {sheetBody}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <BottomSheet
          ref={sheetRef}
          index={0}
          snapPoints={snapPoints}
          enableDynamicSizing={false}
          enablePanDownToClose
          onClose={onClose}
          backdropComponent={renderBackdrop}
          backgroundStyle={{ backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28 }}
          handleIndicatorStyle={{ backgroundColor: colors.border, width: 44, height: 5 }}
          keyboardBehavior="interactive"
        >
          <Animated.View
            key={route}
            entering={FadeInRight.duration(220)}
            exiting={FadeOutLeft.duration(170)}
            style={{ flex: 1, minHeight: 0 }}
          >
            <BottomSheetScrollView
              contentContainerStyle={s.sheetInner}
              showsVerticalScrollIndicator={scrollShowsIndicator}
              keyboardShouldPersistTaps="handled"
            >
              {sheetBody}
            </BottomSheetScrollView>
          </Animated.View>
        </BottomSheet>
      </View>
    </Modal>
  );
}
