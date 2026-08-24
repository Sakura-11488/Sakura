import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, useWindowDimensions, Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import {
  fetchLeaderboard, formatXp, leaderboardName,
  LEADERBOARD_PAGE_SIZE, MIN_SEARCH_LENGTH,
  type LeaderboardEntry, type LeaderboardPage,
} from '@/lib/leaderboard';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { contentWidth } from '@/constants/layout';

/**
 * XP leaderboard.
 *
 * Opens on the top 100 and loads a further 100 per tap. Paging is EXPLICIT
 * rather than infinite-scroll: the ranks that matter are at the top, and
 * auto-loading would keep fetching pages nobody asked for from an endpoint that
 * ranks every user in the database.
 *
 * Your own standing sits pinned at the top, above the list, and is resolved
 * server-side by counting higher scores — so someone in 4,000th place sees their
 * position immediately instead of paging forty times to find themselves.
 *
 * Search runs server-side across the whole board, because the person being
 * looked for is almost never in the hundred rows already loaded.
 */

const MEDALS = ['🥇', '🥈', '🥉'];
const SEARCH_DEBOUNCE_MS = 300;

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

  const [q, setQ] = useState('');
  const [results, setResults] = useState<LeaderboardEntry[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Guards a second fetch firing from a double tap before the first resolves,
  // which would append the same page twice.
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
      setLoading(true);
      load(0);
    }, [load]),
  );

  // Debounced so typing does not fire a request per keystroke against an
  // endpoint that ranks every user.
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_SEARCH_LENGTH) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      fetchLeaderboard({ query: term, walletAddress: address })
        .then((p) => setResults(p.entries))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, address]);

  const showMore = () => {
    if (!page?.hasMore || loadingMore) return;
    setLoadingMore(true);
    load(entries.length);
  };

  const searchActive = q.trim().length >= MIN_SEARCH_LENGTH;
  const shown = searchActive ? (results ?? []) : entries;

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

    selfCard: {
      marginTop: Spacing.sm, padding: 14, borderRadius: Radius.md,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: 1, borderColor: colors.primary,
      flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    },
    selfRank: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.primary },
    selfLabel: { fontSize: 11, color: colors.textSecondary },
    selfXp: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.text },

    search: {
      marginTop: Spacing.sm,
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 12, borderRadius: Radius.md,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    },
    searchInput: {
      flex: 1, paddingVertical: 10, fontSize: FontSize.sm, color: colors.text,
      // react-native-web draws a focus ring that clashes with the container's
      // own border. `outlineStyle` is a DOM property with no native equivalent,
      // so it is applied on web only rather than handed to the native style
      // system, which has no business receiving it.
      ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : null),
    },
    clearBtn: { paddingHorizontal: 6, paddingVertical: 4 },
    clearText: { fontSize: FontSize.md, color: colors.textSecondary },

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
      width: 46, fontSize: FontSize.sm, fontWeight: FontWeight.bold,
      color: colors.textSecondary, textAlign: 'center',
    },
    rankTop: { color: colors.text, fontSize: FontSize.md },
    name: { flex: 1 },
    nameText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.text },
    meta: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
    xpBox: { alignItems: 'flex-end' },
    xp: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.primary },
    lvl: { fontSize: 10, color: colors.textSecondary, marginTop: 1 },

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
        <Text style={[s.rank, e.rank <= 3 && s.rankTop]}>{medal ?? e.rank.toLocaleString()}</Text>
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
            <TouchableOpacity
              style={[s.moreBtn, { paddingHorizontal: 24, marginTop: 16 }]}
              onPress={onTap(() => { setLoading(true); load(0); })}
            >
              <Text style={s.moreText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={s.body}>
              {/* Your standing, pinned above everything — the first thing you
                  came here to see, and it never moves as you page or search. */}
              {page?.self ? (
                <View style={s.selfCard}>
                  <Text style={s.selfRank}>#{page.self.rank.toLocaleString()}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.selfXp}>You</Text>
                    <Text style={s.selfLabel}>
                      {formatXp(page.self.xp)} XP · Level {page.self.level}
                      {page.total ? ` · of ${page.total.toLocaleString()}` : ''}
                    </Text>
                  </View>
                </View>
              ) : address ? (
                <View style={s.selfCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.selfXp}>You're not ranked yet</Text>
                    <Text style={s.selfLabel}>Read a chapter to earn your first XP.</Text>
                  </View>
                </View>
              ) : null}

              <View style={s.search}>
                <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                  <Path
                    d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
                    stroke={colors.textSecondary} strokeWidth={2}
                    strokeLinecap="round" strokeLinejoin="round"
                  />
                </Svg>
                <TextInput
                  style={s.searchInput}
                  value={q}
                  onChangeText={setQ}
                  placeholder="Search by name or wallet"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {searching ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
                {q.length > 0 ? (
                  <TouchableOpacity style={s.clearBtn} onPress={onTap(() => setQ(''))} hitSlop={8}>
                    <Text style={s.clearText}>×</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <Text style={s.subtitle}>
                {searchActive
                  ? `${shown.length} ${shown.length === 1 ? 'result' : 'results'} for "${q.trim()}"`
                  : `Top ${Math.min(LEADERBOARD_PAGE_SIZE, page?.total ?? 0)} by lifetime XP${
                      page?.total ? ` · ${page.total.toLocaleString()} readers ranked` : ''
                    }`}
              </Text>

              {shown.length === 0 ? (
                <Text style={s.end}>
                  {searchActive
                    ? 'No one by that name or wallet.'
                    : 'No one has earned XP yet. Read a chapter to get on the board.'}
                </Text>
              ) : (
                shown.map(renderRow)
              )}

              {/* Paging belongs to the ranked list; search returns one page. */}
              {!searchActive && shown.length > 0 ? (
                page?.hasMore ? (
                  <TouchableOpacity style={s.moreBtn} onPress={onTap(showMore)} disabled={loadingMore}>
                    {loadingMore
                      ? <ActivityIndicator color={colors.primary} />
                      : <Text style={s.moreText}>Show more</Text>}
                  </TouchableOpacity>
                ) : (
                  <Text style={s.end}>That's everyone.</Text>
                )
              ) : null}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
