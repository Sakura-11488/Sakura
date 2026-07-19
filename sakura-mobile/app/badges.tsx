import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Dimensions } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { fetchGamificationState, type GamificationBadge, type GamificationState } from '@/lib/gamification';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';

const { width: W } = Dimensions.get('window');
const COLS = 3;
const GAP = 10;
const CARD = (W - Spacing.md * 2 - GAP * (COLS - 1)) / COLS;

const TIER_COLOR: Record<string, string> = {
  bronze: '#CD7F32',
  silver: '#B8C0C8',
  gold: '#FFD24A',
};
const ICON: Record<string, string> = {
  book: '📖',
  flame: '🔥',
  run: '🏃',
  crown: '👑',
  star: '⭐',
  compass: '🧭',
};

export default function BadgesScreen() {
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
      fetchGamificationState(address).then((sState) => {
        if (alive) {
          setState(sState);
          setLoading(false);
        }
      });
      return () => {
        alive = false;
      };
    }, [address]),
  );

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
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, padding: Spacing.md },
    card: {
      width: CARD,
      borderRadius: Radius.md,
      backgroundColor: colors.surfaceSecondary,
      padding: 10,
      alignItems: 'center',
    },
    emoji: { fontSize: 30, marginBottom: 4 },
    locked: { opacity: 0.35 },
    title: { fontSize: 11, fontWeight: FontWeight.bold, color: colors.text, textAlign: 'center' },
    desc: { fontSize: 9, color: colors.textSecondary, textAlign: 'center', marginTop: 2, lineHeight: 12 },
    tierDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    muted: { color: colors.textSecondary },
  });

  const renderCard = (b: GamificationBadge) => (
    <View key={b.code} style={[s.card, !b.unlocked && s.locked]}>
      <Text style={s.emoji}>{b.unlocked ? ICON[b.icon ?? ''] ?? '🏅' : '🔒'}</Text>
      <Text style={s.title} numberOfLines={1}>{b.title}</Text>
      <Text style={s.desc} numberOfLines={2}>{b.description}</Text>
      <View style={[s.tierDot, { backgroundColor: TIER_COLOR[b.tier] ?? colors.border }]} />
    </View>
  );

  return (
    <View style={s.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path d="M19 12H5M12 19l-7-7 7-7" stroke={colors.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Badges</Text>
        </View>
        {loading ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} size="large" /></View>
        ) : !state ? (
          <View style={s.center}><Text style={s.muted}>Read something to earn your first badge.</Text></View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
            <View style={s.grid}>{state.badges.map(renderCard)}</View>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
