import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  useWindowDimensions,
  Platform,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { useWallet } from '@/lib/wallet/context';
import { sendSakura, SubmittedTransactionError } from '@/lib/wallet/connection';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { pendingCreatorPayment, saveCreatorPayment, clearCreatorPayment } from '@/lib/creator-payments';
import { solanaExplorerTx } from '@/lib/wallet/config';
import { confirmAction, showAlert } from '@/lib/confirm-alert';
import { formatReleaseDate } from '@/lib/format-release-date';
import { useTheme } from '@/lib/theme';
import {
  fetchWorkForReading,
  fetchUnlockedWorkForReading,
  claimCreatorWorkPayment,
  type WorkReadPayload,
  type WorkReadRelease,
} from '@/lib/creator';
import { MEDIA_BASE_DEFAULT } from '@/lib/content-hosts';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import { Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { contentWidth } from '@/constants/layout';

/**
 * Read reactively. This was a module constant off Dimensions.get('window'),
 * captured once at bundle evaluation and never re-read — no listener exists
 * anywhere in the app. contentWidth() rather than the window width, because on
 * desktop web the sidebar is a sibling of the content column and anything sized
 * off the window overflows by exactly SIDEBAR_WIDTH.
 */
function useContentW() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => (Platform.OS === 'web' ? contentWidth(windowW) : windowW), [windowW]);
}

/** Droplet-hosted creator video → absolute URL (web routes via the media proxy). */
function resolveVideoUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const abs = `${MEDIA_BASE_DEFAULT}${path}`;
  return Platform.OS === 'web' ? getWebMediaProxyUrl(abs) : abs;
}

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M19 12H5M12 19l-7-7 7-7" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function WorkScreen() {
  const W = useContentW();
  const { colors } = useTheme();
  const router = useRouter();
  const { connected, address, signWithBiometrics, unlockForAppSession, refreshBalances } = useWallet();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [payload, setPayload] = useState<WorkReadPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkReadRelease | null>(null);
  const [tipping, setTipping] = useState(false);
  const [tipSignature, setTipSignature] = useState<string | null>(null);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [paymentSignature, setPaymentSignature] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const player = useVideoPlayer('', (p) => {
    p.loop = false;
  });

  useEffect(() => {
    let alive = true;
    const workId = typeof id === 'string' ? id : '';
    if (!workId) {
      setError('Missing work.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setSelected(null);
    fetchWorkForReading(workId)
      .then((p) => {
        if (alive) {
          setPayload(p);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load this work.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const workId = payload?.work.id;
    if (!workId || !address) { setPaymentSignature(null); return; }
    let active = true;
    void pendingCreatorPayment(workId, address).then((signature) => {
      if (active) setPaymentSignature(signature);
    });
    return () => { active = false; };
  }, [payload?.work.id, address]);

  // Load the selected anime episode into the player.
  useEffect(() => {
    if (!payload || payload.work.kind !== 'anime' || !selected) return;
    const url = resolveVideoUrl(selected.media?.videoPath);
    if (!url) return;
    try {
      player.replace(url);
      player.play();
    } catch {
      /* player not ready */
    }
  }, [selected, payload, player]);

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.sm,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
    muted: { color: colors.textSecondary, textAlign: 'center' },
    hero: { flexDirection: 'row', gap: 14, padding: Spacing.md },
    cover: { width: 96, height: 144, borderRadius: Radius.md, backgroundColor: colors.surfaceSecondary },
    title: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
    kind: { fontSize: FontSize.xs, color: colors.primary, fontWeight: FontWeight.bold, textTransform: 'uppercase', marginTop: 4, letterSpacing: 0.5 },
    desc: { fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 8, lineHeight: 20 },
    sectionTitle: { fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text, paddingHorizontal: Spacing.md, marginTop: 8, marginBottom: 6 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Spacing.md,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
      gap: 10,
    },
    rowNum: { width: 28, color: colors.textTertiary, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { color: colors.text, fontSize: FontSize.sm },
    rowDate: { color: colors.textTertiary, fontSize: 10, marginTop: 2 },
    readerText: { color: colors.text, fontSize: 17, lineHeight: 27, padding: Spacing.md },
    page: { width: W, height: W * 1.5, backgroundColor: colors.surfaceSecondary },
    video: { width: W, height: W * 0.5625, backgroundColor: '#000' },
  });

  if (loading) {
    return (
      <View style={s.root}>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  if (error || !payload) {
    return (
      <View style={s.root}>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={s.header}>
            <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
              <BackIcon color={colors.text} />
            </TouchableOpacity>
          </View>
          <View style={s.center}>
            <Text style={s.muted}>{error || 'Work not available.'}</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  const { work, releases } = payload;

  const tipCreator = async (amount: number) => {
    if (tipping) return;
    if (!connected || !address) {
      showAlert('Connect wallet', 'Connect your Sakura wallet before sending a tip.');
      return;
    }
    if (address === work.creator_wallet) return;
    const approved = await confirmAction('Send creator tip',
      `Send ${amount.toLocaleString()} SAKURA directly to ${work.creator_wallet.slice(0, 8)}…${work.creator_wallet.slice(-4)}? Network fees may apply.`,
      'Send tip');
    if (!approved) return;
    setTipping(true);
    try {
      const keypair = await signWithBiometrics();
      if (!keypair || keypair.publicKey.toBase58() !== address) {
        throw new Error('Unlock the connected wallet to send your tip.');
      }
      const signature = await sendSakura(keypair, work.creator_wallet, amount);
      setTipSignature(signature);
      void refreshBalances();
      showAlert('Tip sent', `${amount.toLocaleString()} SAKURA was sent to the creator. Transaction: ${signature}`);
    } catch (tipError) {
      showAlert('Tip not confirmed', tipError instanceof Error ? tipError.message : 'Check your wallet before retrying.');
    } finally {
      setTipping(false);
    }
  };

  const openUnlockedWork = async (keypair: Awaited<ReturnType<typeof signWithBiometrics>>) => {
    if (!keypair) throw new Error('Unlock your wallet to read this work.');
    const refreshed = await fetchUnlockedWorkForReading(work.id,
      buildWalletAuthHeaders(keypair, 'read-work-media'));
    if (!refreshed.work.unlocked) throw new Error('This wallet has not unlocked the work yet.');
    setPayload(refreshed);
    if (selected) setSelected(refreshed.releases.find((r) => r.id === selected.id) ?? null);
    setPurchaseError(null);
  };

  const checkAccess = async () => {
    if (!connected || !address) {
      showAlert('Connect wallet', 'Connect the wallet that purchased this work.');
      return;
    }
    setPurchaseBusy(true);
    try {
      await openUnlockedWork(await unlockForAppSession());
    } catch (e) {
      setPurchaseError(e instanceof Error ? e.message : 'Could not check access.');
    } finally {
      setPurchaseBusy(false);
    }
  };

  const claimPayment = async (signature: string, keypair: Awaited<ReturnType<typeof signWithBiometrics>>) => {
    if (!keypair) throw new Error('Unlock the paying wallet to finish access.');
    await claimCreatorWorkPayment(work.id, signature,
      buildWalletAuthHeaders(keypair, 'purchase-creator-work'));
    await openUnlockedWork(keypair);
    await clearCreatorPayment(work.id, keypair.publicKey.toBase58());
    setPaymentSignature(null);
    void refreshBalances();
  };

  const finishPayment = async () => {
    if (!paymentSignature) return;
    setPurchaseBusy(true);
    try {
      const keypair = await unlockForAppSession();
      if (!keypair || keypair.publicKey.toBase58() !== address) {
        throw new Error('Unlock the wallet that made the payment.');
      }
      await claimPayment(paymentSignature, keypair);
    } catch (e) {
      setPurchaseError(e instanceof Error ? e.message : 'Could not confirm payment.');
    } finally {
      setPurchaseBusy(false);
    }
  };

  const buyWork = async () => {
    if (!connected || !address) {
      showAlert('Connect wallet', 'Connect your Sakura wallet to purchase this work.');
      return;
    }
    if (paymentSignature) return;
    const price = Number(work.price_sakura);
    const approved = await confirmAction('Unlock this work',
      `Send ${price.toLocaleString()} SAKURA directly to the creator wallet ${work.creator_wallet.slice(0, 8)}…${work.creator_wallet.slice(-4)}? This unlocks the complete work for this wallet. Network fees may apply.`,
      `Pay ${price.toLocaleString()} SKR`);
    if (!approved) return;
    setPurchaseBusy(true);
    setPurchaseError(null);
    try {
      const keypair = await signWithBiometrics();
      if (!keypair || keypair.publicKey.toBase58() !== address) {
        throw new Error('Unlock the connected wallet to pay.');
      }
      const saved = await pendingCreatorPayment(work.id, address);
      if (saved) {
        setPaymentSignature(saved);
        throw new Error('This wallet already submitted a payment. Finish access with the saved transaction; do not pay again.');
      }
      const current = await fetchUnlockedWorkForReading(work.id,
        buildWalletAuthHeaders(keypair, 'read-work-media'));
      if (current.work.unlocked) {
        setPayload(current);
        if (selected) setSelected(current.releases.find((r) => r.id === selected.id) ?? null);
        return;
      }
      let signature: string;
      try {
        signature = await sendSakura(keypair, work.creator_wallet, price);
      } catch (error) {
        if (!(error instanceof SubmittedTransactionError)) throw error;
        signature = error.signature;
        setPaymentSignature(signature);
        await saveCreatorPayment(work.id, address, signature);
        throw new Error(`Payment was submitted. Use “Finish access” with transaction ${signature}; do not pay again.`);
      }
      setPaymentSignature(signature);
      await saveCreatorPayment(work.id, address, signature);
      await claimPayment(signature, keypair);
    } catch (e) {
      setPurchaseError(e instanceof Error ? e.message : 'Payment could not be completed.');
    } finally {
      setPurchaseBusy(false);
    }
  };

  const accessPanel = (
    <View style={{ padding: Spacing.md, gap: Spacing.sm }}>
      <Text style={s.title}>{Number(work.price_sakura).toLocaleString()} SAKURA to unlock</Text>
      <Text style={s.desc}>One payment unlocks the complete work for this wallet. SAKURA goes directly to the creator.</Text>
      {purchaseError ? <Text style={{ color: colors.red, fontSize: FontSize.sm }}>{purchaseError}</Text> : null}
      <TouchableOpacity disabled={purchaseBusy} onPress={onTap(() => { void checkAccess(); })}
        accessibilityRole="button" style={{ padding: 12, borderRadius: Radius.md,
          backgroundColor: colors.surfaceSecondary, opacity: purchaseBusy ? 0.5 : 1 }}>
        <Text style={{ color: colors.primary, fontWeight: FontWeight.bold }}>Already purchased? Check access</Text>
      </TouchableOpacity>
      <TouchableOpacity disabled={purchaseBusy}
        onPress={onTap(() => { void (paymentSignature ? finishPayment() : buyWork()); })}
        accessibilityRole="button" style={{ padding: 14, borderRadius: Radius.md,
          backgroundColor: colors.primary, opacity: purchaseBusy ? 0.5 : 1 }}>
        <Text style={{ color: '#fff', fontWeight: FontWeight.bold, textAlign: 'center' }}>
          {purchaseBusy ? 'Checking…' : paymentSignature ? 'Finish access with the same payment' : 'Pay creator and unlock'}
        </Text>
      </TouchableOpacity>
      {paymentSignature ? <TouchableOpacity accessibilityRole="link"
        onPress={onTap(() => { void Linking.openURL(solanaExplorerTx(paymentSignature)); })}>
        <Text style={{ color: colors.primary }}>View submitted payment ↗</Text>
      </TouchableOpacity> : null}
    </View>
  );

  // ── Reading a single release ──
  if (selected) {
    if (selected.locked) {
      return <View style={s.root}><SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity style={s.iconBtn} onPress={onTap(() => setSelected(null))} hitSlop={10}>
            <BackIcon color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle} numberOfLines={1}>{selected.title}</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
          {!!selected.summary && <Text style={s.desc}>{selected.summary}</Text>}
          {accessPanel}
        </ScrollView>
      </SafeAreaView></View>;
    }
    const attachments = selected.media?.attachments ?? [];
    const downloads = attachments.length ? (
      <View style={{ padding: Spacing.md, gap: Spacing.sm }}>
        <Text style={s.sectionTitle}>Downloads</Text>
        {attachments.map((file, index) => (
          <TouchableOpacity key={`${file.url}-${index}`}
            accessibilityRole="link"
            accessibilityLabel={`Download ${file.name}`}
            onPress={onTap(() => { void Linking.openURL(file.url); })}
            style={{ padding: Spacing.sm, borderRadius: Radius.md,
              backgroundColor: colors.surfaceSecondary }}>
            <Text style={{ color: colors.primary, fontWeight: FontWeight.bold }} numberOfLines={2}>
              {file.name} ↓
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs }}>
              {(file.sizeBytes / 1024 / 1024).toFixed(1)} MB
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    ) : null;
    return (
      <View style={s.root}>
        <SafeAreaView style={{ flex: 1 }} edges={['top']}>
          <View style={s.header}>
            <TouchableOpacity style={s.iconBtn} onPress={onTap(() => setSelected(null))} hitSlop={10}>
              <BackIcon color={colors.text} />
            </TouchableOpacity>
            <Text style={s.headerTitle} numberOfLines={1}>{selected.title}</Text>
          </View>

          {work.kind === 'novel' && (
            <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
              <Text style={s.readerText}>{selected.body_text || 'This chapter has no text yet.'}</Text>
              {downloads}
            </ScrollView>
          )}

          {work.kind === 'manga' && (
            <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
              {(selected.media?.pages ?? []).length === 0 ? (
                <View style={s.center}><Text style={s.muted}>No pages in this chapter yet.</Text></View>
              ) : (
                (selected.media?.pages ?? []).map((uri, i) => (
                  <Image key={`${uri}-${i}`} source={{ uri }} style={s.page} contentFit="contain" transition={200} />
                ))
              )}
              {downloads}
            </ScrollView>
          )}

          {work.kind === 'anime' && (
            <View style={{ flex: 1 }}>
              {resolveVideoUrl(selected.media?.videoPath) ? (
                <VideoView style={s.video} player={player} nativeControls contentFit="contain" />
              ) : (
                <View style={s.center}><Text style={s.muted}>This episode has no video yet.</Text></View>
              )}
              {!!selected.summary && <Text style={[s.desc, { paddingHorizontal: Spacing.md }]}>{selected.summary}</Text>}
              {downloads}
            </View>
          )}
        </SafeAreaView>
      </View>
    );
  }

  // ── Work detail (chapter / episode list) ──
  const listLabel = work.kind === 'anime' ? 'Episodes' : 'Chapters';
  return (
    <View style={s.root}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity style={s.iconBtn} onPress={onTap(() => router.back())} hitSlop={10}>
            <BackIcon color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle} numberOfLines={1}>{work.title}</Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 80 }} showsVerticalScrollIndicator={false}>
          <View style={s.hero}>
            {work.cover_url ? (
              <Image source={{ uri: work.cover_url }} style={s.cover} contentFit="cover" transition={250} />
            ) : (
              <View style={s.cover} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.title} numberOfLines={3}>{work.title}</Text>
              <Text style={s.kind}>{work.kind}</Text>
              {Number(work.price_sakura) > 0 && (
                <Text style={[s.desc, { color: colors.primary }]}>
                  {Number(work.price_sakura).toLocaleString()} SAKURA · complete work
                </Text>
              )}
              {!!work.description && <Text style={s.desc} numberOfLines={6}>{work.description}</Text>}
            </View>
          </View>

          {address !== work.creator_wallet ? (
            <View style={{ paddingHorizontal: Spacing.md, paddingBottom: Spacing.md }}>
              <Text style={[s.sectionTitle, { paddingHorizontal: 0 }]}>Support this creator</Text>
              <Text style={s.desc}>Tips go directly to the creator wallet in SAKURA.</Text>
              <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm }}>
                {[10, 100, 1000].map((amount) => (
                  <TouchableOpacity key={amount} disabled={tipping}
                    accessibilityRole="button"
                    accessibilityLabel={`Tip ${amount} SAKURA`}
                    onPress={onTap(() => { void tipCreator(amount); })}
                    style={{ flex: 1, paddingVertical: 10, borderRadius: Radius.md,
                      alignItems: 'center', backgroundColor: colors.surfaceSecondary,
                      opacity: tipping ? 0.5 : 1 }}>
                    <Text style={{ color: colors.primary, fontWeight: FontWeight.bold }}>
                      {amount.toLocaleString()} SKR
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {tipSignature ? (
                <TouchableOpacity accessibilityRole="link"
                  onPress={onTap(() => { void Linking.openURL(solanaExplorerTx(tipSignature)); })}
                  style={{ marginTop: Spacing.sm }}>
                  <Text style={{ color: colors.primary }}>View confirmed tip transaction ↗</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          <Text style={s.sectionTitle}>{listLabel}</Text>
          {Number(work.price_sakura) > 0 && !work.unlocked ? accessPanel : null}
          {releases.length === 0 ? (
            <View style={s.center}><Text style={s.muted}>No {listLabel.toLowerCase()} published yet.</Text></View>
          ) : (
            releases.map((r) => (
              <TouchableOpacity key={r.id} style={s.row} activeOpacity={0.7} onPress={onTap(() => setSelected(r))}>
                <Text style={s.rowNum}>{r.sequence_number}</Text>
                {/* Title and date stack, so the row needs a wrapper — it is a
                    horizontal flex. Unpublished releases have no date. */}
                <View style={s.rowText}>
                  <Text style={s.rowTitle} numberOfLines={1}>{r.title}</Text>
                  {r.locked ? <Text style={s.rowDate}>Locked · one payment unlocks all {listLabel.toLowerCase()}</Text> : null}
                  {!!formatReleaseDate(r.published_at) && (
                    <Text style={s.rowDate}>{formatReleaseDate(r.published_at)}</Text>
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
