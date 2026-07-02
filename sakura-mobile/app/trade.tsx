import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { getWalletWithBiometrics } from '@/lib/wallet/storage';
import { getTradeSignLabel } from '@/lib/wallet/platform-labels';
import {
  fetchPhoenixMarketState,
  fetchPhoenixTraderData,
  executePhoenixOrder,
  closePhoenixPosition,
  getDefaultPhoenixSymbol,
  type PhoenixMarketState,
  type PhoenixTraderData,
} from '@/lib/wallet/phoenix';
import { playTap, onTap } from '@/lib/sound';

const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20];

const BackIcon = ({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

function fmt(n: number | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default function TradeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const wallet = useWallet();
  const symbol = getDefaultPhoenixSymbol();

  const [market, setMarket] = useState<PhoenixMarketState | null>(null);
  const [trader, setTrader] = useState<PhoenixTraderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [side, setSide] = useState<'long' | 'short'>('long');
  const [sizeStr, setSizeStr] = useState('');
  const [collateralStr, setCollateralStr] = useState('');
  const [leverage, setLeverage] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const m = await fetchPhoenixMarketState(symbol);
      if (!mountedRef.current) return;
      setMarket(m);
      if (wallet.address) {
        const t = await fetchPhoenixTraderData(wallet.address, m.markPrice).catch(() => null);
        if (mountedRef.current && t) setTrader(t);
      }
    } catch {
      // keep previous data
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [symbol, wallet.address]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [load]);

  const position = trader?.position ?? null;

  const submitOrder = async () => {
    const size = parseFloat(sizeStr);
    const collateral = parseFloat(collateralStr);
    if (!wallet.connected || !wallet.address) {
      setError('Connect your wallet first.');
      return;
    }
    if (!size || size <= 0) {
      setError('Enter a position size.');
      return;
    }
    playTap();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const keypair = await getWalletWithBiometrics();
      if (!keypair) throw new Error('Could not unlock your wallet.');
      const result = await executePhoenixOrder(
        {
          authority: wallet.address,
          symbol,
          side,
          orderType: 'market',
          quantity: size,
          transferAmount: Number.isFinite(collateral) && collateral > 0 ? collateral : undefined,
        },
        keypair,
      );
      if (!result.success) throw new Error(result.error || 'Order failed');
      setLastTx(result.signature ?? null);
      setNotice(`${side === 'long' ? 'Long' : 'Short'} order filled.`);
      setSizeStr('');
      setCollateralStr('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Order failed');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const closePosition = async () => {
    if (!position || !wallet.address) return;
    playTap();
    setClosing(true);
    setError(null);
    setNotice(null);
    try {
      const keypair = await getWalletWithBiometrics();
      if (!keypair) throw new Error('Could not unlock your wallet.');
      const result = await closePhoenixPosition(
        { authority: wallet.address, symbol, side: position.side === 'short' ? 'short' : 'long', quantity: position.size },
        keypair,
      );
      if (!result.success) throw new Error(result.error || 'Close failed');
      setLastTx(result.signature ?? null);
      setNotice('Position closed.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Close failed');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (mountedRef.current) setClosing(false);
    }
  };

  const changePositive = (market?.change24h ?? 0) >= 0;

  const s = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.background },
        topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 12 },
        circleBtn: {
          width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surfaceSecondary,
          alignItems: 'center', justifyContent: 'center',
        },
        topTitle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
        netBadge: {
          marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.full,
          backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border,
        },
        netText: { fontSize: FontSize.xs, color: colors.textSecondary, fontWeight: FontWeight.semibold },
        content: { padding: 16, paddingBottom: 48, gap: 14 },
        card: {
          backgroundColor: colors.surfaceSecondary, borderRadius: Radius.lg, borderWidth: 1,
          borderColor: colors.borderLight, padding: 16, gap: 12,
        },
        marketTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        marketSym: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
        markPrice: { fontSize: 28, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, color: colors.text },
        change: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
        statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
        stat: { gap: 2 },
        statLabel: { fontSize: FontSize.xs, color: colors.textTertiary },
        statVal: { fontSize: FontSize.sm, color: colors.text, fontWeight: FontWeight.semibold },
        posHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        posSide: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
        pnlBig: { fontSize: 22, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight },
        closeBtn: {
          backgroundColor: '#FF3B30', borderRadius: Radius.full, paddingVertical: 12, alignItems: 'center',
        },
        closeText: { color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.bold },
        sideRow: { flexDirection: 'row', gap: 8 },
        sideBtn: {
          flex: 1, paddingVertical: 13, borderRadius: Radius.md, alignItems: 'center',
          borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
        },
        sideBtnLong: { backgroundColor: '#34C759', borderColor: '#34C759' },
        sideBtnShort: { backgroundColor: '#FF3B30', borderColor: '#FF3B30' },
        sideText: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.textSecondary },
        sideTextActive: { color: '#fff' },
        inputRow: {
          flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
          borderRadius: Radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14,
        },
        input: { flex: 1, fontSize: FontSize.lg, fontFamily: Fonts.display, fontWeight: FontWeight.bold, color: colors.text, paddingVertical: 13 },
        inputUnit: { fontSize: FontSize.sm, color: colors.textSecondary, fontWeight: FontWeight.semibold },
        fieldLabel: { fontSize: FontSize.xs, color: colors.textSecondary, fontWeight: FontWeight.semibold, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
        levRow: { flexDirection: 'row', gap: 8 },
        levBtn: {
          flex: 1, paddingVertical: 10, borderRadius: Radius.sm, alignItems: 'center',
          borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
        },
        levBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
        levText: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.textSecondary },
        levTextActive: { color: '#fff' },
        cta: {
          borderRadius: Radius.full, paddingVertical: 16, alignItems: 'center', marginTop: 4,
        },
        ctaText: { color: '#fff', fontSize: FontSize.md, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight },
        notConnected: { fontSize: FontSize.sm, color: colors.textSecondary, textAlign: 'center' },
        error: { color: '#FF3B30', fontSize: FontSize.sm, textAlign: 'center' },
        notice: { color: '#34C759', fontSize: FontSize.sm, textAlign: 'center', fontWeight: FontWeight.semibold },
        link: { color: colors.primary, fontSize: FontSize.sm, textAlign: 'center', textDecorationLine: 'underline' },
        disclaimer: { fontSize: FontSize.xs, color: colors.textTertiary, textAlign: 'center', lineHeight: 16 },
        sectionTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text, marginTop: 4 },
        tradeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
        tradeSide: { fontSize: FontSize.sm, fontWeight: FontWeight.bold },
        tradeMeta: { fontSize: FontSize.xs, color: colors.textTertiary },
      }),
    [colors],
  );

  return (
    <View style={[s.screen, { paddingTop: insets.top + 6 }]}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={onTap(() => router.back())} style={s.circleBtn} activeOpacity={0.8}>
          <BackIcon color={colors.text} />
        </TouchableOpacity>
        <Text style={s.topTitle}>Phoenix Perps</Text>
        <View style={s.netBadge}>
          <Text style={s.netText}>{market?.active ? 'LIVE' : 'Phoenix'}</Text>
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={colors.primary}
            />
          }
        >
          {/* Market */}
          <View style={s.card}>
            <View style={s.marketTop}>
              <Text style={s.marketSym}>{market?.displaySymbol ?? `${symbol}-PERP`}</Text>
              <Text style={[s.change, { color: changePositive ? '#34C759' : '#FF3B30' }]}>
                {changePositive ? '+' : ''}{fmt(market?.change24h)}%
              </Text>
            </View>
            <Text style={s.markPrice}>${fmt(market?.markPrice)}</Text>
            <View style={s.statsRow}>
              <View style={s.stat}>
                <Text style={s.statLabel}>Funding</Text>
                <Text style={s.statVal}>{fmt((market?.fundingRate ?? 0) * 100, 4)}%</Text>
              </View>
              <View style={s.stat}>
                <Text style={s.statLabel}>24h High</Text>
                <Text style={s.statVal}>${fmt(market?.high24h)}</Text>
              </View>
              <View style={s.stat}>
                <Text style={s.statLabel}>24h Low</Text>
                <Text style={s.statVal}>${fmt(market?.low24h)}</Text>
              </View>
              <View style={s.stat}>
                <Text style={s.statLabel}>Max Lev</Text>
                <Text style={s.statVal}>{market?.maxLeverage ?? '—'}x</Text>
              </View>
            </View>
          </View>

          {/* Open position */}
          {position?.hasPosition ? (
            <View style={s.card}>
              <View style={s.posHeader}>
                <Text style={[s.posSide, { color: position.side === 'long' ? '#34C759' : '#FF3B30' }]}>
                  {position.side.toUpperCase()} · {fmt(position.size, 4)} {symbol}
                </Text>
                <Text style={s.statVal}>{fmt(position.leverage, 1)}x</Text>
              </View>
              <Text style={[s.pnlBig, { color: position.pnl >= 0 ? '#34C759' : '#FF3B30' }]}>
                {position.pnl >= 0 ? '+' : ''}${fmt(position.pnl)} ({position.pnl >= 0 ? '+' : ''}{fmt(position.pnlPercent)}%)
              </Text>
              <View style={s.statsRow}>
                <View style={s.stat}>
                  <Text style={s.statLabel}>Entry</Text>
                  <Text style={s.statVal}>${fmt(position.entryPrice)}</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statLabel}>Mark</Text>
                  <Text style={s.statVal}>${fmt(position.markPrice)}</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statLabel}>Liq.</Text>
                  <Text style={s.statVal}>${fmt(position.liquidationPrice)}</Text>
                </View>
                <View style={s.stat}>
                  <Text style={s.statLabel}>Margin</Text>
                  <Text style={s.statVal}>${fmt(position.margin)}</Text>
                </View>
              </View>
              <TouchableOpacity
                style={[s.closeBtn, closing && { opacity: 0.6 }]}
                activeOpacity={0.85}
                onPress={closePosition}
                disabled={closing}
              >
                {closing ? <ActivityIndicator color="#fff" /> : <Text style={s.closeText}>Close Position</Text>}
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Order ticket */}
          <View style={s.card}>
            <View style={s.sideRow}>
              <TouchableOpacity
                style={[s.sideBtn, side === 'long' && s.sideBtnLong]}
                activeOpacity={0.85}
                onPress={() => { playTap(); setSide('long'); }}
              >
                <Text style={[s.sideText, side === 'long' && s.sideTextActive]}>Long</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.sideBtn, side === 'short' && s.sideBtnShort]}
                activeOpacity={0.85}
                onPress={() => { playTap(); setSide('short'); }}
              >
                <Text style={[s.sideText, side === 'short' && s.sideTextActive]}>Short</Text>
              </TouchableOpacity>
            </View>

            <View>
              <Text style={s.fieldLabel}>Size ({symbol})</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={s.input}
                  value={sizeStr}
                  onChangeText={setSizeStr}
                  placeholder="0.00"
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="decimal-pad"
                  editable={!submitting}
                />
                <Text style={s.inputUnit}>{symbol}</Text>
              </View>
            </View>

            <View>
              <Text style={s.fieldLabel}>Add Collateral (USDC, optional)</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={s.input}
                  value={collateralStr}
                  onChangeText={setCollateralStr}
                  placeholder="0.00"
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="decimal-pad"
                  editable={!submitting}
                />
                <Text style={s.inputUnit}>USDC</Text>
              </View>
            </View>

            <View>
              <Text style={s.fieldLabel}>Leverage</Text>
              <View style={s.levRow}>
                {LEVERAGE_OPTIONS.map((lev) => (
                  <TouchableOpacity
                    key={lev}
                    style={[s.levBtn, leverage === lev && s.levBtnActive]}
                    activeOpacity={0.85}
                    onPress={() => { playTap(); setLeverage(lev); }}
                  >
                    <Text style={[s.levText, leverage === lev && s.levTextActive]}>{lev}x</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {error ? <Text style={s.error}>{error}</Text> : null}
            {notice ? <Text style={s.notice}>{notice}</Text> : null}

            {wallet.connected ? (
              <TouchableOpacity
                style={[s.cta, { backgroundColor: side === 'long' ? '#34C759' : '#FF3B30' }, submitting && { opacity: 0.6 }]}
                activeOpacity={0.85}
                onPress={submitOrder}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={s.ctaText}>
                    {getTradeSignLabel(side)}
                  </Text>
                )}
              </TouchableOpacity>
            ) : (
              <Text style={s.notConnected}>Connect a wallet from your profile to trade.</Text>
            )}

            {lastTx ? (
              <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${lastTx}`)} activeOpacity={0.7}>
                <Text style={s.link}>View last transaction ↗</Text>
              </TouchableOpacity>
            ) : null}

            <Text style={s.disclaimer}>
              Perpetual futures are high risk. Trades settle on-chain via Phoenix and are signed locally on your device.
            </Text>
          </View>

          {/* Recent trades */}
          {trader && trader.trades.length > 0 ? (
            <View style={s.card}>
              <Text style={s.sectionTitle}>Recent Trades</Text>
              {trader.trades.slice(0, 10).map((t) => (
                <View style={s.tradeRow} key={t.id}>
                  <View>
                    <Text style={[s.tradeSide, { color: t.side.toLowerCase().includes('buy') || t.side.toLowerCase().includes('long') ? '#34C759' : '#FF3B30' }]}>
                      {t.side.toUpperCase()} {fmt(t.size, 4)}
                    </Text>
                    <Text style={s.tradeMeta}>{new Date(t.createdAt).toLocaleString()}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.statVal}>${fmt(t.price)}</Text>
                    {t.pnl != null ? (
                      <Text style={[s.tradeMeta, { color: t.pnl >= 0 ? '#34C759' : '#FF3B30' }]}>
                        {t.pnl >= 0 ? '+' : ''}${fmt(t.pnl)}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
