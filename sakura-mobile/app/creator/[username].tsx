import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, { FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import Svg, { Path } from 'react-native-svg';
import { Fonts, FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { onTap } from '@/lib/sound';
import SubscribeButton from '@/components/social/SubscribeButton';
import {
  getCreatorByUsername,
  getPublicCreatorWorks,
  workCoverUrl,
  type PublicCreatorProfile,
  type CreatorWork,
} from '@/lib/creator';
import { getFollowerCount } from '@/lib/follow';
import { subscribeToCreatorFollows } from '@/lib/follow-realtime';
import { navigateToWalletChat } from '@/lib/user-chat-nav';

function avatarColor(seed: string): string {
  const colors = ['#E84545', '#9B59B6', '#3498DB', '#27AE60', '#E67E22', '#E91E8C'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function CreatorChannelScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { address, signWithBiometrics } = useWallet();

  const [profile, setProfile] = useState<PublicCreatorProfile | null>(null);
  const [works, setWorks] = useState<CreatorWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [followerCount, setFollowerCount] = useState(0);

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    getCreatorByUsername(String(username))
      .then(async (p) => {
        setProfile(p);
        if (p) {
          const [count, w] = await Promise.all([
            getFollowerCount(p.wallet_address),
            getPublicCreatorWorks(p.wallet_address),
          ]);
          setFollowerCount(count);
          setWorks(w);
        }
      })
      .finally(() => setLoading(false));
  }, [username]);

  useEffect(() => {
    const wallet = profile?.wallet_address;
    if (!wallet) return;
    return subscribeToCreatorFollows(wallet, address ?? null, {
      onFollowersChanged: () => getFollowerCount(wallet).then(setFollowerCount),
      onProfileFollowerCount: setFollowerCount,
    });
  }, [profile?.wallet_address, address]);

  const openChat = useCallback(async () => {
    if (!profile) return;
    if (!address) {
      Alert.alert('Connect Account', 'Connect your Sakura account to message this creator.');
      return;
    }
    if (address === profile.wallet_address) {
      router.push('/(tabs)/messages');
      return;
    }
    try {
      const kp = await signWithBiometrics();
      if (!kp) return;
      await navigateToWalletChat(router, kp, {
        walletAddress: profile.wallet_address,
        displayName: profile.display_name,
        username: profile.username,
        avatarUrl: profile.avatar_url,
        avatarSeed: profile.avatar_seed ?? profile.wallet_address.slice(0, 8),
      });
    } catch (e) {
      Alert.alert('Message failed', e instanceof Error ? e.message : 'Try again.');
    }
  }, [address, profile, router, signWithBiometrics]);

  const displayName = profile?.display_name ?? (profile?.username ? `@${profile.username}` : 'Creator');
  const seed = profile?.avatar_seed ?? profile?.wallet_address?.slice(0, 8) ?? '?';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: Spacing.md,
          paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
        },
        back: { padding: 6, marginRight: 4 },
        hero: { alignItems: 'center', paddingHorizontal: Spacing.md, paddingTop: 20, paddingBottom: 16 },
        avatar: {
          width: 80,
          height: 80,
          borderRadius: 40,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
          overflow: 'hidden',
        },
        avatarText: { color: '#fff', fontSize: 28, fontFamily: Fonts.bodyBold },
        name: { fontSize: FontSize.xl, fontFamily: Fonts.bodyBold, color: colors.text, textAlign: 'center' },
        handle: { fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 2 },
        bio: { fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, marginTop: 10, maxWidth: 320 },
        stats: { flexDirection: 'row', gap: 24, marginTop: 14 },
        statVal: { fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text, textAlign: 'center' },
        statLbl: { fontSize: FontSize.xs, color: colors.textTertiary, textAlign: 'center', marginTop: 2 },
        actions: { flexDirection: 'row', gap: 10, marginTop: 16, paddingHorizontal: Spacing.md },
        msgBtn: {
          width: 44,
          height: 44,
          borderRadius: Radius.md,
          borderWidth: 1.5,
          borderColor: colors.border,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'transparent',
        },
        section: { paddingHorizontal: Spacing.md, paddingTop: 20 },
        sectionTitle: { fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text, marginBottom: 12 },
        workCard: {
          flexDirection: 'row',
          gap: 12,
          paddingVertical: 10,
          marginBottom: 4,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
        },
        cover: { width: 52, height: 72, borderRadius: Radius.sm, backgroundColor: colors.surfaceSecondary },
        workTitle: { flex: 1, fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text },
        workKind: { fontSize: FontSize.xs, color: colors.textTertiary, marginTop: 4, textTransform: 'capitalize' },
        empty: { fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center', paddingVertical: 24 },
      }),
    [colors],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onTap(() => router.back())} style={styles.back}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path d="M15 18l-6-6 6-6" stroke={colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>
          <Text style={{ fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text }}>Creator</Text>
        </View>
        <Text style={[styles.empty, { marginTop: 40 }]}>Creator not found.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onTap(() => router.back())} style={styles.back}>
          <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
            <Path d="M15 18l-6-6 6-6" stroke={colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text }} numberOfLines={1}>
          {displayName}
        </Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <Animated.View entering={FadeInUp.duration(350)} style={styles.hero}>
          <View style={[styles.avatar, !profile.avatar_url && { backgroundColor: avatarColor(seed) }]}>
            {profile.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
            ) : (
              <Text style={styles.avatarText}>{initials(displayName)}</Text>
            )}
          </View>
          <Text style={styles.name}>{displayName}</Text>
          {profile.username ? <Text style={styles.handle}>@{profile.username}</Text> : null}
          {profile.creator_verification_state === 'verified' ? (
            <Text style={{ fontSize: FontSize.xs, color: colors.primary, marginTop: 6, fontWeight: FontWeight.semibold }}>
              Verified creator
            </Text>
          ) : null}
          {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
          <View style={styles.stats}>
            <View>
              <Text style={styles.statVal}>{followerCount.toLocaleString()}</Text>
              <Text style={styles.statLbl}>Subscribers</Text>
            </View>
            <View>
              <Text style={styles.statVal}>{works.length}</Text>
              <Text style={styles.statLbl}>Works</Text>
            </View>
          </View>
        </Animated.View>

        <View style={styles.actions}>
          <SubscribeButton
            creatorWallet={profile.wallet_address}
            iconOnly
            onChange={(_, count) => {
              if (count !== undefined) setFollowerCount(count);
              else getFollowerCount(profile.wallet_address).then(setFollowerCount);
            }}
          />
          <TouchableOpacity style={styles.msgBtn} onPress={openChat} activeOpacity={0.85}>
            <Ionicons name="chatbubbles-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Published works</Text>
          {works.length === 0 ? (
            <Text style={styles.empty}>No public works yet.</Text>
          ) : (
            works.map((work) => {
              const cover = workCoverUrl(work);
              return (
                <View key={work.id} style={styles.workCard}>
                  {cover ? (
                    <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" />
                  ) : (
                    <View style={styles.cover} />
                  )}
                  <View style={{ flex: 1, justifyContent: 'center' }}>
                    <Text style={styles.workTitle} numberOfLines={2}>{work.title}</Text>
                    <Text style={styles.workKind}>{work.kind}</Text>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
