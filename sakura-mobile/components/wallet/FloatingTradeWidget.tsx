import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useWallet } from '@/lib/wallet/context';
import { AppSettings } from '@/lib/settings';
import { fetchPhoenixMarketState, fetchPhoenixTraderData } from '@/lib/wallet/phoenix';
import { FontSize, FontWeight, Fonts } from '@/constants/theme';
import { playTap } from '@/lib/sound';

const READING_PREFIXES = ['/chapter', '/anime/watch', '/novel/read'];

/**
 * Reading-screen floating PnL pill (Android/iOS analog of the web widget).
 * Polls the user's live Phoenix position and taps through to /trade.
 */
export default function FloatingTradeWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { address, connected } = useWallet();

  const [enabled, setEnabled] = useState(false);
  const [pnl, setPnl] = useState(0);
  const [hasPosition, setHasPosition] = useState(false);

  const isReadingPage = useMemo(
    () => READING_PREFIXES.some((p) => (pathname || '').startsWith(p)),
    [pathname],
  );

  useEffect(() => {
    let active = true;
    AppSettings.getPnlTracker()
      .then((v) => active && setEnabled(v))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pathname]);

  const isVisible = isReadingPage && enabled;

  useEffect(() => {
    if (!isVisible || !connected || !address) {
      setHasPosition(false);
      return;
    }
    let mounted = true;

    const load = async () => {
      try {
        const market = await fetchPhoenixMarketState();
        const data = await fetchPhoenixTraderData(address, market.markPrice);
        if (!mounted) return;
        if (data.position?.hasPosition) {
          setHasPosition(true);
          setPnl(data.position.pnlPercent);
        } else {
          setHasPosition(false);
        }
      } catch {
        if (mounted) setHasPosition(false);
      }
    };

    load();
    const interval = setInterval(load, 8000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [isVisible, connected, address]);

  if (!isVisible) return null;

  const isProfit = pnl >= 0;
  const accent = !hasPosition ? '#8E8E93' : isProfit ? '#34C759' : '#FF3B30';

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => {
        playTap();
        router.push('/trade');
      }}
      style={[
        s.widget,
        { bottom: insets.bottom + 92, borderColor: accent, shadowColor: accent },
      ]}
    >
      <Text style={[s.icon, { color: accent }]}>◎</Text>
      <Text style={[s.pnl, { color: accent }]}>
        {hasPosition ? `${isProfit ? '+' : ''}${pnl.toFixed(2)}%` : 'Trade'}
      </Text>
      {hasPosition ? <View style={[s.dot, { backgroundColor: accent }]} /> : null}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  widget: {
    position: 'absolute',
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 22,
    borderWidth: 1.5,
    backgroundColor: 'rgba(20,20,28,0.92)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 50,
  },
  icon: { fontSize: 15, fontWeight: FontWeight.bold },
  pnl: { fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, fontWeight: FontWeight.bold },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
