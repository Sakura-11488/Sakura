import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import {
  fetchGamificationState,
  flushReadingEvents,
  levelProgress,
  subscribeGamification,
  type GamificationState,
} from '@/lib/gamification';
import { Spacing, Radius, FontSize, FontWeight, Fonts, Shadow } from '@/constants/theme';

/**
 * Reading streak + level card. Self-contained: fetches the wallet's public
 * gamification state on focus, opportunistically flushes queued read events
 * (never prompts biometrics), and refreshes when a flush reports new state.
 * Renders nothing until the wallet is connected and has any activity.
 */
export default function StreakLevelCard() {
  const { colors } = useTheme();
  const router = useRouter();
  const { address } = useWallet();
  const [state, setState] = useState<GamificationState | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    fetchGamificationState(address).then((s) => {
      if (s) setState(s);
    });
  }, [address]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      // Push any queued reads (silent if the wallet is already unlocked).
      flushReadingEvents().then((s) => {
        if (s) setState(s);
      });
      const unsub = subscribeGamification(refresh);
      return () => unsub();
    }, [refresh]),
  );

  if (!address || !state || (state.xp === 0 && state.current_streak === 0)) return null;

  const { intoLevel, toNext } = levelProgress(state.xp);
  const pct = Math.max(0.02, Math.min(1, intoLevel / toNext));

  const s = StyleSheet.create({
    card: {
      marginHorizontal: Spacing.md,
      borderRadius: Radius.lg,
      overflow: 'hidden',
      ...Shadow.md,
    },
    inner: { padding: 14 },
    topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    streakWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    flame: { fontSize: 20 },
    streakNum: { color: '#fff', fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 22 },
    streakLabel: { color: 'rgba(255,255,255,0.85)', fontSize: FontSize.xs, marginLeft: 2 },
    levelPill: {
      backgroundColor: 'rgba(255,255,255,0.2)',
      borderRadius: Radius.full,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    levelPillText: { color: '#fff', fontFamily: Fonts.bodyBold, fontSize: FontSize.xs },
    barTrack: {
      height: 7,
      borderRadius: 4,
      backgroundColor: 'rgba(255,255,255,0.25)',
      marginTop: 12,
      overflow: 'hidden',
    },
    barFill: { height: '100%', borderRadius: 4, backgroundColor: '#fff' },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
    footerText: { color: 'rgba(255,255,255,0.9)', fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    cta: { color: '#fff', fontSize: FontSize.xs, fontFamily: Fonts.bodyBold },
  });

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        playTap();
        router.push('/quests' as any);
      }}
      style={s.card}
    >
      <LinearGradient colors={[colors.primary, '#8A2BE2']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        <View style={s.inner}>
          <View style={s.topRow}>
            <View style={s.streakWrap}>
              <Text style={s.flame}>🔥</Text>
              <Text style={s.streakNum}>{state.current_streak}</Text>
              <Text style={s.streakLabel}>day streak</Text>
            </View>
            <View style={s.levelPill}>
              <Text style={s.levelPillText}>LVL {state.level}</Text>
            </View>
          </View>
          <View style={s.barTrack}>
            <View style={[s.barFill, { width: `${pct * 100}%` }]} />
          </View>
          <View style={s.footerRow}>
            <Text style={s.footerText}>
              {intoLevel} / {toNext} XP to next level
            </Text>
            <Text style={s.cta}>Quests ›</Text>
          </View>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}
