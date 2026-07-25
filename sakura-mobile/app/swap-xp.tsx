import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Path, Polygon } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { onTap, playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { getWalletWithBiometrics } from '@/lib/wallet/storage';
import { getPassiveSessionKeypair } from '@/lib/wallet/app-session';
import { fetchGamificationState, type GamificationState } from '@/lib/gamification';
import {
  redeemXp,
  fetchRedemptions,
  previewSakura,
  XP_SAKURA_RATE,
  XP_REDEEM_MIN,
  type XpRedemption,
} from '@/lib/xp-redeem';
import { Spacing, Radius, FontSize, FontWeight, Fonts, Shadow } from '@/constants/theme';

const ACCENT = '#E84545';

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** The same diamond that marks SKR in the wallet pill. */
function SakuraMark({ size = 16, color = '#F5A623' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Polygon points="12 2 20 12 12 22 4 12" fill={color} />
    </Svg>
  );
}

/** XP is marked with a four-point spark, distinct from the SKR diamond. */
function SparkMark({ size = 16, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 2c.6 4.8 2.6 6.8 7.4 7.4-4.8.6-6.8 2.6-7.4 7.4-.6-4.8-2.6-6.8-7.4-7.4C9.4 8.8 11.4 6.8 12 2Z" fill={color} />
      <Path d="M18.5 15c.3 2.2 1.2 3.1 3.5 3.5-2.3.3-3.2 1.3-3.5 3.5-.3-2.2-1.2-3.2-3.5-3.5 2.3-.4 3.2-1.3 3.5-3.5Z" fill={color} opacity={0.7} />
    </Svg>
  );
}

function ArrowDown({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M6 13l6 6 6-6" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function statusLabel(status: XpRedemption['status']): string {
  if (status === 'sent') return 'Delivered';
  // 'failed' returns the XP, so say what the user got back rather than that
  // something broke — from their side nothing was lost.
  if (status === 'failed') return 'XP refunded';
  return 'Queued';
}

export default function SwapXpScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address, connected, refreshBalances } = useWallet();

  const [state, setState] = useState<GamificationState | null>(null);
  const [history, setHistory] = useState<XpRedemption[]>([]);
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ xp: number; sakura: number } | null>(null);

  const spendable = Math.max(0, (state?.xp ?? 0) - (state?.xp_spent ?? 0));
  const preview = previewSakura(amount);
  const canSwap = connected && amount >= XP_REDEEM_MIN && amount <= spendable && !busy;

  const refresh = useCallback(() => {
    if (!address) return;
    fetchGamificationState(address).then((s) => {
      if (!s) return;
      setState(s);
      // Default to the whole balance; most people are cashing out, not tuning.
      setAmount((prev) => (prev === 0 ? Math.max(0, s.xp - (s.xp_spent ?? 0)) : prev));
    });
  }, [address]);

  // Passive on purpose: history is a nicety, and prompting for the wallet just
  // to draw a list would be the same mistake the launch prompt was. It fills in
  // once any real wallet action has warmed the session.
  //
  // Declared above the focus effect that lists it as a dependency — dependency
  // arrays are evaluated during render, so a later const would be in its TDZ.
  const loadHistory = useCallback(async () => {
    try {
      const keypair = await getPassiveSessionKeypair();
      if (keypair) setHistory(await fetchRedemptions(keypair));
    } catch {
      // never block the screen on it
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
      void loadHistory();
    }, [refresh, loadHistory]),
  );

  const setFraction = (f: number) => {
    playTap();
    setError(null);
    setAmount(Math.floor(spendable * f));
  };

  const handleSwap = async () => {
    if (!canSwap) return;
    playTap();
    setBusy(true);
    setError(null);
    try {
      const keypair = await getWalletWithBiometrics();
      if (!keypair) throw new Error('Could not unlock your wallet.');
      const result = await redeemXp(keypair, amount);
      setDone({ xp: result.xp_spent, sakura: result.sakura });
      setAmount(0);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refresh();
      void loadHistory();
      void refreshBalances?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Swap failed.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  const s = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={s.screen}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={onTap(() => router.back())} style={s.iconBtn}>
            <BackIcon color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Swap XP</Text>
          <View style={s.iconBtn} />
        </View>

        <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
          {/* Balance hero */}
          <LinearGradient
            colors={['#2A1216', '#1A1014']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.hero}
          >
            <View style={s.heroTopRow}>
              <SparkMark size={15} color={ACCENT} />
              <Text style={s.heroLabel}>Swappable XP</Text>
            </View>
            <Text style={s.heroValue}>{spendable.toLocaleString()}</Text>
            <View style={s.rateRow}>
              <Text style={s.rateText}>1 XP</Text>
              <View style={s.rateDot} />
              <SakuraMark size={13} />
              <Text style={s.rateText}>{XP_SAKURA_RATE} SAKURA</Text>
            </View>
          </LinearGradient>

          {/* Amount */}
          <View style={s.card}>
            <Text style={s.cardLabel}>You spend</Text>
            <View style={s.amountRow}>
              <SparkMark size={20} color={ACCENT} />
              <Text style={s.amountValue}>{amount.toLocaleString()}</Text>
              <Text style={s.amountUnit}>XP</Text>
            </View>

            <View style={s.chips}>
              {[
                { label: '25%', f: 0.25 },
                { label: '50%', f: 0.5 },
                { label: 'Max', f: 1 },
              ].map((c) => (
                <TouchableOpacity key={c.label} style={s.chip} activeOpacity={0.8} onPress={() => setFraction(c.f)}>
                  <Text style={s.chipText}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.divider}>
              <View style={s.dividerLine} />
              <View style={s.dividerIcon}>
                <ArrowDown color={colors.textSecondary} />
              </View>
              <View style={s.dividerLine} />
            </View>

            <Text style={s.cardLabel}>You receive</Text>
            <View style={s.amountRow}>
              <SakuraMark size={20} />
              <Text style={[s.amountValue, { color: '#F5A623' }]}>
                {preview.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </Text>
              <Text style={s.amountUnit}>SAKURA</Text>
            </View>
          </View>

          {/* Set expectations before they commit, not after. Deliberately
              promises no timeframe: swaps are settled by a separate process, so
              any "in N minutes" here would be a claim this screen cannot keep. */}
          <View style={s.notice}>
            <Text style={s.noticeTitle}>Swaps are queued</Text>
            <Text style={s.noticeBody}>
              Your XP is spent as soon as you confirm, and the SAKURA is sent to this wallet once
              the swap is processed — not instantly. Track it under Recent swaps below. Minimum{' '}
              {XP_REDEEM_MIN} XP.
            </Text>
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}
          {done ? (
            <Text style={s.success}>
              Queued — {done.xp.toLocaleString()} XP for{' '}
              {done.sakura.toLocaleString(undefined, { maximumFractionDigits: 2 })} SAKURA. It will
              arrive in this wallet once processed.
            </Text>
          ) : null}

          <TouchableOpacity
            style={[s.cta, !canSwap && s.ctaDisabled]}
            activeOpacity={0.88}
            disabled={!canSwap}
            onPress={handleSwap}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.ctaText}>
                {!connected
                  ? 'Connect your wallet'
                  : spendable < XP_REDEEM_MIN
                    ? `Earn ${XP_REDEEM_MIN} XP to swap`
                    : amount < XP_REDEEM_MIN
                      ? `Minimum ${XP_REDEEM_MIN} XP`
                      : 'Queue swap'}
              </Text>
            )}
          </TouchableOpacity>

          {history.length > 0 ? (
            <View style={s.historyWrap}>
              <Text style={s.sectionTitle}>Recent swaps</Text>
              {history.map((h) => (
                <View key={h.id} style={s.historyRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.historyAmount}>
                      {Number(h.xp_spent).toLocaleString()} XP →{' '}
                      {Number(h.sakura_amount).toLocaleString(undefined, { maximumFractionDigits: 2 })} SAKURA
                    </Text>
                    <Text style={s.historyDate}>
                      {new Date(h.created_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </Text>
                  </View>
                  <View
                    style={[
                      s.pill,
                      h.status === 'sent' && s.pillSent,
                      h.status === 'failed' && s.pillFailed,
                    ]}
                  >
                    <Text
                      style={[
                        s.pillText,
                        h.status === 'sent' && { color: '#37D67A' },
                        h.status === 'failed' && { color: colors.textSecondary },
                      ]}
                    >
                      {statusLabel(h.status)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
    },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    headerTitle: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.lg,
      color: colors.text,
    },
    body: { paddingHorizontal: Spacing.md, gap: Spacing.md },

    hero: {
      borderRadius: 26,
      padding: 22,
      borderWidth: 1,
      borderColor: 'rgba(232,69,69,0.22)',
      ...Shadow.card,
    },
    heroTopRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    heroLabel: {
      color: 'rgba(255,255,255,0.62)',
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    heroValue: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: 46,
      color: '#fff',
      marginTop: 6,
    },
    rateRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10 },
    rateText: { color: 'rgba(255,255,255,0.72)', fontSize: FontSize.sm, fontWeight: FontWeight.medium },
    rateDot: { width: 14, height: 1.5, backgroundColor: 'rgba(255,255,255,0.35)' },

    card: {
      backgroundColor: colors.surface,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.borderLight,
      padding: 18,
    },
    cardLabel: {
      color: colors.textSecondary,
      fontSize: FontSize.xs,
      fontWeight: FontWeight.semibold,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    amountRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 8 },
    amountValue: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: 30,
      color: colors.text,
    },
    amountUnit: { color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

    chips: { flexDirection: 'row', gap: 8, marginTop: 14 },
    chip: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: Radius.full,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    chipText: { color: colors.text, fontSize: FontSize.xs, fontWeight: FontWeight.semibold },

    divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 18 },
    dividerLine: { flex: 1, height: 1, backgroundColor: colors.borderLight },
    dividerIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceSecondary,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },

    notice: {
      backgroundColor: colors.surfaceSecondary,
      borderRadius: 18,
      padding: 14,
      borderLeftWidth: 3,
      borderLeftColor: ACCENT,
    },
    noticeTitle: { color: colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
    noticeBody: { color: colors.textSecondary, fontSize: FontSize.xs, lineHeight: 18, marginTop: 4 },

    error: { color: ACCENT, fontSize: FontSize.sm, textAlign: 'center' },
    success: { color: '#37D67A', fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 },

    cta: {
      backgroundColor: ACCENT,
      borderRadius: Radius.full,
      paddingVertical: 16,
      alignItems: 'center',
      ...Shadow.card,
    },
    ctaDisabled: { opacity: 0.4 },
    ctaText: {
      color: '#fff',
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.md,
    },

    historyWrap: { gap: 8, marginTop: 8 },
    sectionTitle: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.md,
      color: colors.text,
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.borderLight,
      padding: 13,
    },
    historyAmount: { color: colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
    historyDate: { color: colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },
    pill: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: Radius.full,
      backgroundColor: `${ACCENT}1E`,
    },
    pillSent: { backgroundColor: 'rgba(55,214,122,0.14)' },
    pillFailed: { backgroundColor: 'rgba(127,127,127,0.16)' },
    pillText: { fontSize: 11, fontWeight: FontWeight.bold, color: ACCENT },
  });
}
