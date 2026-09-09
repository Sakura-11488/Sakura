import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import SakuraLottie from '@/components/ui/SakuraLottie';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import {
  getCreatorCoinStatus,
  DEFAULT_MIN_FOLLOWERS,
  type CreatorCoinStatus,
} from '@/lib/creator-coin-status';
import { solanaExplorerToken } from '@/lib/wallet/config';
import { onTap } from '@/lib/sound';
import { CreatorDashboardSkeleton } from '@/components/creator/CreatorSkeletons';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import {
  getCreatorProfile,
  getCreatorWorks,
  statusLabel,
  uploadCreatorAvatar,
  workCoverUrl,
  type CreatorProfile,
  type CreatorWork,
  type CreatorWorkKind,
} from '@/lib/creator';
import { contentWidth } from '@/constants/layout';

const HERO_H = 188;

/**
 * Read reactively. This was a module constant off Dimensions.get('window'),
 * captured once at bundle evaluation and never re-read — no listener exists
 * anywhere in the app. contentWidth() rather than the window width, because on
 * desktop web the sidebar is a sibling of the content column and anything sized
 * off the window overflows by exactly SIDEBAR_WIDTH.
 */
function useDashboardMetrics() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const SCREEN_W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    return { SCREEN_W, WORK_W: (SCREEN_W - Spacing.md * 2 - Spacing.sm) / 2 };
  }, [windowW]);
}
const FILTERS: Array<'all' | CreatorWorkKind> = ['all', 'novel', 'manga', 'anime'];

function kindColor(kind: CreatorWorkKind): string {
  if (kind === 'novel') return '#AF52DE';
  if (kind === 'manga') return '#34C759';
  return '#007AFF';
}

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 48%)`;
}

export default function CreatorDashboardScreen() {
  const { SCREEN_W, WORK_W } = useDashboardMetrics();
  const { colors } = useTheme();
  const router = useRouter();
  const { connected, address, shortAddress, restoring, signWithBiometrics } = useWallet();

  const [loading, setLoading] = useState(true);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [filter, setFilter] = useState<'all' | CreatorWorkKind>('all');
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [works, setWorks] = useState<CreatorWork[]>([]);
  const [coinStatus, setCoinStatus] = useState<CreatorCoinStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!address) {
      setCreator(null);
      setWorks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const profile = await getCreatorProfile(address);
      if (!profile.username) {
        router.replace('/become-creator');
        return;
      }
      setCreator(profile);
      setWorks(await getCreatorWorks(address));
      // Deliberately not in the same try as the profile: the coin card is
      // supplementary, and a failure to count followers should not empty the
      // creator's library.
      getCreatorCoinStatus(address)
        .then(setCoinStatus)
        .catch(() => setCoinStatus(null));
    } catch {
      setCreator(null);
      setWorks([]);
    } finally {
      setLoading(false);
    }
  }, [address, router]);

  useFocusEffect(
    useCallback(() => {
      // See creator-upload.tsx: don't judge the session until it has loaded.
      if (restoring) return;
      if (!connected) {
        router.replace('/become-creator');
        return;
      }
      refresh();
    }, [restoring, connected, refresh, router]),
  );

  const stats = useMemo(() => {
    const novels = works.filter((w) => w.kind === 'novel').length;
    const manga = works.filter((w) => w.kind === 'manga').length;
    const anime = works.filter((w) => w.kind === 'anime').length;
    return { total: works.length, novels, manga, anime };
  }, [works]);

  const filteredWorks = useMemo(
    () => (filter === 'all' ? works : works.filter((w) => w.kind === filter)),
    [works, filter],
  );

  const pickAvatar = useCallback(async () => {
    if (!address || uploadingAvatar) return;

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      showAlert('Photos', 'Allow photo access to upload your profile picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]?.uri) return;

    setUploadingAvatar(true);
    try {
      const keypair = await signWithBiometrics();
      if (!keypair) {
        showAlert('Wallet', 'Unlock your wallet to update your profile photo.');
        return;
      }

      const asset = result.assets[0];
      const avatarUrl = await uploadCreatorAvatar({
        keypair,
        localUri: asset.uri,
        mimeType: asset.mimeType ?? undefined,
      });

      setCreator((prev) => {
        if (!prev) return prev;
        const profile = prev.profile ?? {
          wallet_address: address,
          display_name: null,
          bio: null,
          avatar_seed: address.slice(0, 8),
          avatar_url: null,
          created_at: null,
          updated_at: null,
        };
        return {
          ...prev,
          profile: { ...profile, avatar_url: avatarUrl },
        };
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      showAlert('Upload failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setUploadingAvatar(false);
    }
  }, [address, signWithBiometrics, uploadingAvatar]);

  const displayName =
    creator?.username?.display_name ||
    creator?.profile?.display_name ||
    creator?.username?.username ||
    'Creator';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        hero: {
          marginHorizontal: Spacing.md,
          width: SCREEN_W - Spacing.md * 2,
          height: HERO_H,
          borderRadius: Radius.xl,
          overflow: 'hidden',
          marginBottom: Spacing.md,
          backgroundColor: '#141418',
          ...Shadow.md,
        },
        heroImage: { ...StyleSheet.absoluteFill },
        heroGrad: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '92%' },
        heroTint: { ...StyleSheet.absoluteFill },
        heroBack: {
          position: 'absolute',
          top: Spacing.sm,
          left: Spacing.sm,
          zIndex: 2,
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.45)',
        },
        heroContent: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: Spacing.lg,
          paddingBottom: Spacing.lg,
          zIndex: 1,
        },
        heroRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.md },
        avatar: {
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: 'rgba(255,255,255,0.35)',
          overflow: 'hidden',
        },
        avatarText: { color: '#fff', fontSize: FontSize.xl, fontWeight: FontWeight.bold },
        avatarOverlay: {
          ...StyleSheet.absoluteFill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.45)',
        },
        avatarBadge: {
          position: 'absolute',
          right: -2,
          bottom: -2,
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: colors.primary,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: '#141418',
        },
        heroText: { flex: 1 },
        heroTag: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1, marginBottom: 4 },
        heroName: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: '#fff' },
        heroHandle: { color: 'rgba(255,255,255,0.82)', fontSize: FontSize.sm, marginTop: 2 },
        statsRow: {
          flexDirection: 'row',
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.md,
          gap: Spacing.sm,
        },
        statCard: {
          flex: 1,
          backgroundColor: colors.surface,
          borderRadius: Radius.lg,
          paddingVertical: Spacing.md,
          alignItems: 'center',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          ...Shadow.sm,
        },
        statValue: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: colors.text },
        statLabel: { fontSize: 10, color: colors.textSecondary, marginTop: 2, fontWeight: FontWeight.semibold },
        coinCard: {
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.md,
          padding: Spacing.md,
          borderRadius: Radius.lg,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        },
        coinTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text },
        coinSub: { fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 16 },
        coinLink: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.primary, marginTop: 8 },
        actionsRow: { flexDirection: 'row', marginHorizontal: Spacing.md, gap: Spacing.sm, marginBottom: Spacing.md },
        actionCard: {
          flex: 1,
          borderRadius: Radius.xl,
          overflow: 'hidden',
          ...Shadow.sm,
        },
        actionInner: { padding: Spacing.md, minHeight: 108, justifyContent: 'space-between' },
        actionPrimary: { backgroundColor: colors.primary },
        actionSecondary: {
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
        },
        actionTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
        actionSub: { fontSize: FontSize.xs, marginTop: 4, lineHeight: 16 },
        walletBar: {
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.lg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: colors.surface,
          borderRadius: Radius.lg,
          paddingHorizontal: Spacing.md,
          paddingVertical: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
        },
        walletLabel: { fontSize: FontSize.xs, color: colors.textSecondary, fontWeight: FontWeight.medium },
        walletValue: { fontSize: FontSize.sm, color: colors.text, fontWeight: FontWeight.semibold, marginTop: 1 },
        sectionHead: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.sm,
        },
        sectionTitle: {
          fontSize: FontSize.xs,
          fontWeight: FontWeight.bold,
          color: colors.primary,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        },
        sectionCount: { fontSize: FontSize.sm, color: colors.textSecondary },
        filters: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          paddingHorizontal: Spacing.md,
          gap: 8,
          marginBottom: Spacing.md,
        },
        filterChip: {
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: Radius.full,
          borderWidth: 1.5,
        },
        filterText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
        worksGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          paddingHorizontal: Spacing.md,
          gap: Spacing.sm,
          paddingBottom: Spacing.xxl,
        },
        workCard: {
          width: WORK_W,
          backgroundColor: colors.surface,
          borderRadius: Radius.lg,
          overflow: 'hidden',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          ...Shadow.sm,
        },
        workCover: { width: '100%', height: WORK_W * 1.38, backgroundColor: colors.surfaceSecondary },
        workCoverFallback: { alignItems: 'center', justifyContent: 'center' },
        workKindBadge: {
          position: 'absolute',
          top: 8,
          left: 8,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: Radius.full,
        },
        workKindText: { color: '#fff', fontSize: 9, fontWeight: FontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
        workBody: { padding: Spacing.sm },
        workTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: colors.text, lineHeight: 18 },
        workStatusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 6 },
        statusDot: { width: 6, height: 6, borderRadius: 3 },
        workStatus: { fontSize: FontSize.xs, color: colors.textSecondary, fontWeight: FontWeight.medium },
        emptyWrap: {
          marginHorizontal: Spacing.md,
          padding: Spacing.xl,
          alignItems: 'center',
          backgroundColor: colors.surface,
          borderRadius: Radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          marginBottom: Spacing.xxl,
        },
        emptyTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text, marginTop: Spacing.sm },
        emptySub: {
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          textAlign: 'center',
          marginTop: 6,
          lineHeight: 20,
          marginBottom: Spacing.lg,
        },
        emptyBtn: {
          backgroundColor: colors.primary,
          paddingHorizontal: Spacing.lg,
          paddingVertical: 13,
          borderRadius: Radius.full,
          ...Shadow.sm,
        },
        emptyBtnText: { color: '#fff', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
      }),
    [colors],
  );

  if (loading) return <CreatorDashboardSkeleton />;

  const initial = (creator?.username?.username?.[0] || 'C').toUpperCase();
  const avatarUrl = creator?.profile?.avatar_url ?? null;
  const avatarSeed = creator?.profile?.avatar_seed ?? address?.slice(0, 8) ?? 'creator';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: Spacing.sm, paddingBottom: 120 }}>
        <Animated.View entering={FadeInDown.duration(380)} style={styles.hero}>
          <Image source={require('@/assets/images/banner.png')} style={styles.heroImage} contentFit="cover" />
          <LinearGradient
            colors={['rgba(0,0,0,0.25)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.9)']}
            locations={[0.15, 0.5, 1]}
            style={styles.heroGrad}
          />
          <LinearGradient
            colors={['rgba(232,69,69,0.2)', 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0.8 }}
            style={styles.heroTint}
          />

          <TouchableOpacity style={styles.heroBack} onPress={onTap(() => router.back())} activeOpacity={0.85}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path d="M15 18l-6-6 6-6" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>

          <View style={styles.heroContent}>
            <View style={styles.heroRow}>
              <TouchableOpacity
                onPress={onTap(pickAvatar)}
                activeOpacity={0.85}
                disabled={uploadingAvatar}
                accessibilityLabel="Change profile photo"
              >
                <View style={[styles.avatar, !avatarUrl && { backgroundColor: avatarColor(avatarSeed) }]}>
                  {avatarUrl ? (
                    <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  ) : (
                    <Text style={styles.avatarText}>{initial}</Text>
                  )}
                  {uploadingAvatar ? (
                    <View style={styles.avatarOverlay}>
                      <ActivityIndicator color="#fff" size="small" />
                    </View>
                  ) : (
                    <View style={styles.avatarBadge}>
                      <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
                        <Path
                          d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
                          stroke="#fff"
                          strokeWidth={2.2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </Svg>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
              <View style={styles.heroText}>
                <Text style={styles.heroTag}>CREATOR DASHBOARD</Text>
                <Text style={styles.heroName} numberOfLines={1}>{displayName}</Text>
                <Text style={styles.heroHandle}>@{creator?.username?.username}</Text>
              </View>
            </View>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(50).duration(380)} style={styles.statsRow}>
          {[
            { label: 'Works', value: stats.total },
            { label: 'Novels', value: stats.novels },
            { label: 'Manga', value: stats.manga },
            { label: 'Anime', value: stats.anime },
          ].map((st) => (
            <View key={st.label} style={styles.statCard}>
              <Text style={styles.statValue}>{st.value}</Text>
              <Text style={styles.statLabel}>{st.label}</Text>
            </View>
          ))}
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(90).duration(380)} style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.actionCard}
            onPress={onTap(() => router.push('/creator-upload'))}
            activeOpacity={0.9}
          >
            <LinearGradient colors={['#FF6B6B', '#E84545']} style={styles.actionInner}>
              <View>
                <Text style={[styles.actionTitle, { color: '#fff' }]}>Upload work</Text>
                <Text style={[styles.actionSub, { color: 'rgba(255,255,255,0.85)' }]}>
                  New chapter, episode, or series
                </Text>
              </View>
              <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
                <Path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" />
              </Svg>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionCard, styles.actionSecondary]}
            onPress={onTap(() => router.push('/creator-profile'))}
            activeOpacity={0.85}
          >
            <View style={[styles.actionInner, { backgroundColor: colors.surface }]}>
              <View>
                <Text style={[styles.actionTitle, { color: colors.text }]}>Edit profile</Text>
                <Text style={[styles.actionSub, { color: colors.textSecondary }]}>Bio & display name</Text>
              </View>
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                <Path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </View>
          </TouchableOpacity>
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(120).duration(380)} style={styles.walletBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.walletLabel}>Connected account</Text>
            <Text style={styles.walletValue}>{shortAddress}</Text>
          </View>
        </Animated.View>

        <View style={styles.sectionHead}>
          {coinStatus ? (
            <Animated.View entering={FadeInUp.delay(120).duration(380)} style={styles.coinCard}>
              {coinStatus.launchedCoin ? (
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={onTap(() => {
                    const mint = coinStatus.launchedCoin?.mint_address;
                    if (mint) Linking.openURL(solanaExplorerToken(mint));
                  })}
                >
                  <Text style={styles.coinTitle}>${coinStatus.launchedCoin.symbol} is live</Text>
                  <Text style={styles.coinSub}>
                    {coinStatus.launchedCoin.mint_address ?? 'Mint address unavailable'}
                  </Text>
                  <Text style={styles.coinLink}>View on Solscan</Text>
                </TouchableOpacity>
              ) : coinStatus.likelyEligible ? (
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={onTap(() => router.push('/creator-coin-launch'))}
                >
                  <Text style={styles.coinTitle}>Launch your creator coin</Text>
                  <Text style={styles.coinSub}>
                    One coin per creator, on pump.fun, with a contract address ending in
                    {' '}sakura. Launching is permanent.
                  </Text>
                  <Text style={styles.coinLink}>Start</Text>
                </TouchableOpacity>
              ) : (
                <View>
                  <Text style={styles.coinTitle}>Creator coin</Text>
                  <Text style={styles.coinSub}>
                    {coinStatus.publishedWorks < 1
                      ? 'Publish a work on Sakura to unlock this.'
                      : `${coinStatus.followerCount} of ${DEFAULT_MIN_FOLLOWERS} followers.`}
                  </Text>
                </View>
              )}
            </Animated.View>
          ) : null}

          <Text style={styles.sectionTitle}>Your library</Text>
          <Text style={styles.sectionCount}>{filteredWorks.length} shown</Text>
        </View>

        {works.length > 0 && (
          <View style={styles.filters}>
            {FILTERS.map((f) => {
              const active = filter === f;
              const label = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1);
              return (
                <TouchableOpacity
                  key={f}
                  style={[
                    styles.filterChip,
                    {
                      backgroundColor: active ? colors.primary : colors.surface,
                      borderColor: active ? colors.primary : colors.borderLight,
                    },
                  ]}
                  onPress={() => setFilter(f)}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.filterText, { color: active ? '#fff' : colors.textSecondary }]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {works.length === 0 ? (
          <Animated.View entering={FadeIn.delay(150).duration(380)} style={styles.emptyWrap}>
            <SakuraLottie
              source={require('@/assets/lottie/write.json')}
              style={{ width: 56, height: 56 }}
              autoPlay
              loop
              speed={0.75}
            />
            <Text style={styles.emptyTitle}>Start your catalog</Text>
            <Text style={styles.emptySub}>
              Your published novels, manga, and anime will appear here. Upload your first work to go live on Sakura.
            </Text>
            <TouchableOpacity
              style={styles.emptyBtn}
              onPress={onTap(() => router.push('/creator-upload'))}
              activeOpacity={0.85}
            >
              <Text style={styles.emptyBtnText}>Upload first work</Text>
            </TouchableOpacity>
          </Animated.View>
        ) : filteredWorks.length === 0 ? (
          <View style={[styles.emptyWrap, { paddingVertical: Spacing.lg }]}>
            <Text style={[styles.emptySub, { marginBottom: 0 }]}>No {filter} works yet.</Text>
          </View>
        ) : (
          <Animated.View entering={FadeInUp.delay(150).duration(380)} style={styles.worksGrid}>
            {filteredWorks.map((work) => {
              const cover = workCoverUrl(work);
              const kColor = kindColor(work.kind);
              const live = work.publication_status === 'published';
              return (
                <View key={work.id} style={styles.workCard}>
                  <View>
                    {cover ? (
                      <Image source={{ uri: cover }} style={styles.workCover} contentFit="cover" transition={200} />
                    ) : (
                      <View style={[styles.workCover, styles.workCoverFallback, { backgroundColor: `${kColor}14` }]}>
                        <Text style={{ fontSize: 12, fontWeight: FontWeight.bold, color: kColor, textTransform: 'uppercase' }}>
                          {work.kind}
                        </Text>
                      </View>
                    )}
                    <View style={[styles.workKindBadge, { backgroundColor: kColor }]}>
                      <Text style={styles.workKindText}>{work.kind}</Text>
                    </View>
                  </View>
                  <View style={styles.workBody}>
                    <Text style={styles.workTitle} numberOfLines={2}>{work.title}</Text>
                    <View style={styles.workStatusRow}>
                      <View style={[styles.statusDot, { backgroundColor: live ? colors.success : colors.warning }]} />
                      <Text style={styles.workStatus}>{statusLabel(work.publication_status)}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </Animated.View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
