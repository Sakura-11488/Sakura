import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { useTheme, AppColors } from '@/lib/theme';
import {
  Achievement, computeAchievements, getLevel, getPublicProfile,
  ProfileFavorite, ProfileStats, PublicProfile, truncateAddress,
} from '@/lib/profile-stats';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import UserSocialActions from '@/components/social/UserSocialActions';
import { useWallet } from '@/lib/wallet/context';
import { checkPassStatus } from '@/lib/wallet/pass';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';

function Back({ c }: { c: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path d="M19 12H5M12 5l-7 7 7 7" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

function StatCard({ value, label, colors }: { value: number | string; label: string; colors: AppColors }) {
  return (
    <View style={[styles.statCard, { backgroundColor: colors.surface }]}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

export default function PublicProfileScreen() {
  const { wallet } = useLocalSearchParams<{ wallet: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { address } = useWallet();

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [favorites, setFavorites] = useState<ProfileFavorite[]>([]);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [hasPass, setHasPass] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!wallet) { setLoading(false); return; }
    (async () => {
      setLoading(true);
      const [data, pass] = await Promise.all([
        getPublicProfile(wallet),
        checkPassStatus(wallet).catch(() => ({ valid: false })),
      ]);
      if (!active) return;
      setProfile(data.profile);
      setFavorites(data.favorites);
      setStats(data.stats);
      setHasPass(!!pass.valid);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [wallet]);

  const displayName = profile?.display_name?.trim() || truncateAddress(wallet ?? '');
  const isVerified = profile?.creator_verification_state === 'verified';
  const level = getLevel(stats?.chaptersRead ?? 0);
  const achievements: Achievement[] = useMemo(
    () => computeAchievements(stats ?? { chaptersRead: 0, commentsPosted: 0, reactionsReceived: 0, favoritesCount: 0, memberSince: null }, hasPass),
    [stats, hasPass],
  );
  const earned = achievements.filter((a) => a.earned).length;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Back c={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Profile</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : !wallet ? (
        <View style={styles.center}><Text style={{ color: colors.textSecondary }}>No wallet specified.</Text></View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
          {/* Hero */}
          <View style={[styles.hero, { backgroundColor: colors.surface }]}>
            <ProfileAvatar
              profile={{
                wallet_address: wallet,
                avatar_url: profile?.avatar_url ?? null,
                avatar_seed: profile?.avatar_seed ?? wallet.slice(0, 8),
              }}
              size={84}
              borderColor={colors.primary}
              style={{ marginBottom: 12 }}
            />
            <View style={styles.nameRow}>
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{displayName}</Text>
              {hasPass ? <Text style={styles.passBadge}>🌸</Text> : null}
              {isVerified ? <Text style={styles.passBadge}>✓</Text> : null}
            </View>
            {profile?.username ? (
              <Text style={[styles.handle, { color: colors.primary }]}>@{profile.username}</Text>
            ) : null}
            <Text style={[styles.walletText, { color: colors.textTertiary }]}>{truncateAddress(wallet)}</Text>
            {profile?.bio ? <Text style={[styles.bio, { color: colors.textSecondary }]}>{profile.bio}</Text> : null}

            <UserSocialActions targetWallet={wallet} viewerWallet={address} />

            {(profile?.follower_count ?? 0) > 0 ? (
              <Text style={[styles.followerCount, { color: colors.textTertiary }]}>
                {(profile?.follower_count ?? 0).toLocaleString()} follower{(profile?.follower_count ?? 0) === 1 ? '' : 's'}
              </Text>
            ) : null}

            {/* Level */}
            <View style={styles.levelWrap}>
              <View style={styles.levelHeader}>
                <Text style={[styles.levelName, { color: level.color }]}>{level.name}</Text>
                {level.nextMin !== null ? (
                  <Text style={[styles.levelNext, { color: colors.textTertiary }]}>
                    {stats?.chaptersRead ?? 0}/{level.nextMin} ch
                  </Text>
                ) : <Text style={[styles.levelNext, { color: colors.textTertiary }]}>MAX</Text>}
              </View>
              <View style={[styles.levelTrack, { backgroundColor: colors.surfaceSecondary }]}>
                <View style={[styles.levelFill, { width: `${level.progress}%`, backgroundColor: level.color }]} />
              </View>
            </View>

            {stats?.memberSince ? (
              <Text style={[styles.memberSince, { color: colors.textTertiary }]}>
                Member since {new Date(stats.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </Text>
            ) : null}
          </View>

          {/* Stats */}
          <View style={styles.statsRow}>
            <StatCard value={stats?.chaptersRead ?? 0} label="Chapters" colors={colors} />
            <StatCard value={stats?.commentsPosted ?? 0} label="Comments" colors={colors} />
            <StatCard value={stats?.reactionsReceived ?? 0} label="Reactions" colors={colors} />
            <StatCard value={stats?.favoritesCount ?? 0} label="Favorites" colors={colors} />
          </View>

          {/* Achievements */}
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>実績 Achievements</Text>
            <Text style={[styles.sectionCount, { color: colors.primary }]}>{earned}/{achievements.length}</Text>
          </View>
          <View style={styles.achGrid}>
            {achievements.map((a) => (
              <View
                key={a.id}
                style={[
                  styles.achCard,
                  { backgroundColor: colors.surface, borderColor: colors.borderLight },
                  !a.earned && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.achIcon}>{a.earned ? a.emoji : '🔒'}</Text>
                <Text style={[styles.achName, { color: colors.text }]} numberOfLines={1}>{a.name}</Text>
                <Text style={[styles.achDesc, { color: colors.textTertiary }]} numberOfLines={2}>{a.desc}</Text>
              </View>
            ))}
          </View>

          {/* Favorites */}
          {favorites.length > 0 ? (
            <>
              <View style={styles.sectionHead}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>お気に入り Favorites</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 12 }}>
                {favorites.map((f) => (
                  <TouchableOpacity
                    key={`${f.content_type}:${f.content_id}`}
                    activeOpacity={0.8}
                    onPress={() => {
                      const kind = f.content_type === 'anime' ? 'anime' : f.content_type === 'novel' ? 'novel' : 'manga';
                      router.push(`/${kind}/${encodeURIComponent(f.content_id)}` as any);
                    }}
                    style={styles.favCard}
                  >
                    {f.cover_url ? (
                      <Image source={{ uri: f.cover_url }} style={styles.favCover} />
                    ) : (
                      <View style={[styles.favCover, { backgroundColor: colors.surfaceSecondary }]} />
                    )}
                    <Text style={[styles.favTitle, { color: colors.textSecondary }]} numberOfLines={2}>{f.title}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:         { flex: 1 },
  center:       { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingVertical: 6 },
  backBtn:      { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle:  { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 18 },
  hero:         { margin: Spacing.md, borderRadius: Radius.lg, padding: Spacing.lg, alignItems: 'center', ...Shadow.sm },
  nameRow:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name:         { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, maxWidth: 240 },
  passBadge:    { fontSize: 18 },
  handle:       { fontSize: FontSize.md, fontWeight: FontWeight.bold, marginTop: 4 },
  walletText:   { fontSize: FontSize.sm, marginTop: 2 },
  followerCount:{ fontSize: FontSize.xs, marginTop: 8 },
  bio:          { fontSize: FontSize.sm, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  levelWrap:    { width: '100%', marginTop: 16 },
  levelHeader:  { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  levelName:    { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  levelNext:    { fontSize: FontSize.xs },
  levelTrack:   { height: 7, borderRadius: 4, overflow: 'hidden' },
  levelFill:    { height: '100%', borderRadius: 4 },
  memberSince:  { fontSize: FontSize.xs, marginTop: 12 },
  statsRow:     { flexDirection: 'row', gap: 8, paddingHorizontal: Spacing.md },
  statCard:     { flex: 1, borderRadius: Radius.md, paddingVertical: 14, alignItems: 'center', ...Shadow.sm },
  statValue:    { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 20 },
  statLabel:    { fontSize: 10, marginTop: 2 },
  sectionHead:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, marginTop: 28, marginBottom: 12 },
  sectionTitle: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 18 },
  sectionCount: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  achGrid:      { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: Spacing.md },
  achCard:      { width: '47%', borderWidth: 1, borderRadius: Radius.md, padding: 12, alignItems: 'center' },
  achIcon:      { fontSize: 26, marginBottom: 6 },
  achName:      { fontSize: FontSize.xs, fontWeight: FontWeight.bold, textAlign: 'center' },
  achDesc:      { fontSize: 10, textAlign: 'center', marginTop: 2 },
  favCard:      { width: 100 },
  favCover:     { width: 100, height: 140, borderRadius: Radius.md },
  favTitle:     { fontSize: FontSize.xs, marginTop: 6 },
});
