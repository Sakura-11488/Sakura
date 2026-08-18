import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import Svg, { Path } from 'react-native-svg';
import { onTap, playTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import { unlockForAppSession } from '@/lib/wallet/app-session';
import { sendSakura } from '@/lib/wallet/connection';
import {
  buildFanArtAuthHeaders,
  fetchFanArtQuote,
  generateFanArt,
  listFanArt,
  setFanArtAsAvatar,
  setFanArtAsBanner,
  type FanArtItem,
  type FanArtQuote,
  type FanArtSubjectType,
} from '@/lib/fan-art';
import { Spacing, Radius, FontSize, FontWeight, Fonts, Shadow } from '@/constants/theme';
import { contentWidth } from '@/constants/layout';

const COL = 2;
const GAP = 10;

/**
 * Read reactively. This was a module constant off Dimensions.get('window'),
 * captured once at bundle evaluation and never re-read — no listener exists
 * anywhere in the app. contentWidth() rather than the window width, because on
 * desktop web the sidebar is a sibling of the content column and anything sized
 * off the window overflows by exactly SIDEBAR_WIDTH.
 */
function useCardWidth() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    return (W - Spacing.md * 2 - GAP) / COL;
  }, [windowW]);
}

const STYLE_LABELS: Record<string, string> = {
  mappa: 'MAPPA',
  watercolor: 'Watercolor',
  retro90s: "'90s Retro",
  chibi: 'Chibi',
};

export default function FanArtScreen() {
  const CARD = useCardWidth();
  const { colors } = useTheme();
  const router = useRouter();
  const { connected } = useWallet();

  const [quote, setQuote] = useState<FanArtQuote | null>(null);
  const [gallery, setGallery] = useState<FanArtItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [subjectType, setSubjectType] = useState<FanArtSubjectType>('series');
  const [series, setSeries] = useState<string>('');
  const [character, setCharacter] = useState('');
  const [freePrompt, setFreePrompt] = useState('');
  const [style, setStyle] = useState('mappa');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kp = await unlockForAppSession();
      if (!kp) {
        setLoading(false);
        return;
      }
      const headers = buildFanArtAuthHeaders(kp);
      const [q, items] = await Promise.all([fetchFanArtQuote(headers), listFanArt(headers)]);
      setQuote(q);
      setGallery(items);
      if (!series && q.series.length) setSeries(q.series[0]);
    } catch (e) {
      showAlert('Fan-Art Studio', e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, [series]);

  useEffect(() => {
    if (connected) load();
    else setLoading(false);
  }, [connected]);

  // Silent gallery refresh (no full-screen spinner) for polling.
  const refreshGallery = useCallback(async () => {
    try {
      const kp = await unlockForAppSession();
      if (!kp) return;
      const items = await listFanArt(buildFanArtAuthHeaders(kp));
      setGallery(items);
    } catch {
      // a transient poll failure shouldn't interrupt the user
    }
  }, []);

  // While any piece is still rendering server-side, poll so it flips to the
  // finished image on its own instead of showing a spinner until manual reload.
  useEffect(() => {
    const pending = gallery.some(
      (it) => it.status !== 'ready' && it.status !== 'error' && it.status !== 'failed',
    );
    if (!pending) return;
    const t = setInterval(refreshGallery, 4000);
    return () => clearInterval(t);
  }, [gallery, refreshGallery]);

  const onGenerate = useCallback(async () => {
    if (!quote || busy) return;
    setBusy(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const kp = await unlockForAppSession();
      if (!kp) throw new Error('Unlock your wallet to continue.');
      const headers = buildFanArtAuthHeaders(kp);
      const paymentTxSignature = await sendSakura(kp, quote.payment_wallet, quote.price_sakura);
      const res = await generateFanArt(
        {
          subjectType,
          series: subjectType === 'free' ? undefined : series,
          character: subjectType === 'character' ? character : undefined,
          freePrompt: subjectType === 'free' ? freePrompt : undefined,
          stylePreset: style,
          paymentTxSignature,
        },
        headers,
      );
      if (res.public_url) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await load();
      }
    } catch (e) {
      showAlert('Generation failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [quote, busy, subjectType, series, character, freePrompt, style, load]);

  const onItemAction = useCallback(async (item: FanArtItem) => {
    // Stays on Alert.alert: this one needs selectable buttons, which showAlert
    // (window.alert on web) cannot render. Still inert on web — a proper action
    // sheet is the real fix, tracked separately.
    Alert.alert(
      'Use this artwork',
      undefined,
      [
        {
          text: 'Set as profile avatar',
          onPress: async () => {
            try {
              const kp = await unlockForAppSession();
              if (!kp) return;
              await setFanArtAsAvatar(item.id, buildFanArtAuthHeaders(kp));
              showAlert('Done', 'Avatar updated.');
            } catch (e) {
              showAlert('Failed', e instanceof Error ? e.message : 'Try again.');
            }
          },
        },
        {
          text: 'Set as banner',
          onPress: async () => {
            try {
              const kp = await unlockForAppSession();
              if (!kp) return;
              await setFanArtAsBanner(item.id, buildFanArtAuthHeaders(kp));
              showAlert('Done', 'Banner updated.');
            } catch (e) {
              showAlert('Failed', e instanceof Error ? e.message : 'Try again.');
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, []);

  const s = useMemo(
    () =>
      StyleSheet.create({
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
        label: { fontSize: FontSize.sm, fontWeight: FontWeight.bold, color: colors.text, paddingHorizontal: Spacing.md, marginTop: 14, marginBottom: 8 },
        chipRow: { paddingHorizontal: Spacing.md, gap: 8, flexDirection: 'row', flexWrap: 'wrap' },
        chip: {
          paddingHorizontal: 13,
          paddingVertical: 7,
          borderRadius: Radius.full,
          backgroundColor: colors.surfaceSecondary,
          borderWidth: 1.5,
          borderColor: colors.border,
        },
        chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
        chipText: { fontSize: FontSize.xs, color: colors.textSecondary, fontFamily: Fonts.bodyMedium },
        chipTextActive: { color: '#fff', fontFamily: Fonts.bodyBold },
        input: {
          marginHorizontal: Spacing.md,
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.md,
          padding: 12,
          color: colors.text,
          fontSize: FontSize.sm,
        },
        seriesScroll: { paddingHorizontal: Spacing.md, gap: 8 },
        genBtn: {
          margin: Spacing.md,
          backgroundColor: colors.primary,
          borderRadius: Radius.full,
          paddingVertical: 15,
          alignItems: 'center',
          ...Shadow.sm,
        },
        genBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
        grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingHorizontal: Spacing.md, paddingBottom: 60 },
        card: { width: CARD, height: CARD * 1.33, borderRadius: Radius.md, overflow: 'hidden', backgroundColor: colors.surfaceSecondary },
        img: { width: '100%', height: '100%' },
        processing: { alignItems: 'center', justifyContent: 'center', flex: 1 },
        center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
        muted: { color: colors.textSecondary, textAlign: 'center' },
      }),
    [colors],
  );

  const Chip = ({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) => (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onTap(onPress)} activeOpacity={0.8}>
      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
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
          <Text style={s.headerTitle}>Fan-Art Studio</Text>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} size="large" /></View>
        ) : !connected || !quote ? (
          <View style={s.center}><Text style={s.muted}>Connect your wallet to create fan-art.</Text></View>
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text style={s.label}>What to draw</Text>
            <View style={s.chipRow}>
              <Chip active={subjectType === 'series'} label="Series vibe" onPress={() => setSubjectType('series')} />
              <Chip active={subjectType === 'character'} label="Character" onPress={() => setSubjectType('character')} />
              <Chip active={subjectType === 'free'} label="Free prompt" onPress={() => setSubjectType('free')} />
            </View>

            {subjectType !== 'free' && (
              <>
                <Text style={s.label}>Series</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.seriesScroll}>
                  {quote.series.map((sName) => (
                    <Chip key={sName} active={series === sName} label={sName} onPress={() => setSeries(sName)} />
                  ))}
                </ScrollView>
              </>
            )}

            {subjectType === 'character' && (
              <>
                <Text style={s.label}>Character name</Text>
                <TextInput
                  style={s.input}
                  placeholder="e.g. a sword-wielding heroine"
                  placeholderTextColor={colors.textTertiary}
                  value={character}
                  onChangeText={setCharacter}
                  maxLength={60}
                />
              </>
            )}

            {subjectType === 'free' && (
              <>
                <Text style={s.label}>Your prompt</Text>
                <TextInput
                  style={[s.input, { minHeight: 90, textAlignVertical: 'top' }]}
                  placeholder="Describe the scene…"
                  placeholderTextColor={colors.textTertiary}
                  value={freePrompt}
                  onChangeText={setFreePrompt}
                  multiline
                  maxLength={200}
                />
              </>
            )}

            <Text style={s.label}>Style</Text>
            <View style={s.chipRow}>
              {quote.styles.map((st) => (
                <Chip key={st} active={style === st} label={STYLE_LABELS[st] ?? st} onPress={() => setStyle(st)} />
              ))}
            </View>

            <TouchableOpacity
              style={[s.genBtn, busy && { opacity: 0.6 }]}
              onPress={onGenerate}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.genBtnText}>
                  Generate · {quote.price_sakura.toLocaleString()} SKR
                </Text>
              )}
            </TouchableOpacity>

            {gallery.length > 0 && <Text style={s.label}>Your gallery</Text>}
            <View style={s.grid}>
              {gallery.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={s.card}
                  activeOpacity={0.85}
                  onPress={() => {
                    playTap();
                    if (item.status === 'ready') onItemAction(item);
                  }}
                >
                  {item.status === 'ready' && item.public_url ? (
                    <Image source={{ uri: item.public_url }} style={s.img} contentFit="cover" transition={250} />
                  ) : (
                    <View style={s.processing}>
                      <ActivityIndicator color={colors.primary} />
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
