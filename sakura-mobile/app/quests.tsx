import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import {
  fetchGamificationState,
  flushReadingEvents,
  levelProgress,
  type GamificationState,
} from '@/lib/gamification';
import { XP_SWAP_ENABLED } from '@/lib/xp-redeem';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';

export default function QuestsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address } = useWallet();
  const [state, setState] = useState<GamificationState | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (!address) {
        setLoading(false);
        return;
      }
      flushReadingEvents().finally(() => {
        fetchGamificationState(address).then((s) => {
          if (alive) {
            setState(s);
            setLoading(false);
          }
        });
      });
      return () => {
        alive = false;
      };
    }, [address]),
  );

  const prog = state ? levelProgress(state.xp) : null;

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
      gap: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    statRow: { flexDirection: 'row', gap: 10, padding: Spacing.md },
    stat: {
      flex: 1,
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      paddingVertical: 14,
      alignItems: 'center',
    },
    statNum: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22, color: colors.text },
    statLabel: { fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 2 },
    swapCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginHorizontal: Spacing.md,
      marginTop: 14,
      paddingVertical: 15,
      paddingHorizontal: 18,
      borderRadius: 20,
      backgroundColor: '#E84545',
    },
    swapTitle: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.md,
      color: '#fff',
    },
    swapSub: { fontSize: FontSize.xs, color: 'rgba(255,255,255,0.82)', marginTop: 2 },
    sectionTitle: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.md,
      color: colors.text,
      paddingHorizontal: Spacing.md,
      marginTop: 10,
      marginBottom: 6,
    },
    quest: {
      marginHorizontal: Spacing.md,
      marginBottom: 10,
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.md,
      padding: 14,
    },
    questTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    questTitle: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.text },
    questXp: { fontSize: FontSize.xs, color: colors.primary, fontFamily: Fonts.bodyBold },
    questDesc: { fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 2, marginBottom: 8 },
    track: { height: 7, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
    fill: { height: '100%', borderRadius: 4, backgroundColor: colors.primary },
    done: { color: colors.primary, fontSize: FontSize.xs, fontFamily: Fonts.bodyBold, marginTop: 6 },
    link: { color: colors.primary, fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, textAlign: 'center', padding: 16 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    muted: { color: colors.textSecondary },
  });

  return (
    <View style={s.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path d="M19 12H5M12 19l-7-7 7-7" stroke={colors.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Daily Quests</Text>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} size="large" /></View>
        ) : !state ? (
          <View style={s.center}><Text style={s.muted}>Read something to start earning XP.</Text></View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
            <View style={s.statRow}>
              <View style={s.stat}>
                <Text style={s.statNum}>{prog?.level ?? 1}</Text>
                <Text style={s.statLabel}>Level</Text>
              </View>
              <View style={s.stat}>
                <Text style={s.statNum}>🔥 {state.current_streak}</Text>
                <Text style={s.statLabel}>Day streak</Text>
              </View>
              <View style={s.stat}>
                <Text style={s.statNum}>{state.chapters_total}</Text>
                <Text style={s.statLabel}>Chapters read</Text>
              </View>
            </View>

            {/* Entry point to the swap — placed under the stats, where the XP
                total is already on screen and the question "what is this for?"
                naturally lands. Hidden until payouts can actually settle; see
                XP_SWAP_ENABLED. */}
            {XP_SWAP_ENABLED ? (
            <TouchableOpacity
              style={s.swapCta}
              activeOpacity={0.88}
              onPress={onTap(() => router.push('/swap-xp' as any))}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.swapTitle}>Swap XP for SAKURA</Text>
                <Text style={s.swapSub}>1 XP = 3.19 SAKURA</Text>
              </View>
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M9 6l6 6-6 6"
                  stroke="#fff"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </TouchableOpacity>
            ) : null}

            <Text style={s.sectionTitle}>Today's Quests</Text>
            {state.quests.map((q) => {
              const pct = Math.min(1, q.progress / q.target);
              return (
                <View key={q.code} style={s.quest}>
                  <View style={s.questTop}>
                    <Text style={s.questTitle}>{q.title}</Text>
                    <Text style={s.questXp}>+{q.xp_reward} XP</Text>
                  </View>
                  <Text style={s.questDesc}>{q.description}</Text>
                  <View style={s.track}>
                    <View style={[s.fill, { width: `${pct * 100}%` }]} />
                  </View>
                  {q.completed ? (
                    <Text style={s.done}>✓ Completed · {q.progress}/{q.target}</Text>
                  ) : (
                    <Text style={s.questDesc}>{q.progress}/{q.target}</Text>
                  )}
                </View>
              );
            })}

            <TouchableOpacity onPress={onTap(() => router.push('/badges' as any))}>
              <Text style={s.link}>View all badges ›</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={onTap(() => router.push('/leaderboard' as any))}>
              <Text style={s.link}>XP leaderboard ›</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
