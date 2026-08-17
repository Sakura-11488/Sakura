import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { useScrollToTop } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Svg, { Path, Circle } from 'react-native-svg';
import SakuraLottie from '@/components/ui/SakuraLottie';
import { useTheme } from '@/lib/theme';
import { Spacing, Radius, FontSize, FontWeight, Shadow, Fonts } from '@/constants/theme';
import { useWallet } from '@/lib/wallet/context';
import { fetchGamificationState } from '@/lib/gamification';
import {
  hasSakuraAiAccess,
  SAKURA_AI_MIN_HOLDING,
  SAKURA_AI_MIN_XP,
  formatSakuraAiRequirement,
} from '@/lib/wallet/sakura-ai-access';
import { useFocusEffect } from 'expo-router';
import { getProfile } from '@/lib/supabase';
import { getCreatorProfile, getCreatorWorks } from '@/lib/creator';
import { Library } from '@/lib/storage';
import { ShimmerBox } from '@/components/ui/ShimmerLoader';
import WalletModal, { type WalletSheetRoute } from '@/components/wallet/WalletModal';
import { getForgeFundsStatus, getForgeFundsMessage } from '@/lib/avatar-forge-funds';
import {
  clearPendingAvatarPayment,
  getPendingAvatarPayment,
  savePendingAvatarPayment,
} from '@/lib/avatar-forge-payment';
import { showAlert } from '@/lib/confirm-alert';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import { onTap } from '@/lib/sound';
import { sendSakura } from '@/lib/wallet/connection';
import {
  AVATAR_MINT_PRICE_SAKURA,
  AVATAR_PAYMENT_WALLET,
  formatAvatarMintPrice,
  solanaExplorerToken,
  solanaExplorerTx,
} from '@/lib/wallet/config';
import { getAvatarMintAuthPrompt } from '@/lib/wallet/platform-labels';
import { saveProfileImageToDevice } from '@/lib/download-profile-image';
import {
  buildAvatarAuthHeaders,
  fetchAvatarMintEligibility,
  generateUserAvatar,
  listAvatarMints,
  resolveAvatarUri,
  selectAvatarMint,
  type AvatarMintItem,
} from '@/lib/user-avatar';
import AvatarMintPickerModal from '@/components/social/AvatarMintPickerModal';
import AvatarActionSheet, { type ActionSheetAction } from '@/components/social/AvatarActionSheet';

interface Stats { watching: number; reading: number; saved: number }

function ChevronRight({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function AIRow({ colors }: { colors: any }) {
  const { address, connected, sakuraBalance, refreshBalances, loadingBalances } = useWallet();
  const [lifetimeXp, setLifetimeXp] = useState<number | null>(null);
  const hasAccess = hasSakuraAiAccess(connected, sakuraBalance, lifetimeXp);

  useFocusEffect(
    useCallback(() => {
      if (!connected) return;
      refreshBalances();
      if (address) fetchGamificationState(address).then((g) => setLifetimeXp(g?.xp ?? 0)).catch(() => {});
    }, [connected, refreshBalances, address]),
  );

  const balanceLabel =
    !connected
      ? `Hold ${formatSakuraAiRequirement()} or read to Level 5`
      : loadingBalances && sakuraBalance === null
        ? 'Checking SKR balance…'
        : hasAccess
          ? 'Unlocked · Your on-screen companion'
          : `${(sakuraBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${SAKURA_AI_MIN_HOLDING.toLocaleString()} SKR · ${(lifetimeXp ?? 0).toLocaleString()} / ${SAKURA_AI_MIN_XP.toLocaleString()} XP`;

  return (
    <TouchableOpacity
      style={[row.base, { backgroundColor: colors.surface }, row.walletRow]}
      onPress={onTap(() => router.push('/ai'))}
      activeOpacity={0.7}
    >
      <View style={row.left}>
        <View style={[row.lottieBadge, { borderColor: `${colors.primary}40` }]}>
          <SakuraLottie
            source={require('@/assets/lottie/AI.json')}
            style={row.lottie}
            autoPlay
            loop
            speed={0.7}
          />
        </View>
        <View style={row.textCol}>
          <Text style={[row.label, { color: colors.text }]}>Sakura AI</Text>
          <Text style={[row.sub, { color: colors.textSecondary }]} numberOfLines={1}>
            {balanceLabel}
          </Text>
        </View>
      </View>
      <View
        style={[
          row.betaChip,
          {
            backgroundColor: `${colors.primary}16`,
            borderColor: `${colors.primary}40`,
          },
        ]}
      >
        <Text style={[row.betaText, { color: colors.primary }]}>BETA</Text>
      </View>
    </TouchableOpacity>
  );
}

function WalletRow({ onPress, colors }: { onPress: () => void; colors: any }) {
  const { connected, shortAddress, sakuraBalance } = useWallet();

  return (
    <TouchableOpacity
      style={[row.base, { backgroundColor: colors.surface }, row.walletRow]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={row.left}>
        <View style={[row.lottieBadge, connected && { backgroundColor: colors.primary, borderColor: colors.primary }, !connected && { backgroundColor: `${colors.primary}18`, borderColor: `${colors.primary}40` }]}>
          <SakuraLottie
            key={connected ? 'wallet-connected' : 'wallet-disconnected'}
            source={require('@/assets/lottie/wallet.json')}
            style={row.lottie}
            autoPlay
            loop
            speed={0.6}
          />
        </View>
        <View>
          <Text style={[row.label, { color: colors.text }]}>
            {connected ? 'Sakura Account' : 'Connect Account'}
          </Text>
          {connected && (
            <Text style={[row.sub, { color: colors.primary }]}>
              {sakuraBalance !== null
                ? `${sakuraBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} SKR  ·  ${shortAddress}`
                : shortAddress ?? ''}
            </Text>
          )}
        </View>
      </View>
      <ChevronRight color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

function MenuRow({ label, icon, onPress, last, colors }: {
  label: string; icon: React.ReactNode; onPress?: () => void; last?: boolean; colors: any;
}) {
  return (
    <TouchableOpacity
      style={[
        row.base,
        { backgroundColor: colors.surface },
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={row.left}>
        {icon}
        <Text style={[row.label, { color: colors.text }]}>{label}</Text>
      </View>
      <ChevronRight color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

function IconBadge({ bg: _bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: '#5A6272', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  );
}

const DownloadsIcon = ({ color }: { color: string }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
    <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

function CreatorRow({ colors }: { colors: any }) {
  const { connected, address } = useWallet();
  const [isCreator, setIsCreator] = useState(false);
  const [creatorHandle, setCreatorHandle] = useState<string | null>(null);
  const [workCount, setWorkCount] = useState(0);
  const [checking, setChecking] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!connected || !address) {
        setIsCreator(false);
        setCreatorHandle(null);
        setWorkCount(0);
        return;
      }
      setChecking(true);
      Promise.all([getCreatorProfile(address), getCreatorWorks(address)])
        .then(([profile, works]) => {
          setIsCreator(Boolean(profile.username));
          setCreatorHandle(profile.username?.username ?? null);
          setWorkCount(works.length);
        })
        .catch(() => {
          setIsCreator(false);
          setCreatorHandle(null);
          setWorkCount(0);
        })
        .finally(() => setChecking(false));
    }, [connected, address]),
  );

  const route = isCreator ? '/creator-dashboard' : '/become-creator';
  const title = isCreator ? 'Creator Dashboard' : 'Become a Creator';
  const subtitle = !connected
    ? 'Connect your account to get started'
    : checking
      ? 'Loading creator status…'
      : isCreator
        ? creatorHandle
          ? `@${creatorHandle}${workCount > 0 ? ` · ${workCount} work${workCount === 1 ? '' : 's'}` : ''}`
          : 'Manage your published works'
        : 'Publish novels, manga & anime';

  return (
    <TouchableOpacity
      style={[row.base, { backgroundColor: colors.surface }, row.walletRow]}
      onPress={onTap(() => router.push(route))}
      activeOpacity={0.7}
    >
      <View style={row.left}>
        <View style={[row.lottieBadge, { backgroundColor: `${colors.primary}14`, borderColor: `${colors.primary}35` }]}>
          <SakuraLottie
            source={require('@/assets/lottie/write.json')}
            style={row.lottie}
            autoPlay
            loop
            speed={0.85}
          />
        </View>
        <View style={row.textCol}>
          <Text style={[row.label, { color: colors.text }]}>{title}</Text>
          {checking ? (
            <ShimmerBox width={160} height={12} borderRadius={4} style={{ marginTop: 4 }} />
          ) : (
            <Text style={[row.sub, { color: colors.textSecondary }]} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
      </View>
      <ChevronRight color={colors.textTertiary} />
    </TouchableOpacity>
  );
}
const HistoryIcon = ({ color }: { color: string }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
    <Path d="M12 8v4l3 3" stroke={color} strokeWidth={2} strokeLinecap="round" />
    <Path d="M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const LibraryIcon = ({ color }: { color: string }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
    <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const SettingsIcon = ({ color }: { color: string }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24">
    <Path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill={color} />
  </Svg>
);

export default function ProfileScreen() {
  const [walletVisible, setWalletVisible] = useState(false);
  const [walletInitialRoute, setWalletInitialRoute] = useState<WalletSheetRoute>('main');
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarSeed, setAvatarSeed] = useState('guest');
  const [avatarMintAddress, setAvatarMintAddress] = useState<string | null>(null);
  const [avatarMints, setAvatarMints] = useState<AvatarMintItem[]>([]);
  const [avatarPickerVisible, setAvatarPickerVisible] = useState(false);
  const [avatarSheet, setAvatarSheet] = useState<{
    title: string;
    message?: string;
    actions: ActionSheetAction[];
  } | null>(null);
  const [selectingMintId, setSelectingMintId] = useState<string | null>(null);
  const [loadingAvatarMints, setLoadingAvatarMints] = useState(false);
  /** Free avatars this wallet is owed. Read from eligibility, never assumed. */
  const [avatarFreeCredits, setAvatarFreeCredits] = useState(0);
  const [downloadingAvatar, setDownloadingAvatar] = useState(false);
  const [sakuraHandle, setSakuraHandle] = useState<string | null>(null);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [stats, setStats] = useState<Stats>({ watching: 0, reading: 0, saved: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const { colors } = useTheme();
  const { address, connected, shortAddress, sakuraBalance, solBalance, signWithBiometrics, unlockForAppSession } = useWallet();
  const scrollRef = useRef<any>(null);
  useScrollToTop(scrollRef);

  const loadProfile = useCallback(async () => {
    if (!address) {
      setDisplayName('');
      setAvatarUrl(null);
      setAvatarSeed('guest');
      setAvatarMintAddress(null);
      setSakuraHandle(null);
      return;
    }
    try {
      const [p, creator] = await Promise.all([
        getProfile(address),
        getCreatorProfile(address).catch(() => null),
      ]);
      setDisplayName(p?.display_name ?? '');
      setAvatarUrl(p?.avatar_url ?? null);
      setAvatarSeed(p?.avatar_seed ?? address.slice(0, 8));
      setAvatarMintAddress(p?.avatar_mint_address ?? null);
      setSakuraHandle(creator?.username?.username ?? null);
    } catch {
      setDisplayName('');
      setAvatarUrl(null);
      setAvatarSeed(address.slice(0, 8));
      setAvatarMintAddress(null);
      setSakuraHandle(null);
    }
  }, [address]);

  useFocusEffect(
    useCallback(() => {
      loadProfile();
    }, [loadProfile]),
  );

  const loadStats = useCallback(async () => {
    try {
      const items = await Library.getAll();
      const watching = items.filter((i) => i.type === 'anime').length;
      const reading = items.filter((i) => i.type === 'manga' || i.type === 'novel').length;
      setStats({ watching, reading, saved: items.length });
    } catch {
      setStats({ watching: 0, reading: 0, saved: 0 });
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadStats(), loadProfile()]);
    setRefreshing(false);
  }, [loadStats, loadProfile]);

  useEffect(() => { loadStats(); }, [loadStats]);

  const openWalletBuy = useCallback(() => {
    setWalletInitialRoute('buy');
    setWalletVisible(true);
  }, []);

  const showForgeFundsGuide = useCallback(() => {
    setAvatarSheet({
      title: 'Need SKR and SOL',
      message: getForgeFundsMessage(),
      actions: [
        { id: 'buy', label: 'Open wallet', onPress: openWalletBuy },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
  }, [openWalletBuy]);

  const handleGenerateAvatar = useCallback(async (
    mode: 'tastes' | 'general',
    opts?: { promisedFree?: boolean },
  ) => {
    if (!address || !connected) {
      showAlert('Connect your account', 'Sign in to forge your Sakura avatar.');
      setWalletVisible(true);
      return;
    }

    setGeneratingAvatar(true);
    let paymentTxSignature: string | null = null;
    try {
      // A free forge moves no money, so it must not raise a payment-grade
      // biometric prompt — four of them in a row for four gifts would be absurd.
      // Unlock the session (silent when already cached), decide what this forge
      // actually is, and only then ask for the money-moving approval.
      const sessionKeypair = await unlockForAppSession();
      if (!sessionKeypair) {
        showAlert('Confirm to continue', getAvatarMintAuthPrompt());
        return;
      }
      let keypair = sessionKeypair;

      // A real pending payment always outranks a free credit: otherwise a
      // paid-for-but-unforged mint is stranded behind the freebies while its
      // signature sits unclaimed on chain.
      const pendingPayment = await getPendingAvatarPayment(address);
      const forgeMode = pendingPayment?.mode ?? mode;

      // The eligibility gate exists so we never charge for a mint the server will
      // refuse. It must NOT gate a RESUME: that payment already left the wallet,
      // the server reuses the row keyed on its signature, and it can never yield
      // a second avatar. Gating it here is exactly how a paid-for forge became
      // unreachable for 24h behind the words "No SKR was charged".
      const eligibility = pendingPayment
        ? null
        : await fetchAvatarMintEligibility(buildAvatarAuthHeaders(sessionKeypair));

      // Free avatars this wallet is owed after being charged and given nothing.
      // Checked BEFORE the funds guide and before the rate-limit gate: a credit
      // needs no SAKURA and no SOL (the server's mint authority pays the network
      // fee) and is exempt from the 24h limit server-side.
      const freeCredits = eligibility?.free_credits ?? 0;
      setAvatarFreeCredits(freeCredits);

      // He tapped a dialog that said "costs no SKR". If the credit has since gone
      // — forged on another device, in flight, or paused — we must NEVER fall
      // through to sendSakura. Silently relabelling free as 100,000 SAKURA is the
      // original incident's exact shape.
      if (opts?.promisedFree && !pendingPayment && freeCredits <= 0) {
        showAlert(
          'That free avatar is not available',
          'It looks like it was already forged, or is being forged right now. Nothing was charged. Tap your profile picture again to see where it got to.',
        );
        return;
      }

      if (!pendingPayment && freeCredits <= 0) {
        const funds = getForgeFundsStatus(solBalance, sakuraBalance);
        if (!funds.ok) {
          showForgeFundsGuide();
          return;
        }
      }

      if (eligibility && freeCredits <= 0 && !eligibility.can_mint) {
        showAlert(
          'Mint not available yet',
          eligibility.retry_after_hours > 0
            ? `You can forge again in about ${eligibility.retry_after_hours} hour(s). No SKR was charged.`
            : 'Avatar minting is not available for this wallet right now.',
        );
        return;
      }

      if (pendingPayment) {
        paymentTxSignature = pendingPayment.paymentTxSignature;
      } else if (freeCredits > 0) {
        // Deliberately no sendSakura and no savePendingAvatarPayment: there is no
        // payment to make and none to resume, and a pending-payment record here
        // would later offer to "resume" a payment that never existed.
        paymentTxSignature = null;
      } else {
        // The one path where money moves, and the only one that asks for a
        // payment-grade approval.
        const payingKeypair = await signWithBiometrics();
        if (!payingKeypair) {
          showAlert('Confirm to continue', getAvatarMintAuthPrompt());
          return;
        }
        keypair = payingKeypair;
        paymentTxSignature = await sendSakura(payingKeypair, AVATAR_PAYMENT_WALLET, AVATAR_MINT_PRICE_SAKURA);
        await savePendingAvatarPayment({
          walletAddress: address,
          paymentTxSignature,
          mode: forgeMode,
          createdAt: new Date().toISOString(),
        });
      }

      const result = await generateUserAvatar({
        mode: forgeMode,
        paymentTxSignature,
        authHeaders: buildAvatarAuthHeaders(keypair),
      });

      if (result.public_url && result.mint_address) {
        if (paymentTxSignature) await clearPendingAvatarPayment(address);
        // A credit mint deliberately does NOT become the profile picture
        // server-side — the picker chooses — so do not install it here either.
        if (!result.free_credit) {
          setAvatarUrl(result.public_url);
          setAvatarMintAddress(result.mint_address);
        }
        const remaining = typeof result.credits_remaining === 'number'
          ? result.credits_remaining
          : Math.max(0, freeCredits - (result.free_credit ? 1 : 0));
        setAvatarFreeCredits(remaining);

        // A refresh failure must NEVER be reported as a forge failure. The mint
        // succeeded and the pending payment has already been cleared, so the
        // "your payment signature is saved" reassurance below would be false and
        // the user would pay a second time.
        try {
          setAvatarMints(await listAvatarMints(buildAvatarAuthHeaders(keypair)));
        } catch {
          // Cosmetic only; the picker refetches on open.
        }

        showAlert(
          'Sakura avatar forged',
          result.free_credit
            ? `This one was on us — no SKR was charged.\n\nCollectible: ${result.mint_address.slice(0, 8)}…${
                remaining > 0
                  ? `\n\n${remaining} more free avatar${remaining === 1 ? '' : 's'} still waiting — tap your profile picture to forge ${remaining === 1 ? 'it' : 'them'}.`
                  : '\n\nOpen your avatars to choose which one shows on your profile.'
              }`
            : `Your Sakura-bound avatar relic is ready.\n\nCollectible: ${result.mint_address.slice(0, 8)}…\nPayment: ${paymentTxSignature ? `${paymentTxSignature.slice(0, 8)}…` : '—'}`,
        );
      } else {
        showAlert(
          'Could not forge avatar',
          paymentTxSignature
            ? `${result.error || 'Please try again.'}\n\nYour payment signature is saved on this device, so retrying Forge will not charge SKR again.`
            : `${result.error || 'Please try again.'}\n\nNothing was charged.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again later.';
      showAlert(
        'Could not forge avatar',
        paymentTxSignature
          ? `${message}\n\nYour payment signature is saved on this device, so retrying Forge will not charge SKR again.`
          : message.includes('hour')
          ? `${message}\n\nNo additional SKR should be charged when blocked before payment.`
          : `${message}\n\nNothing was charged.`,
      );
    } finally {
      setGeneratingAvatar(false);
    }
  }, [
    address,
    connected,
    sakuraBalance,
    solBalance,
    signWithBiometrics,
    unlockForAppSession,
    showForgeFundsGuide,
  ]);

  const handleSelectAvatarMint = useCallback(async (mint: AvatarMintItem) => {
    if (mint.is_active) return;
    setSelectingMintId(mint.id);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        showAlert('Unlock required', 'Approve to switch your profile avatar.');
        return;
      }
      const result = await selectAvatarMint(buildAvatarAuthHeaders(keypair), mint.id);
      if (result.public_url) setAvatarUrl(result.public_url);
      if (result.mint_address) setAvatarMintAddress(result.mint_address);
      setAvatarMints((prev) =>
        prev.map((item) => ({ ...item, is_active: item.id === mint.id })),
      );
      setAvatarPickerVisible(false);
    } catch (error) {
      showAlert('Could not switch avatar', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setSelectingMintId(null);
    }
  }, [unlockForAppSession]);

  const handleDownloadProfileImage = useCallback(async () => {
    if (!address) return;

    setDownloadingAvatar(true);
    try {
      const uri = resolveAvatarUri({
        wallet_address: address,
        avatar_url: avatarUrl,
        avatar_seed: avatarSeed,
        avatar_mint_address: avatarMintAddress,
      });
      await saveProfileImageToDevice(uri, `sakura-pfp-${address.slice(0, 8)}`);
      showAlert('Saved', 'Your profile photo was saved to your photo library.');
    } catch (error) {
      showAlert('Could not save photo', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setDownloadingAvatar(false);
    }
  }, [address, avatarUrl, avatarSeed, avatarMintAddress]);

  const openForgeDialog = useCallback(async () => {
    const pendingPayment = address ? await getPendingAvatarPayment(address) : null;
    // A free avatar needs neither SKR nor SOL, so the funds guide would be a wall
    // in front of something we are giving away.
    const free = avatarFreeCredits > 0 && !pendingPayment;
    if (!pendingPayment && !free) {
      const funds = getForgeFundsStatus(solBalance, sakuraBalance);
      if (!funds.ok) {
        showForgeFundsGuide();
        return;
      }
    }
    // `promisedFree` carries the claim this dialog is about to make into the
    // handler, so the handler can refuse rather than quietly charging if the
    // credit has gone by the time he taps.
    const freeMessage =
      avatarFreeCredits === 1
        ? 'You have one free avatar waiting after we charged you and delivered nothing. Forging it costs no SKR and no network fee.'
        : `You have ${avatarFreeCredits} free avatars waiting after we charged you and delivered nothing. Forging them costs no SKR and no network fee.`;
    setAvatarSheet({
      title: pendingPayment
        ? 'Resume avatar forge'
        : free
        ? 'Forge a free avatar'
        : 'Forge a Sakura avatar',
      message: pendingPayment
        ? 'Your SKR payment was already sent. Resume forging with the saved payment signature without paying again.'
        : free
        ? freeMessage
        : `Spend ${formatAvatarMintPrice()} to mint a new avatar NFT. You can switch between your avatars anytime.`,
      actions: pendingPayment
        ? [
            {
              id: 'resume',
              label: 'Resume forging',
              onPress: () => handleGenerateAvatar(pendingPayment.mode),
            },
          ]
        : [
            {
              id: 'tastes',
              label: 'From my tastes',
              onPress: () => handleGenerateAvatar('tastes', { promisedFree: free }),
            },
            {
              id: 'general',
              label: 'Fresh avatar',
              onPress: () => handleGenerateAvatar('general', { promisedFree: free }),
            },
          ],
    });
  }, [address, avatarFreeCredits, handleGenerateAvatar, sakuraBalance, solBalance, showForgeFundsGuide]);

  const onAvatarPress = useCallback(async () => {
    if (!connected) {
      setWalletVisible(true);
      return;
    }

    setLoadingAvatarMints(true);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        showAlert('Unlock required', 'Approve to manage your Sakura avatars.');
        return;
      }

      const eligibility = await fetchAvatarMintEligibility(buildAvatarAuthHeaders(keypair));
      setAvatarMints(eligibility.mints);
      setAvatarFreeCredits(eligibility.free_credits);

      // The one place a dismissed apology still surfaces. Say what is owed and
      // why, every time, so "don't show this again" never means "and lose them".
      const freeLine = eligibility.free_credits > 0
        ? ` ${eligibility.free_credits === 1 ? 'One is free' : `${eligibility.free_credits} are free`} — we owe you after charging you for an avatar you never got.`
        : '';

      if (eligibility.mints.length === 0) {
        const actions: ActionSheetAction[] = [
          { id: 'download', label: 'Download photo', onPress: handleDownloadProfileImage },
        ];
        if (eligibility.can_mint) {
          actions.push({
            id: 'forge',
            label: eligibility.free_credits > 0 ? 'Forge free avatar' : 'Forge avatar',
            onPress: openForgeDialog,
          });
        }
        setAvatarSheet({
          title: 'Profile photo',
          message: eligibility.can_mint
            ? `Save your current profile photo or forge a Sakura avatar NFT.${freeLine}`
            : 'Save your current profile photo to your device.',
          actions,
        });
        return;
      }

      // A free credit is exempt from the 24h limit server-side, so do not tell
      // him to wait for something he can do right now.
      const waitLine = eligibility.retry_after_hours > 0 && eligibility.free_credits <= 0
        ? ` You can forge another in about ${eligibility.retry_after_hours} hour(s).`
        : '';

      const actions: ActionSheetAction[] = [
        { id: 'download', label: 'Download photo', onPress: handleDownloadProfileImage },
        { id: 'choose', label: 'Choose avatar', onPress: () => setAvatarPickerVisible(true) },
      ];

      if (eligibility.can_mint) {
        actions.push({
          id: 'forge-another',
          label: eligibility.free_credits > 0 ? 'Forge a free one' : 'Forge another',
          onPress: openForgeDialog,
        });
      }

      setAvatarSheet({
        title: 'Sakura avatars',
        message: `You have ${eligibility.mint_count} forged avatar${eligibility.mint_count === 1 ? '' : 's'}. Pick which one shows on your profile, or mint another.${freeLine}${waitLine}`,
        actions,
      });
    } catch (error) {
      showAlert('Could not load avatars', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setLoadingAvatarMints(false);
    }
  }, [connected, unlockForAppSession, openForgeDialog, handleDownloadProfileImage]);

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        scrollIndicatorInsets={{ bottom: 90 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* ── Header ── */}
        <Animated.View entering={FadeInDown.duration(400)} style={s.header}>
          <TouchableOpacity onPress={onTap(onAvatarPress)} activeOpacity={0.85} disabled={generatingAvatar || loadingAvatarMints || downloadingAvatar}>
            <View style={[s.avatarWrap, { borderColor: colors.primary, backgroundColor: colors.surfaceSecondary }]}>
              {connected && address ? (
                <ProfileAvatar
                  profile={{
                    wallet_address: address,
                    avatar_url: avatarUrl,
                    avatar_seed: avatarSeed,
                    avatar_mint_address: avatarMintAddress,
                  }}
                  size={88}
                  borderColor={colors.primary}
                />
              ) : avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={s.avatarPhoto} contentFit="cover" />
              ) : (
                <Image
                  source={require('@/assets/images/logo.png')}
                  style={s.avatar}
                  contentFit="contain"
                />
              )}
              {(generatingAvatar || downloadingAvatar) && (
                <View style={s.avatarLoading}>
                  <ActivityIndicator color="#fff" />
                </View>
              )}
            </View>
          </TouchableOpacity>
          <Text style={[s.name, { color: colors.text }]}>
            {connected
              ? (displayName || shortAddress || 'Sakura User')
              : 'Guest'}
          </Text>
          <Text style={[s.username, { color: colors.textSecondary }]}>
            {connected
              ? (generatingAvatar
                ? `Forging avatar · ${formatAvatarMintPrice()}`
                : sakuraHandle
                  ? `@${sakuraHandle}`
                  : shortAddress ?? '')
              : 'Connect your account to get started'}
          </Text>
        </Animated.View>

        {/* ── Stats ── */}
        <Animated.View entering={FadeInDown.delay(80).duration(400)}
          style={[s.statsRow, { backgroundColor: colors.surface }]}>
          {([
            { label: 'Watching', value: stats.watching },
            { label: 'Reading', value: stats.reading },
            { label: 'Saved', value: stats.saved },
          ] as const).map((st, i) => (
            <React.Fragment key={st.label}>
              {i > 0 && <View style={[s.statDivider, { backgroundColor: colors.borderLight }]} />}
              <View style={s.stat}>
                <Text style={[s.statValue, { color: colors.text }]}>{st.value}</Text>
                <Text style={[s.statLabel, { color: colors.textSecondary }]}>{st.label}</Text>
              </View>
            </React.Fragment>
          ))}
        </Animated.View>

        {/* ── Wallet ── */}
        <Animated.View entering={FadeInDown.delay(140).duration(400)} style={[s.group, { marginBottom: Spacing.sm }]}>
          <WalletRow onPress={() => setWalletVisible(true)} colors={colors} />
        </Animated.View>

        {/* ── Sakura AI ── */}
        <Animated.View entering={FadeInDown.delay(170).duration(400)} style={[s.group, { marginBottom: Spacing.sm }]}>
          <AIRow colors={colors} />
        </Animated.View>

        {/* ── Creator ── */}
        <Animated.View entering={FadeInDown.delay(185).duration(400)} style={[s.group, { marginBottom: Spacing.sm }]}>
          <CreatorRow colors={colors} />
        </Animated.View>

        {/* ── Quick links ── */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)} style={s.group}>
          <MenuRow
            label="My Downloads"
            icon={<IconBadge bg="#007AFF"><DownloadsIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/downloads'))}
            colors={colors}
          />
          <MenuRow
            label="Reading History"
            icon={<IconBadge bg="#FF9500"><HistoryIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/reading-history'))}
            colors={colors}
          />
          <MenuRow
            label="Library"
            icon={<IconBadge bg="#E84545"><LibraryIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/library'))}
            colors={colors}
          />
          <MenuRow
            label="Quests & Rewards"
            icon={<IconBadge bg="#FF375F"><HistoryIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/quests' as any))}
            colors={colors}
          />
          <MenuRow
            label="Fan-Art Studio"
            icon={<IconBadge bg="#8A2BE2"><LibraryIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/fan-art' as any))}
            colors={colors}
          />
          <MenuRow
            label="Pose Studio"
            icon={<IconBadge bg="#F5C518"><LibraryIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/pose-studio' as any))}
            colors={colors}
          />
          <MenuRow
            label="Settings"
            icon={<IconBadge bg={colors.surfaceTertiary}><SettingsIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/settings'))}
            last
            colors={colors}
          />
        </Animated.View>

        <View style={{ height: 120 }} />
      </ScrollView>

      <WalletModal
        visible={walletVisible}
        onClose={() => {
          setWalletVisible(false);
          setWalletInitialRoute('main');
        }}
        initialRoute={walletInitialRoute}
      />
      <AvatarActionSheet
        visible={!!avatarSheet}
        title={avatarSheet?.title ?? ''}
        message={avatarSheet?.message}
        actions={avatarSheet?.actions ?? []}
        loading={loadingAvatarMints}
        onClose={() => setAvatarSheet(null)}
      />
      <AvatarMintPickerModal
        visible={avatarPickerVisible}
        mints={avatarMints}
        loading={loadingAvatarMints}
        selectingId={selectingMintId}
        onClose={() => setAvatarPickerVisible(false)}
        onSelect={handleSelectAvatarMint}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  header: { alignItems: 'center', paddingTop: Spacing.lg, paddingBottom: Spacing.md },
  avatarWrap: { width: 88, height: 88, borderRadius: 44, borderWidth: 3, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', ...Shadow.md },
  avatarLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  avatar: { width: 64, height: 64 },
  avatarPhoto: { width: '100%', height: '100%' },
  avatarInitial: { color: '#fff', fontSize: 34, fontWeight: FontWeight.bold },
  name: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 26, letterSpacing: 0.2, marginTop: 12 },
  username: { fontSize: FontSize.md, marginTop: 4 },
  statsRow: { flexDirection: 'row', marginHorizontal: Spacing.md, borderRadius: Radius.lg, marginBottom: Spacing.md, ...Shadow.sm },
  stat: { flex: 1, alignItems: 'center', paddingVertical: Spacing.md },
  statDivider: { width: StyleSheet.hairlineWidth, marginVertical: 12 },
  statValue: { fontSize: FontSize.xxl, fontWeight: FontWeight.bold },
  statLabel: { fontSize: FontSize.sm, marginTop: 2 },
  group: { marginHorizontal: Spacing.md, borderRadius: Radius.lg, overflow: 'hidden', ...Shadow.sm, marginBottom: Spacing.sm },
});

const row = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: 14 },
  walletRow: { paddingVertical: 12 },
  left: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  textCol: { flex: 1, minWidth: 0 },
  lottieBadge: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, flexShrink: 0 },
  lottie: { width: 32, height: 32 },
  label: { fontSize: FontSize.md, fontWeight: FontWeight.medium },
  sub: { fontSize: FontSize.xs, marginTop: 2, fontWeight: FontWeight.medium },
  betaChip: {
    flexShrink: 0,
    marginLeft: Spacing.sm,
    borderRadius: Radius.full,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
  },
  betaText: { fontSize: 9, fontFamily: Fonts.bodyBold, letterSpacing: 0.8 },
});
