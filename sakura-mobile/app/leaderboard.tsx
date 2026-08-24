import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import {
  fetchLeaderboard, formatXp, leaderboardName,
  LEADERBOARD_PAGE_SIZE, type LeaderboardEntry, type LeaderboardPage,
} from '@/lib/leaderboard';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { contentWidth } from '@/constants/layout';

/**
 * XP leaderboard.
 *
 * Opens on the top 100 and loads a further 100 per tap. Paging is EXPLICIT
 * rather than infinite-scroll: the ranks that matter are at the top, and
 * auto-loading would keep fetching pages nobody asked for on an endpoint that
 * ranks every user in the database.
 *
 * The viewer's own rank is resolved server-side by counting higher scores, so
 * someone in 4,000th place sees their position immediately instead of having to
 * page forty times to find themselves.
 */

const MEDALS = ['🥇', '🥈', '🥉'];

export default function LeaderboardScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address } = useWallet();
  const { width } = useWindowDimensions();
  const W = contentWidth(width);

  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [page, setPage] = useState<LeaderboardPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a second fetch firing from a double tap before the first
  // resolves, which would append the same page twice.
  const inFlight = useRef(false);

  const load = useCallback(async (offset: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const p = await fetchLeaderboard({ offset, walletAddress: address });
      setPage(p);
      setEntries((prev) => (offset === 0 ? p.entries : [...prev, ...p.entries]));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the leaderboard.');
    } finally {
      inFlight.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [address]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setLoading(true);
      // Always reload from the top on focus — XP moves, and a stale board is
      // worse than a brief spinner.
      load(0).then(() => { if (!alive) return; });
      return () => { alive = false; };
    }, [load]),
  );

  const showMore = () => {
    if (!page?.hasMore || loadingMore) return;
    setLoadingMore(true);
    load(entries.length);
  };

  // Only worth pinning when they are not already visible in the loaded rows.
  const selfVisible = page?.self
    ? entries.some((e) => e.wallet_address === address)
    : true;

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm, gap: 6,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    body: { width: W, alignSelf: 'center', paddingHorizontal: Spacing.md },
    subtitle: {
      fontSize: FontSize.sm, color: colors.textSecondary,
      paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
      paddingVertical: 10, paddingHorizontal: 12, marginBottom: 6,
      borderRadius: Radius.md, backgroundColor: colors.surfaceSecondary,
    },
    rowSelf: { borderWidth: 1, borderColor: colors.primary },
    rank: {
      width: 42, fontSize: FontSize.sm, fontWeight: FontWeight.bold,
      color: colors.textSecondary, textAlign: 'center',
    },
    rankTop: { color: colors.text, fontSize: FontSize.md },
    name: { flex: 1 },
    nameText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.text },
    meta: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
    xpBox: { alignItems: 'flex-end' },
    xp: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.primary },
    lvl: { fontSize: 10, color: colors.textSecondary, marginTop: 1 },
    selfBar: {
      marginTop: Spacing.sm, padding: 12, borderRadius: Radius.md,
      backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.primary,
    },
    selfText: { fontSize: FontSize.sm, color: colors.text, fontWeight: FontWeight.bold },
    moreBtn: {
      marginTop: Spacing.sm, marginBottom: 40, paddingVertical: 14,
      borderRadius: Radius.md, alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    moreText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.text },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    muted: { color: colors.textSecondary, textAlign: 'center', paddingHorizontal: Spacing.lg },
    end: {
      textAlign: 'center', color: colors.textSecondary, fontSize: 11,
      marginTop: Spacing.sm, marginBottom: 40,
    },
  });

  const renderRow = (e: LeaderboardEntry) => {
    const isSelf = !!address && e.wallet_address === address;
    const medal = e.rank <= 3 ? MEDALS[e.rank - 1] : null;
    return (
      <View key={e.wallet_address} style={[s.row, isSelf && s.rowSelf]}>
        <Text style={[s.rank, e.rank <= 3 && s.rankTop]}>{medal ?? e.rank}</Text>
        <View style={s.name}>
          <Text style={s.nameText} numberOfLines={1}>
            {leaderboardName(e)}{isSelf ? '  (you)' : ''}
          </Text>
          <Text style={s.meta} numberOfLines={1}>
            {e.current_streak > 0
              ? `${e.current_streak}-day streak`
              : e.longest_streak > 0
                ? `best ${e.longest_streak}-day streak`
                : 'no active streak'}
          </Text>
        </View>
        <View style={s.xpBox}>
          <Text style={s.xp}>{formatXp(e.xp)} XP</Text>
          <Text style={s.lvl}>Lv {e.level}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={s.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path d="M19 12H5M12 19l-7-7 7-7" stroke={colors.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Leaderboard</Text>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} size="large" /></View>
        ) : error ? (
          <View style={s.center}>
            <Text style={s.muted}>{error}</Text>
            <TouchableOpacity style={[s.moreBtn, { paddingHorizontal: 24, marginTop: 16 }]} onPress={onTap(() => { setLoading(true); load(0); })}>
              <Text style={s.moreText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : entries.length === 0 ? (
          <View style={s.center}>
            <Text style={s.muted}>No one has earned XP yet. Read a chapter to get on the board.</Text>
          </View>
        ) : (
          <ScrollView>
            <View style={s.body}>
              <Text style={s.subtitle}>
                Top {Math.min(LEADERBOARD_PAGE_SIZE, page?.total ?? 0)} by lifetime XP
                {page?.total ? ` · ${page.total.toLocaleString()} readers ranked` : ''}
              </Text>

              {entries.map(renderRow)}

              {page?.hasMore ? (
                <TouchableOpacity style={s.moreBtn} onPress={onTap(showMore)} disabled={loadingMore}>
                  {loadingMore
                    ? <ActivityIndicator color={colors.primary} />
                    : <Text style={s.moreText}>Show more</Text>}
                </TouchableOpacity>
              ) : (
                <Text style={s.end}>That's everyone.</Text>
              )}

              {page?.self && !selfVisible ? (
                <View style={s.selfBar}>
                  <Text style={s.selfText}>
                    You're #{page.self.rank.toLocaleString()} · {formatXp(page.self.xp)} XP · Lv {page.self.level}
                  </Text>
                </View>
              ) : null}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
