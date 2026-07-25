import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path, Polygon } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { getWalletWithBiometrics } from '@/lib/wallet/storage';
import { getTransactionAuthLabel } from '@/lib/wallet/platform-labels';
import {
  MONTHLY_PASS_PRICE,
  PASS_DURATION_DAYS,
  getSolanaNetworkLabel,
} from '@/lib/wallet/config';
import {
  checkPassStatus,
  purchaseMonthlyPass,
  getPassExpiryDate,
  formatPassTimeRemaining,
  type PassStatus,
} from '@/lib/wallet/pass';
import { setPassExpiresAtOnServer } from '@/lib/push-tokens';
import WalletModal from '@/components/wallet/WalletModal';
import { playTap, onTap } from '@/lib/sound';

const ACCENT = '#5856D6';

const BackIcon = ({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const LockIcon = ({ color, size = 30 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M6 10V8a6 6 0 1 1 12 0v2M5 10h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

const CheckIcon = ({ color, size = 16 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M20 6L9 17l-5-5" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const SakuraIcon = ({ size = 18 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Polygon
      points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
      fill="#F5A623"
    />
  </Svg>
);

// Keep this list strictly true. It used to lead with "read the latest chapters
// the moment they drop" and "unlock every premium chapter across the library",
// both of which described the blanket auto-gating rule that has since been
// removed (see lib/pass-gate.ts). The pass currently gates no content, so
// advertising unlocks would be selling something the app does not do. The
// unlock perk comes back when work_releases.access_tier ships and creators can
// opt their paid chapters into the pass.
const PERKS = [
  `${PASS_DURATION_DAYS} days of Sakura Pass — renew anytime`,
  'Pass-holder badge on your profile',
  'Supports Sakura and the creators building on it',
];

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

type PurchaseStep = 'idle' | 'purchasing' | 'done' | 'error';

export default function PassScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const wallet = useWallet();

  const [status, setStatus] = useState<PassStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState<PurchaseStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);

  const previewExpiry = useMemo(() => getPassExpiryDate(), []);
  const hasEnoughSakura = (wallet.sakuraBalance ?? 0) >= MONTHLY_PASS_PRICE;

  const refreshStatus = useCallback(async () => {
    if (!wallet.address) {
      setStatus(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const result = await checkPassStatus(wallet.address).catch(() => ({ valid: false } as PassStatus));
    setStatus(result);
    setChecking(false);
  }, [wallet.address]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useFocusEffect(
    useCallback(() => {
      void wallet.refreshBalances?.();
    }, [wallet]),
  );

  const handlePurchase = async () => {
    if (!wallet.connected) {
      setWalletOpen(true);
      return;
    }
    if (!hasEnoughSakura) {
      setWalletOpen(true);
      return;
    }
    playTap();
    setStep('purchasing');
    setError(null);
    try {
      const keypair = await getWalletWithBiometrics();
      if (!keypair) throw new Error('Could not unlock your wallet.');
      const result = await purchaseMonthlyPass(keypair);
      if (!result.success) throw new Error(result.error || 'Payment failed');
      setTxid(result.signature ?? null);
      setStep('done');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Record the new expiry against the push registration. Without this the
      // renewal reminder cron never learns about a pass bought here -- the only
      // other writer is the settings screen -- so a fresh purchase would expire
      // with no warning. Best-effort: a failure here must not fail the purchase.
      if (result.expiresAt) {
        await setPassExpiresAtOnServer(wallet.address, result.expiresAt.toISOString()).catch(
          () => {},
        );
      }
      await wallet.refreshBalances?.();
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed');
      setStep('error');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const s = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.background },
        topBar: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingBottom: 8,
          gap: 12,
        },
        circleBtn: {
          width: 38,
          height: 38,
          borderRadius: 19,
          backgroundColor: colors.surfaceSecondary,
          alignItems: 'center',
          justifyContent: 'center',
        },
        topTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
        content: { padding: 20, paddingBottom: 40, gap: 18 },
        hero: {
          alignItems: 'center',
          gap: 12,
          paddingVertical: 14,
        },
        heroIcon: {
          width: 84,
          height: 84,
          borderRadius: 42,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: `${ACCENT}22`,
          borderWidth: 1,
          borderColor: `${ACCENT}55`,
        },
        heroTitle: {
          fontSize: 26,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          color: colors.text,
          textAlign: 'center',
        },
        heroSub: {
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          textAlign: 'center',
          lineHeight: 21,
          paddingHorizontal: 12,
        },
        card: {
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.lg,
          borderWidth: 1,
          borderColor: colors.borderLight,
          padding: 18,
          gap: 14,
        },
        priceRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
        priceVal: {
          fontSize: 34,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          color: colors.text,
        },
        priceUnit: { fontSize: FontSize.md, color: colors.textSecondary, fontWeight: FontWeight.semibold, marginBottom: 6 },
        priceSub: { fontSize: FontSize.xs, color: colors.textTertiary },
        divider: { height: 1, backgroundColor: colors.border },
        perkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        perkCheck: {
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: `${ACCENT}22`,
          alignItems: 'center',
          justifyContent: 'center',
        },
        perkText: { flex: 1, fontSize: FontSize.sm, color: colors.text, lineHeight: 19 },
        metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
        metaLabel: { fontSize: FontSize.sm, color: colors.textSecondary },
        metaVal: { fontSize: FontSize.sm, color: colors.text, fontWeight: FontWeight.semibold },
        statusBox: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: '#34C7591A',
          borderWidth: 1,
          borderColor: '#34C75955',
          borderRadius: Radius.md,
          padding: 14,
        },
        statusText: { flex: 1, fontSize: FontSize.sm, color: colors.text, fontWeight: FontWeight.semibold },
        cta: {
          backgroundColor: ACCENT,
          borderRadius: Radius.full,
          paddingVertical: 16,
          alignItems: 'center',
          shadowColor: ACCENT,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 12,
          elevation: 5,
        },
        ctaDisabled: { opacity: 0.55 },
        ctaText: {
          color: '#fff',
          fontSize: FontSize.md,
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          letterSpacing: 0.3,
        },
        secondaryBtn: { paddingVertical: 12, alignItems: 'center' },
        secondaryText: { color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
        link: { color: ACCENT, fontSize: FontSize.sm, textAlign: 'center', textDecorationLine: 'underline' },
        error: { color: '#FF3B30', fontSize: FontSize.sm, textAlign: 'center' },
        hint: { fontSize: FontSize.xs, color: colors.textTertiary, textAlign: 'center' },
      }),
    [colors],
  );

  const passValid = status?.valid ?? false;

  return (
    <View style={[s.screen, { paddingTop: insets.top + 6 }]}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={onTap(() => router.back())} style={s.circleBtn} activeOpacity={0.8}>
          <BackIcon color={colors.text} />
        </TouchableOpacity>
        <Text style={s.topTitle}>Monthly Pass</Text>
      </View>

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.hero}>
          <View style={s.heroIcon}>
            <LockIcon color={ACCENT} size={34} />
          </View>
          <Text style={s.heroTitle}>Sakura Monthly Pass</Text>
          <Text style={s.heroSub}>
            Unlock the newest chapters across every series and support creators with SKR.
          </Text>
        </View>

        {checking ? (
          <ActivityIndicator color={ACCENT} style={{ marginVertical: 12 }} />
        ) : passValid ? (
          <View style={s.statusBox}>
            <CheckIcon color="#2DB24A" size={20} />
            <Text style={s.statusText}>
              {status?.source === 'whale'
                ? "You're an SKR holder — lifetime access unlocked!"
                : `Pass active${status?.expiresAt ? ` · ${formatPassTimeRemaining(status.expiresAt)}` : ''}`}
            </Text>
          </View>
        ) : null}

        <View style={s.card}>
          <View style={s.priceRow}>
            <SakuraIcon size={22} />
            <Text style={s.priceVal}>{MONTHLY_PASS_PRICE}</Text>
            <Text style={s.priceUnit}>SKR</Text>
          </View>
          <Text style={s.priceSub}>{PASS_DURATION_DAYS} days of full access · {getSolanaNetworkLabel()}</Text>

          <View style={s.divider} />

          {PERKS.map((perk) => (
            <View style={s.perkRow} key={perk}>
              <View style={s.perkCheck}>
                <CheckIcon color={ACCENT} size={13} />
              </View>
              <Text style={s.perkText}>{perk}</Text>
            </View>
          ))}

          <View style={s.divider} />

          <View style={s.metaRow}>
            <Text style={s.metaLabel}>Your SKR balance</Text>
            <Text style={s.metaVal}>
              {wallet.connected
                ? wallet.sakuraBalance !== null
                  ? wallet.sakuraBalance.toLocaleString()
                  : '—'
                : 'Not connected'}
            </Text>
          </View>
          <View style={s.metaRow}>
            <Text style={s.metaLabel}>New expiry</Text>
            <Text style={s.metaVal}>{formatDate(previewExpiry)}</Text>
          </View>
        </View>

        {error ? <Text style={s.error}>{error}</Text> : null}

        {step === 'done' ? (
          <>
            {txid ? (
              <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${txid}`)} activeOpacity={0.7}>
                <Text style={s.link}>View receipt on Solscan ↗</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={s.cta} activeOpacity={0.85} onPress={onTap(() => router.back())}>
              <Text style={s.ctaText}>Start Reading</Text>
            </TouchableOpacity>
          </>
        ) : passValid ? (
          <TouchableOpacity style={s.cta} activeOpacity={0.85} onPress={onTap(() => router.back())}>
            <Text style={s.ctaText}>Back to Reading</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[s.cta, step === 'purchasing' && s.ctaDisabled]}
              activeOpacity={0.85}
              onPress={handlePurchase}
              disabled={step === 'purchasing'}
            >
              {step === 'purchasing' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.ctaText}>
                  {!wallet.connected
                    ? 'Connect account'
                    : !hasEnoughSakura
                      ? 'Get SKR'
                      : getTransactionAuthLabel('purchase')}
                </Text>
              )}
            </TouchableOpacity>
            {wallet.connected && !hasEnoughSakura ? (
              <Text style={s.hint}>
                You need at least {MONTHLY_PASS_PRICE} SKR. Tap above to top up or swap into SKR.
              </Text>
            ) : null}
          </>
        )}

        <TouchableOpacity onPress={onTap(() => router.back())} style={s.secondaryBtn} activeOpacity={0.7}>
          <Text style={s.secondaryText}>Maybe later</Text>
        </TouchableOpacity>
      </ScrollView>

      <WalletModal
        visible={walletOpen}
        onClose={() => {
          setWalletOpen(false);
          void wallet.refreshBalances?.();
          void refreshStatus();
        }}
      />
    </View>
  );
}
