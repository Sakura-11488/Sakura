import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Animated, { FadeInUp } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { onTap } from '@/lib/sound';
import { CreatorUploadSkeleton } from '@/components/creator/CreatorSkeletons';
import {
  CreatorScreenHeader,
  StepIndicator,
  KindSelector,
  FormSection,
  FormField,
  CoverPicker,
} from '@/components/creator/CreatorForm';
import { FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import {
  createCreatorWork,
  createWorkRelease,
  getCreatorProfile,
  type CreatorWorkKind,
} from '@/lib/creator';
import {
  uploadMangaPages,
  uploadAnimeEpisodeVideo,
  uploadWorkImage,
  checkMediaIngestReachable,
} from '@/lib/creator-media';
import { showAlert } from '@/lib/confirm-alert';
import {
  publishWorkViaApi,
  registerWorkMintOnChain,
  verifyWorkMint,
} from '@/lib/work-mint';

export default function CreatorUploadScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connected, address, restoring, signWithBiometrics } = useWallet();

  const [checking, setChecking] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [workKind, setWorkKind] = useState<CreatorWorkKind>('novel');
  const [workTitle, setWorkTitle] = useState('');
  const [workDescription, setWorkDescription] = useState('');
  const [releaseTitle, setReleaseTitle] = useState('');
  const [releaseBody, setReleaseBody] = useState('');
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [mangaPageUris, setMangaPageUris] = useState<string[]>([]);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<unknown>(null);
  const [mediaProgress, setMediaProgress] = useState<string | null>(null);
  const [mintAsNft, setMintAsNft] = useState(true);

  useFocusEffect(
    useCallback(() => {
      // Wait for the stored session to load before judging. On a cold load
      // (PWA relaunch, direct URL, refresh) this ran before the restore had even
      // started, bouncing an already-connected creator to "Connect your account".
      if (restoring) return;
      if (!connected || !address) {
        router.replace('/become-creator');
        return;
      }
      setChecking(true);
      getCreatorProfile(address)
        .then((p) => {
          if (!p.username) router.replace('/become-creator');
        })
        .finally(() => setChecking(false));
    }, [restoring, connected, address, router]),
  );

  const step = useMemo((): 1 | 2 | 3 => {
    if (!workTitle.trim()) return 1;
    if (!releaseTitle.trim()) return 2;
    return 3;
  }, [workTitle, releaseTitle]);

  const pickCover = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      showAlert('Photos', 'Allow photo access to upload a cover.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [2, 3],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      setCoverUri(result.assets[0].uri);
    }
  };

  const pickMangaPages = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      showAlert('Photos', 'Allow photo access to add chapter pages.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: 60,
      quality: 0.8,
    });
    if (!result.canceled && result.assets.length) {
      setMangaPageUris(result.assets.map((a) => a.uri));
    }
  };

  const pickEpisodeVideo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      showAlert('Videos', 'Allow media access to add your episode.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: false,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (asset?.uri) {
      setVideoUri(asset.uri);
      setVideoName(asset.fileName ?? asset.uri.split('/').pop() ?? 'episode.mp4');
      // On web the picker returns a real File. Keep it — a browser cannot upload
      // from the {uri,name,type} descriptor the native path uses.
      setVideoFile((asset as { file?: unknown }).file ?? null);
    }
  };

  const handleUpload = async () => {
    if (!address) return;
    if (!workTitle.trim()) {
      showAlert('Title required', 'Give your work a title.');
      return;
    }
    if (!releaseTitle.trim()) {
      showAlert('Release required', 'Add a chapter or episode title.');
      return;
    }
    if (workKind === 'novel' && !releaseBody.trim()) {
      showAlert('Content required', 'Paste or write your chapter text.');
      return;
    }

    // Disable the button BEFORE the network probe below. The probe is a real
    // round trip, and leaving the button live across it let a second tap start a
    // parallel handleUpload — two works, two releases, two mints.
    setUploading(true);

    // Anime publishing depends on an external media host. Probe it BEFORE any
    // rows are created: a dead host used to throw midway through, after the work
    // and release already existed, stranding an unpublished draft every attempt.
    if (workKind === 'anime' && videoUri) {
      setMediaProgress('Checking video server…');
      const blocked = await checkMediaIngestReachable();
      setMediaProgress(null);
      if (blocked) {
        setUploading(false);
        showAlert('Cannot publish episode', blocked);
        return;
      }
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      const work = await createCreatorWork({
        walletAddress: address,
        kind: workKind,
        title: workTitle,
        description: workDescription,
      });

      const release = await createWorkRelease({
        workId: work.id,
        kind: workKind,
        title: releaseTitle,
        summary: workDescription,
        bodyText: releaseBody,
      });

      const kp = await signWithBiometrics();
      if (!kp) throw new Error('Could not unlock account.');

      // Cover goes through the ownership-checked upload-work-media edge function
      // (service role), same as manga pages — a direct client storage write is
      // blocked by RLS since the app authenticates by wallet, not a Supabase
      // session. The function also records release_metadata.cover_url so the
      // catalog + detail screens can display it.
      let coverUrl: string | null = null;
      let coverFailed = false;
      if (coverUri) {
        try {
          const uploaded = await uploadWorkImage({
            keypair: kp,
            workId: work.id,
            role: 'cover',
            localUri: coverUri,
          });
          coverUrl = uploaded.url;
        } catch (e) {
          console.warn('[creator-upload] cover upload failed:', e);
          coverFailed = true;
        }
      }

      let pagesFailed: number[] = [];
      if (workKind === 'manga' && mangaPageUris.length) {
        const pageResult = await uploadMangaPages({
          keypair: kp,
          workId: work.id,
          releaseId: release.id,
          localUris: mangaPageUris,
          onProgress: (done, total) => setMediaProgress(`Uploading pages ${done}/${total}…`),
        });
        pagesFailed = pageResult.failed;
      }

      if (workKind === 'anime' && videoUri) {
        setMediaProgress('Uploading episode video…');
        await uploadAnimeEpisodeVideo({
          keypair: kp,
          workId: work.id,
          releaseId: release.id,
          localUri: videoUri,
          fileName: videoName ?? undefined,
          file: videoFile ?? undefined,
        });
      }
      setMediaProgress(null);

      if (mintAsNft) {
        const txSignature = await registerWorkMintOnChain(kp, work.id, workTitle.trim());
        await verifyWorkMint(kp, {
          workId: work.id,
          title: workTitle.trim(),
          kind: workKind,
          coverUrl,
          txSignature,
        });
      }

      const result = await publishWorkViaApi(kp, work.id);

      const notified = result.followers_notified
        ? ` ${result.followers_notified} subscribers notified.`
        : '';
      const warnings: string[] = [];
      if (coverFailed) {
        warnings.push('Cover art couldn’t be uploaded — add it later from your dashboard.');
      }
      if (pagesFailed.length) {
        warnings.push(
          `${pagesFailed.length} page${pagesFailed.length > 1 ? 's' : ''} couldn’t be uploaded (page ${pagesFailed.join(', ')}). Re-add them from your dashboard.`,
        );
      }
      const base = mintAsNft
        ? `Your work is live. NFT receipt registered to your account.${notified}`
        : `Your work is live on Sakura.${notified}`;
      const body = warnings.length ? `${base}\n\n⚠️ ${warnings.join('\n')}` : base;

      // RN Alert is a no-op on web, so this button's onPress never fired there —
      // a successful publish left the creator sitting on the form with no
      // confirmation and no navigation. Navigate unconditionally instead.
      showAlert(mintAsNft ? 'Published & minted' : 'Published', body);
      router.replace('/creator-dashboard');
    } catch (e) {
      showAlert('Upload failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setMediaProgress(null);
      setUploading(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        footer: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: Spacing.md,
          paddingTop: Spacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.borderLight,
          backgroundColor: colors.background,
          ...Shadow.sm,
        },
        footerHint: {
          fontSize: FontSize.xs,
          color: colors.textSecondary,
          textAlign: 'center',
          marginBottom: Spacing.sm,
        },
        primaryBtn: {
          backgroundColor: colors.primary,
          borderRadius: Radius.full,
          paddingVertical: 15,
          alignItems: 'center',
          ...Shadow.sm,
        },
        primaryBtnDisabled: { opacity: 0.55 },
        primaryBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  if (checking) return <CreatorUploadSkeleton />;

  const canPublish =
    workTitle.trim().length > 0 &&
    releaseTitle.trim().length > 0 &&
    (workKind !== 'novel' || releaseBody.trim().length > 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <CreatorScreenHeader
        title="New release"
        subtitle="Publish to Sakura"
        colors={colors}
        onBack={onTap(() => router.back())}
      />
      <StepIndicator step={step} colors={colors} />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}
        >
          <Animated.View entering={FadeInUp.duration(350)}>
            <FormSection
              title="What are you publishing?"
              subtitle="Choose a format and optional cover art."
              colors={colors}
            >
              <KindSelector value={workKind} onChange={setWorkKind} colors={colors} />
              <CoverPicker uri={coverUri} onPress={pickCover} colors={colors} />
            </FormSection>

            <FormSection
              title="Series details"
              subtitle="How readers discover your work in the catalog."
              colors={colors}
            >
              <FormField
                label="Series title"
                hint="The name of your novel, manga, or show"
                colors={colors}
                value={workTitle}
                onChangeText={setWorkTitle}
                placeholder="e.g. Sakura Chronicles"
              />
              <FormField
                label="Synopsis"
                hint="A short hook — shown on your series page"
                colors={colors}
                value={workDescription}
                onChangeText={setWorkDescription}
                multiline
                placeholder="What is your story about?"
                inputStyle={{ minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }}
              />
            </FormSection>

            <FormSection
              title={workKind === 'anime' ? 'First episode' : 'First chapter'}
              subtitle="This release goes live immediately after publishing."
              colors={colors}
            >
              <FormField
                label={workKind === 'anime' ? 'Episode title' : 'Chapter title'}
                colors={colors}
                value={releaseTitle}
                onChangeText={setReleaseTitle}
                placeholder={workKind === 'novel' ? 'Chapter 1 — The Beginning' : 'Episode 1 — Pilot'}
              />
              {workKind === 'novel' && (
                <FormField
                  label="Chapter content"
                  hint="Paste or write your full chapter text"
                  colors={colors}
                  value={releaseBody}
                  onChangeText={setReleaseBody}
                  multiline
                  placeholder="Once upon a time…"
                  inputStyle={{ minHeight: 200, textAlignVertical: 'top', paddingTop: 12 }}
                />
              )}
              {workKind === 'manga' && (
                <TouchableOpacity
                  onPress={onTap(pickMangaPages)}
                  activeOpacity={0.85}
                  style={{
                    backgroundColor: colors.surfaceSecondary,
                    borderRadius: Radius.lg,
                    padding: 14,
                    borderWidth: 1,
                    borderStyle: mangaPageUris.length ? 'solid' : 'dashed',
                    borderColor: mangaPageUris.length ? colors.primary : colors.border,
                  }}
                >
                  <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text }}>
                    {mangaPageUris.length
                      ? `${mangaPageUris.length} pages selected`
                      : 'Add chapter pages'}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 18 }}>
                    {mangaPageUris.length
                      ? 'Tap to re-select. Pages upload in the order you picked them.'
                      : 'Select your page images in reading order (up to 60).'}
                  </Text>
                </TouchableOpacity>
              )}
              {workKind === 'anime' && (
                <TouchableOpacity
                  onPress={onTap(pickEpisodeVideo)}
                  activeOpacity={0.85}
                  style={{
                    backgroundColor: colors.surfaceSecondary,
                    borderRadius: Radius.lg,
                    padding: 14,
                    borderWidth: 1,
                    borderStyle: videoUri ? 'solid' : 'dashed',
                    borderColor: videoUri ? colors.primary : colors.border,
                  }}
                >
                  <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text }}>
                    {videoUri ? videoName ?? 'Episode video selected' : 'Add episode video'}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 18 }}>
                    {videoUri
                      ? 'Tap to replace. A poster frame is generated automatically.'
                      : 'MP4, MOV, or WebM. Hosted on the Sakura media server — a thumbnail is generated for you.'}
                  </Text>
                </TouchableOpacity>
              )}
            </FormSection>

            <FormSection
              title="NFT ownership"
              subtitle="Register this work on-chain to your Sakura account when you publish."
              colors={colors}
            >
              <TouchableOpacity
                onPress={() => setMintAsNft((v) => !v)}
                activeOpacity={0.85}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: colors.surfaceSecondary,
                  borderRadius: Radius.lg,
                  padding: 14,
                  borderWidth: 1,
                  borderColor: mintAsNft ? colors.primary : colors.border,
                }}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text }}>
                    Mint to my account
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 18 }}>
                    Signs a receipt on Solana and links it to your wallet — like Sakura Studio.
                  </Text>
                </View>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    borderWidth: 2,
                    borderColor: mintAsNft ? colors.primary : colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: mintAsNft ? colors.primary : 'transparent',
                  }}
                >
                  {mintAsNft ? <Text style={{ color: '#fff', fontSize: 12 }}>✓</Text> : null}
                </View>
              </TouchableOpacity>
            </FormSection>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
        <Text style={styles.footerHint}>
          {mediaProgress
            ? mediaProgress
            : canPublish
              ? mintAsNft
                ? 'Publish publicly and mint NFT receipt to your account'
                : 'Ready to publish publicly on Sakura'
              : 'Fill in series title and release title to continue'}
        </Text>
        <TouchableOpacity
          style={[styles.primaryBtn, (!canPublish || uploading) && styles.primaryBtnDisabled]}
          onPress={handleUpload}
          disabled={!canPublish || uploading}
          activeOpacity={0.85}
        >
          {uploading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>{mintAsNft ? 'Publish & Mint' : 'Publish to Sakura'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
