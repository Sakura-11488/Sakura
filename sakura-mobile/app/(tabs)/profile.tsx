import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Alert,
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
import {
  hasSakuraAiAccess,
  SAKURA_AI_MIN_HOLDING,
  formatSakuraAiRequirement,
} from '@/lib/wallet/sakura-ai-access';
import { useFocusEffect } from 'expo-router';
import { getProfile } from '@/lib/supabase';
import { getCreatorProfile, getCreatorWorks } from '@/lib/creator';
import { Library } from '@/lib/storage';
import { ShimmerBox } from '@/components/ui/ShimmerLoader';
import WalletModal from '@/components/wallet/WalletModal';
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
import {
  buildAvatarAuthHeaders,
  fetchAvatarMintEligibility,
  generateUserAvatar,
  listAvatarMints,
  selectAvatarMint,
  type AvatarMintItem,
} from '@/lib/user-avatar';
import AvatarMintPickerModal from '@/components/social/AvatarMintPickerModal';

interface Stats { watching: number; reading: number; saved: number }

function ChevronRight({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function AIRow({ colors }: { colors: any }) {
  const { connected, sakuraBalance, refreshBalances, loadingBalances } = useWallet();
  const hasAccess = hasSakuraAiAccess(connected, sakuraBalance);

  useFocusEffect(
    useCallback(() => {
      if (connected) refreshBalances();
    }, [connected, refreshBalances]),
  );

  const balanceLabel =
    !connected
      ? `Hold ${formatSakuraAiRequirement()} to unlock`
      : loadingBalances && sakuraBalance === null
        ? 'Checking SKR balance…'
        : hasAccess
          ? 'Unlocked · Your on-screen companion'
          : `${(sakuraBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${SAKURA_AI_MIN_HOLDING.toLocaleString()} SKR`;

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
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarSeed, setAvatarSeed] = useState('guest');
  const [avatarMintAddress, setAvatarMintAddress] = useState<string | null>(null);
  const [avatarMints, setAvatarMints] = useState<AvatarMintItem[]>([]);
  const [avatarPickerVisible, setAvatarPickerVisible] = useState(false);
  const [selectingMintId, setSelectingMintId] = useState<string | null>(null);
  const [loadingAvatarMints, setLoadingAvatarMints] = useState(false);
  const [sakuraHandle, setSakuraHandle] = useState<string | null>(null);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [stats, setStats] = useState<Stats>({ watching: 0, reading: 0, saved: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const { colors } = useTheme();
  const { address, connected, shortAddress, sakuraBalance, signWithBiometrics, unlockForAppSession } = useWallet();
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

  const handleGenerateAvatar = useCallback(async (mode: 'tastes' | 'general') => {
    if (!address || !connected) {
      Alert.alert('Connect your account', 'Sign in to forge your Sakura avatar.');
      return;
    }

    if (sakuraBalance !== null && sakuraBalance < AVATAR_MINT_PRICE_SAKURA) {
      Alert.alert(
        'Insufficient SKR',
        `Minting costs ${formatAvatarMintPrice()}. Your balance is ${Math.floor(sakuraBalance).toLocaleString()} SKR.`,
      );
      return;
    }

    setGeneratingAvatar(true);
    try {
      const keypair = await signWithBiometrics();
      if (!keypair) {
        Alert.alert('Confirm to continue', 'Approve with Face ID to pay and forge your Sakura avatar.');
        return;
      }

      const authHeaders = buildAvatarAuthHeaders(keypair);
      const eligibility = await fetchAvatarMintEligibility(authHeaders);

      if (!eligibility.can_mint) {
        Alert.alert(
          'Mint not available yet',
          eligibility.retry_after_hours > 0
            ? `You can forge again in about ${eligibility.retry_after_hours} hour(s). No SKR was charged.`
            : 'Avatar minting is not available for this wallet right now.',
        );
        return;
      }

      const paymentTxSignature = await sendSakura(keypair, AVATAR_PAYMENT_WALLET, AVATAR_MINT_PRICE_SAKURA);
      const result = await generateUserAvatar({
        mode,
        paymentTxSignature,
        authHeaders,
      });

      if (result.public_url && result.mint_address) {
        setAvatarUrl(result.public_url);
        setAvatarMintAddress(result.mint_address);
        const refreshed = await listAvatarMints(authHeaders);
        setAvatarMints(refreshed);
        Alert.alert(
          'Sakura avatar forged',
          `Your Sakura-bound avatar relic is ready.\n\nCollectible: ${result.mint_address.slice(0, 8)}…\nPayment: ${paymentTxSignature.slice(0, 8)}…`,
          [
            { text: 'View collectible', onPress: () => Linking.openURL(solanaExplorerToken(result.mint_address!)) },
            { text: 'View payment', onPress: () => Linking.openURL(solanaExplorerTx(paymentTxSignature)) },
            { text: 'Done', style: 'cancel' },
          ],
        );
      } else {
        Alert.alert(
          'Could not forge avatar',
          `${result.error || 'Please try again.'}\n\nIf SKR left your wallet, save the payment signature and contact support.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again later.';
      Alert.alert(
        'Could not forge avatar',
        message.includes('hour')
          ? `${message}\n\nNo additional SKR should be charged when blocked before payment.`
          : message,
      );
    } finally {
      setGeneratingAvatar(false);
    }
  }, [address, connected, sakuraBalance, signWithBiometrics]);

  const handleSelectAvatarMint = useCallback(async (mint: AvatarMintItem) => {
    if (mint.is_active) return;
    setSelectingMintId(mint.id);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        Alert.alert('Unlock required', 'Approve to switch your profile avatar.');
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
      Alert.alert('Could not switch avatar', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setSelectingMintId(null);
    }
  }, [unlockForAppSession]);

  const openForgeDialog = useCallback(() => {
    Alert.alert(
      'Forge a Sakura avatar',
      `Spend ${formatAvatarMintPrice()} to mint a new avatar NFT. You can switch between your avatars anytime.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'From my tastes', onPress: () => handleGenerateAvatar('tastes') },
        { text: 'Fresh avatar', onPress: () => handleGenerateAvatar('general') },
      ],
    );
  }, [handleGenerateAvatar]);

  const onAvatarPress = useCallback(async () => {
    if (!connected) {
      setWalletVisible(true);
      return;
    }

    setLoadingAvatarMints(true);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair) {
        Alert.alert('Unlock required', 'Approve to manage your Sakura avatars.');
        return;
      }

      const eligibility = await fetchAvatarMintEligibility(buildAvatarAuthHeaders(keypair));
      setAvatarMints(eligibility.mints);

      if (eligibility.mints.length === 0) {
        openForgeDialog();
        return;
      }

      const waitLine = eligibility.retry_after_hours > 0
        ? `\n\nYou can forge another in about ${eligibility.retry_after_hours} hour(s).`
        : '';

      const actions: { text: string; style?: 'cancel'; onPress?: () => void }[] = [
        { text: 'Choose avatar', onPress: () => setAvatarPickerVisible(true) },
      ];

      if (eligibility.can_mint) {
        actions.push({ text: 'Forge another', onPress: openForgeDialog });
      }

      actions.push({ text: 'Cancel', style: 'cancel' });

      Alert.alert(
        'Sakura avatars',
        `You have ${eligibility.mint_count} forged avatar${eligibility.mint_count === 1 ? '' : 's'}. Pick which one shows on your profile, or mint another.${waitLine}`,
        actions,
      );
    } catch (error) {
      Alert.alert('Could not load avatars', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setLoadingAvatarMints(false);
    }
  }, [connected, unlockForAppSession, openForgeDialog]);

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
          <TouchableOpacity onPress={onTap(onAvatarPress)} activeOpacity={0.85} disabled={generatingAvatar || loadingAvatarMints}>
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
              {generatingAvatar && (
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
            label="Settings"
            icon={<IconBadge bg={colors.surfaceTertiary}><SettingsIcon color="#fff" /></IconBadge>}
            onPress={onTap(() => router.push('/settings'))}
            last
            colors={colors}
          />
        </Animated.View>

        <View style={{ height: 120 }} />
      </ScrollView>

      <WalletModal visible={walletVisible} onClose={() => setWalletVisible(false)} />
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
