import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import Svg, { Path } from 'react-native-svg';
import { onTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import { unlockForAppSession } from '@/lib/wallet/app-session';
import { sendSakura } from '@/lib/wallet/connection';
import {
  buildPoseAuthHeaders,
  fetchPoseQuote,
  generatePose,
  type PoseQuote,
} from '@/lib/pose-studio';
import { listFanArt, setFanArtAsAvatar, type FanArtItem } from '@/lib/fan-art';
import { MAX_CONTENT_WIDTH } from '@/constants/layout';
import { Spacing, Radius, FontSize, FontWeight, Fonts, Shadow } from '@/constants/theme';

/**
 * Pose Studio — upload a photo, get it restaged into a chosen pose and setting.
 *
 * Unlike Fan-Art Studio (text-to-image), the subject here is the user's own
 * photo, so the source never leaves the request: it is downscaled on-device,
 * sent inline, and only the generated result is stored.
 */
/** The theme has no error token; this reads correctly on both light and dark. */
const ERROR_TINT = '#E5484D';

export default function PoseStudioScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { connected, restoring } = useWallet();
  const { width: W } = useWindowDimensions();
  const contentWidth = Math.min(W, MAX_CONTENT_WIDTH);

  const [quote, setQuote] = useState<PoseQuote | null>(null);
  const [gallery, setGallery] = useState<FanArtItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [poseId, setPoseId] = useState<string>('todo');
  const [hint, setHint] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kp = await unlockForAppSession();
      if (!kp) {
        setLoading(false);
        return;
      }
      const headers = buildPoseAuthHeaders(kp);
      const [q, items] = await Promise.all([fetchPoseQuote(headers), listFanArt(headers)]);
      setQuote(q);
      setGallery(items.filter((it) => it.subject_type === 'pose'));
      if (q.poses.length && !q.poses.some((p) => p.id === poseId)) setPoseId(q.poses[0].id);
    } catch (e) {
      showAlert('Pose Studio', e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, [poseId]);

  useEffect(() => {
    // Don't judge the session until it has been read back, or a cold load shows
    // "connect your wallet" to someone who is already connected.
    if (restoring) return;
    if (connected) load();
    else setLoading(false);
    // load() is intentionally not a dep — it changes with poseId and would refetch
    // the quote every time the user picks a different pose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, restoring]);

  const onPick = useCallback(async () => {
    try {
      // Web uses a file input under the hood and needs no permission grant.
      if (Platform.OS !== 'web') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          showAlert('Photos', 'Allow photo access to pick an image.');
          return;
        }
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
        allowsMultipleSelection: false,
      });
      if (res.canceled || !res.assets?.length) return;
      setImageUri(res.assets[0].uri);
      setResult(null);
    } catch (e) {
      showAlert('Photos', e instanceof Error ? e.message : 'Could not open your photos.');
    }
  }, []);

  const onGenerate = useCallback(async () => {
    if (!quote || busy) return;
    if (!imageUri) {
      showAlert('Pose Studio', 'Pick a photo first.');
      return;
    }
    setBusy(true);
    setError(null);
    // Hoisted out of the try: if generation fails AFTER the transfer lands, the
    // user has been charged and needs the signature. A dismissible alert is not
    // enough — and on web RN's Alert renders nothing at all, so a paid-but-failed
    // run used to leave the screen looking as if nothing had happened.
    let paymentTxSignature: string | undefined;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const kp = await unlockForAppSession();
      if (!kp) throw new Error('Unlock your wallet to continue.');
      const headers = buildPoseAuthHeaders(kp);
      paymentTxSignature = await sendSakura(kp, quote.payment_wallet, quote.price_sakura);
      const res = await generatePose(
        { imageUri, poseId, hint: hint.trim() || undefined, paymentTxSignature },
        headers,
      );
      const items = await listFanArt(headers);
      setGallery(items.filter((it) => it.subject_type === 'pose'));
      if (res.public_url) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setResult(res.public_url);
      } else {
        // Paid and accepted, but still rendering — say so rather than showing
        // an idle screen that reads as "nothing happened".
        setError('Payment went through and your pose is still rendering. It will appear under "Your poses" shortly.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Try again.';
      setError(
        paymentTxSignature
          ? `${message}\n\nYour ${quote.price_sakura.toLocaleString()} ${quote.currency} payment was already sent (tx ${paymentTxSignature.slice(0, 8)}…). Quote that ID to support — do not pay again.`
          : message,
      );
      showAlert('Pose failed', message);
    } finally {
      setBusy(false);
    }
  }, [quote, busy, imageUri, poseId, hint]);

  const onUseAsAvatar = useCallback(async (id: string) => {
    try {
      const kp = await unlockForAppSession();
      if (!kp) return;
      await setFanArtAsAvatar(id, buildPoseAuthHeaders(kp));
      showAlert('Done', 'Avatar updated.');
    } catch (e) {
      showAlert('Failed', e instanceof Error ? e.message : 'Try again.');
    }
  }, []);

  const activePose = quote?.poses.find((p) => p.id === poseId);

  const s = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.background },
        body: { width: contentWidth, alignSelf: 'center' },
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
        label: {
          fontSize: FontSize.sm,
          fontWeight: FontWeight.bold,
          color: colors.text,
          paddingHorizontal: Spacing.md,
          marginTop: 14,
          marginBottom: 8,
        },
        dropZone: {
          marginHorizontal: Spacing.md,
          height: contentWidth * 0.62,
          borderRadius: Radius.lg,
          borderWidth: 2,
          borderStyle: 'dashed',
          borderColor: colors.border,
          backgroundColor: colors.surfaceSecondary,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          gap: 8,
        },
        dropText: { color: colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.bodyMedium },
        dropHint: { color: colors.textSecondary, fontSize: FontSize.xs, opacity: 0.75 },
        preview: { width: '100%', height: '100%' },
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
        blurb: {
          paddingHorizontal: Spacing.md,
          marginTop: 8,
          color: colors.textSecondary,
          fontSize: FontSize.xs,
          lineHeight: 17,
        },
        input: {
          marginHorizontal: Spacing.md,
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.md,
          padding: 12,
          color: colors.text,
          fontSize: FontSize.sm,
        },
        genBtn: {
          margin: Spacing.md,
          backgroundColor: colors.primary,
          borderRadius: Radius.full,
          paddingVertical: 15,
          alignItems: 'center',
          ...Shadow.sm,
        },
        genBtnDisabled: { opacity: 0.5 },
        // Errors render inline, not only in a dismissible alert: a failure that
        // happens after payment must stay on screen with the tx reference.
        errorBox: {
          marginHorizontal: Spacing.md,
          marginTop: 4,
          padding: 12,
          borderRadius: Radius.md,
          borderWidth: 1,
          borderColor: ERROR_TINT,
          backgroundColor: `${ERROR_TINT}18`,
        },
        errorText: { color: colors.text, fontSize: FontSize.sm, lineHeight: 19 },
        genBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
        resultWrap: {
          marginHorizontal: Spacing.md,
          borderRadius: Radius.lg,
          overflow: 'hidden',
          backgroundColor: colors.surfaceSecondary,
          height: contentWidth * 0.95,
        },
        resultImg: { width: '100%', height: '100%' },
        rowBtns: { flexDirection: 'row', gap: 8, paddingHorizontal: Spacing.md, marginTop: 10 },
        smallBtn: {
          flex: 1,
          borderRadius: Radius.full,
          paddingVertical: 11,
          alignItems: 'center',
          borderWidth: 1.5,
          borderColor: colors.border,
          backgroundColor: colors.surfaceSecondary,
        },
        smallBtnText: { color: colors.text, fontSize: FontSize.sm, fontFamily: Fonts.bodyBold },
        grid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 10,
          paddingHorizontal: Spacing.md,
          paddingBottom: 60,
        },
        card: {
          width: (contentWidth - Spacing.md * 2 - 10) / 2,
          height: ((contentWidth - Spacing.md * 2 - 10) / 2) * 1.33,
          borderRadius: Radius.md,
          overflow: 'hidden',
          backgroundColor: colors.surfaceSecondary,
        },
        img: { width: '100%', height: '100%' },
        processing: { alignItems: 'center', justifyContent: 'center', flex: 1 },
        center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
        muted: { color: colors.textSecondary, textAlign: 'center' },
      }),
    [colors, contentWidth],
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
              <Path
                d="M19 12H5M12 19l-7-7 7-7"
                stroke={colors.text}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Pose Studio</Text>
        </View>

        {loading || restoring ? (
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : !connected ? (
          <View style={s.center}>
            <Text style={s.muted}>Connect your wallet to use Pose Studio.</Text>
          </View>
        ) : !quote ? (
          // A failed quote fetch is NOT a disconnected wallet. Collapsing the two
          // into one "connect your wallet" message tells a connected user to do
          // something they have already done, and hides the real fault.
          <View style={s.center}>
            <Text style={s.muted}>Couldn&apos;t load Pose Studio. Check your connection and try again.</Text>
            <TouchableOpacity style={[s.smallBtn, { marginTop: 14, flex: 0, paddingHorizontal: 28 }]} onPress={onTap(load)} activeOpacity={0.8}>
              <Text style={s.smallBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={s.body}>
              <Text style={s.label}>Your photo</Text>
              <TouchableOpacity style={s.dropZone} onPress={onTap(onPick)} activeOpacity={0.85}>
                {imageUri ? (
                  <Image source={{ uri: imageUri }} style={s.preview} contentFit="cover" />
                ) : (
                  <>
                    <Svg width={34} height={34} viewBox="0 0 24 24" fill="none">
                      <Path
                        d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                        stroke={colors.textSecondary}
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </Svg>
                    <Text style={s.dropText}>Tap to choose a photo</Text>
                    <Text style={s.dropHint}>A clear, front-facing shot works best</Text>
                  </>
                )}
              </TouchableOpacity>
              {imageUri ? (
                <View style={s.rowBtns}>
                  <TouchableOpacity style={s.smallBtn} onPress={onTap(onPick)} activeOpacity={0.8}>
                    <Text style={s.smallBtnText}>Change photo</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              <Text style={s.label}>Pose</Text>
              <View style={s.chipRow}>
                {quote.poses.map((p) => (
                  <Chip key={p.id} active={poseId === p.id} label={p.label} onPress={() => setPoseId(p.id)} />
                ))}
              </View>
              {activePose ? <Text style={s.blurb}>{activePose.blurb}</Text> : null}

              <Text style={s.label}>Anything to keep? (optional)</Text>
              <TextInput
                style={s.input}
                value={hint}
                onChangeText={setHint}
                placeholder="e.g. keep my glasses and hoodie"
                placeholderTextColor={colors.textSecondary}
                maxLength={120}
              />

              <TouchableOpacity
                style={[s.genBtn, (busy || !imageUri) && s.genBtnDisabled]}
                onPress={onTap(onGenerate)}
                activeOpacity={0.85}
                disabled={busy || !imageUri}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={s.genBtnText}>
                    Generate · {quote.price_sakura.toLocaleString()} {quote.currency}
                  </Text>
                )}
              </TouchableOpacity>

              {error ? (
                <View style={s.errorBox}>
                  <Text style={s.errorText}>{error}</Text>
                </View>
              ) : null}

              {result ? (
                <>
                  <Text style={s.label}>Result</Text>
                  <View style={s.resultWrap}>
                    <Image source={{ uri: result }} style={s.resultImg} contentFit="contain" />
                  </View>
                </>
              ) : null}

              {gallery.length ? (
                <>
                  <Text style={s.label}>Your poses</Text>
                  <View style={s.grid}>
                    {gallery.map((item) => (
                      <TouchableOpacity
                        key={item.id}
                        style={s.card}
                        activeOpacity={0.85}
                        onPress={onTap(() => {
                          if (item.public_url) setResult(item.public_url);
                          else if (item.status === 'processing') return;
                        })}
                        onLongPress={() => onUseAsAvatar(item.id)}
                      >
                        {item.public_url ? (
                          <Image source={{ uri: item.public_url }} style={s.img} contentFit="cover" />
                        ) : (
                          <View style={s.processing}>
                            <ActivityIndicator color={colors.primary} />
                          </View>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
