import React, { useCallback, useMemo, useRef, useState } from 'react';
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
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import Animated, { FadeInUp } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
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
  getCreatorWorks,
  getWorkReleases,
  getWorkAssets,
  updateCreatorDraft,
  type CreatorWorkKind,
} from '@/lib/creator';
import {
  uploadMangaPages,
  uploadAnimeEpisodeVideo,
  uploadWorkImage,
  checkMediaIngestReachable,
} from '@/lib/creator-media';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { uploadCreatorAttachment } from '@/lib/creator-attachments';
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
  const { connected, address, restoring, signWithBiometrics, unlockForAppSession } = useWallet();
  const { workId: requestedWorkId } = useLocalSearchParams<{ workId?: string }>();
  const pendingRef = useRef<{
    workId: string;
    releaseId: string | null;
    kind: CreatorWorkKind;
    uploadedPages: Set<number>;
    expectedPages: number;
    videoUploaded: boolean;
    coverUrl: string | null;
    uploadedAttachmentNames: Set<string>;
  } | null>(null);
  const [draftWorkId, setDraftWorkId] = useState<string | null>(null);

  const [checking, setChecking] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [workKind, setWorkKind] = useState<CreatorWorkKind>('novel');
  const [workTitle, setWorkTitle] = useState('');
  const [workDescription, setWorkDescription] = useState('');
  const [priceText, setPriceText] = useState('0');
  const [releaseTitle, setReleaseTitle] = useState('');
  const [releaseBody, setReleaseBody] = useState('');
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [mangaPageUris, setMangaPageUris] = useState<string[]>([]);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<unknown>(null);
  const [attachments, setAttachments] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [uploadedAttachmentCount, setUploadedAttachmentCount] = useState(0);
  const [mediaProgress, setMediaProgress] = useState<string | null>(null);
  const [registerOnChain, setRegisterOnChain] = useState(false);

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
        .then(async (p) => {
          if (!p.username) {
            router.replace('/become-creator');
            return;
          }
          if (!requestedWorkId || pendingRef.current?.workId === requestedWorkId) return;
          const keypair = await unlockForAppSession();
          if (!keypair) throw new Error('Unlock your wallet to resume this draft.');
          const headers = buildWalletAuthHeaders(keypair, 'creator-manage-work');
          const works = await getCreatorWorks(address, headers);
          const work = works.find((item) => item.id === requestedWorkId && item.publication_status === 'draft');
          if (!work) throw new Error('Draft not found in this creator account.');
          const [releases, assets] = await Promise.all([
            getWorkReleases(work.id, buildWalletAuthHeaders(keypair, 'creator-manage-work')),
            getWorkAssets(work.id, buildWalletAuthHeaders(keypair, 'creator-manage-work')),
          ]);
          const release = releases.find((item) => item.publication_status === 'draft') ?? null;
          const uploadedPages = new Set(assets.filter((item) =>
            item.release_id === release?.id && item.role === 'manga_page' &&
            item.asset_files?.status === 'ready').map((item) => item.sort_order));
          const expectedPages = Number(release?.release_metadata?.expected_page_count) || uploadedPages.size;
          const coverUrl = typeof work.release_metadata?.cover_url === 'string'
            ? work.release_metadata.cover_url : null;
          pendingRef.current = {
            workId: work.id, releaseId: release?.id ?? null, kind: work.kind,
            uploadedPages, expectedPages,
            videoUploaded: assets.some((item) => item.release_id === release?.id &&
              item.role === 'video_source' && item.asset_files?.status === 'ready'),
            coverUrl,
            uploadedAttachmentNames: new Set(assets.filter((item) =>
              item.release_id === release?.id && item.role === 'attachment' &&
              item.asset_files?.status === 'ready')
              .map((item) => item.asset_files!.original_filename)),
          };
          setUploadedAttachmentCount(pendingRef.current.uploadedAttachmentNames.size);
          setDraftWorkId(work.id);
          setWorkKind(work.kind);
          setWorkTitle(work.title);
          setWorkDescription(work.description);
          setPriceText(String(work.price_sakura ?? 0));
          if (coverUrl) setCoverUri(coverUrl);
          setReleaseTitle(release?.title ?? '');
          setReleaseBody(release?.body_text ?? '');
        })
        .catch((error) => showAlert('Cannot load draft', error instanceof Error ? error.message : 'Try again.'))
        .finally(() => setChecking(false));
    }, [restoring, connected, address, router, requestedWorkId, unlockForAppSession]),
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
      if (pendingRef.current) pendingRef.current.coverUrl = null;
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
      if (pendingRef.current?.expectedPages &&
        result.assets.length !== pendingRef.current.expectedPages) {
        showAlert('Select the full chapter',
          `This draft expects ${pendingRef.current.expectedPages} pages. Re-select all pages in their original order; already uploaded pages will be skipped.`);
        return;
      }
      setMangaPageUris(result.assets.map((a) => a.uri));
    }
  };

  const pickEpisodeVideo = async () => {
    if (pendingRef.current?.videoUploaded) {
      showAlert('Video already uploaded', 'This draft already has an episode video ready to publish.');
      return;
    }
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

  const pickAttachments = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*', multiple: true, copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets.length) {
      setAttachments((previous) => [...previous, ...result.assets].slice(0, 10));
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
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(priceText.trim()) ||
      Number(priceText) > 1_000_000_000) {
      showAlert('Invalid price', 'Enter 0 for free or a SAKURA price with up to six decimal places.');
      return;
    }
    if (workKind === 'manga' && !mangaPageUris.length &&
      (pendingRef.current?.uploadedPages.size ?? 0) < Math.max(1, pendingRef.current?.expectedPages ?? 0)) {
      showAlert('Pages required', 'Select the full chapter pages in reading order.');
      return;
    }
    if (workKind === 'anime' && !videoUri && !pendingRef.current?.videoUploaded) {
      showAlert('Video required', 'Select an episode video.');
      return;
    }

    // Disable the button BEFORE the network probe below. The probe is a real
    // round trip, and leaving the button live across it let a second tap start a
    // parallel handleUpload — two works, two releases, two mints.
    setUploading(true);

    // Anime publishing depends on an external media host. Probe it BEFORE any
    // rows are created: a dead host used to throw midway through, after the work
    // and release already existed, stranding an unpublished draft every attempt.
    if (workKind === 'anime' && videoUri && !pendingRef.current?.videoUploaded) {
      setMediaProgress('Checking video server…');
      const blocked = await checkMediaIngestReachable();
      setMediaProgress(null);
      if (blocked) {
        setUploading(false);
        showAlert('Cannot publish episode', blocked);
        return;
      }
    }

    try {
      // Unlock first. Creating a work is signature-gated now, and doing it in
      // this order also means a cancelled biometric prompt leaves no rows
      // behind — the old order created the work and release first, so a
      // cancel stranded an unpublished draft every time.
      const kp = await signWithBiometrics();
      if (!kp) throw new Error('Could not unlock account.');
      let pending = pendingRef.current;
      if (pending && pending.kind !== workKind) {
        throw new Error('A saved draft cannot change format. Open a new release for a different format.');
      }
      if (!pending) {
        const work = await createCreatorWork({
          kind: workKind, title: workTitle, description: workDescription,
          priceSakura: Number(priceText),
          authHeaders: buildWalletAuthHeaders(kp, 'creator-manage-work'),
        });
        pending = {
          workId: work.id, releaseId: null, kind: workKind,
          uploadedPages: new Set<number>(), expectedPages: mangaPageUris.length,
          videoUploaded: false, coverUrl: null,
          uploadedAttachmentNames: new Set<string>(),
        };
        pendingRef.current = pending;
        setDraftWorkId(work.id);
      }
      if (!pending.releaseId) {
        const release = await createWorkRelease({
          workId: pending.workId, title: releaseTitle,
          summary: workDescription, bodyText: releaseBody,
          expectedPageCount: workKind === 'manga' ? mangaPageUris.length : undefined,
          authHeaders: buildWalletAuthHeaders(kp, 'creator-manage-work'),
        });
        pending.releaseId = release.id;
        pending.expectedPages = mangaPageUris.length;
      } else {
        await updateCreatorDraft({
          workId: pending.workId, releaseId: pending.releaseId,
          title: workTitle, description: workDescription, releaseTitle,
          bodyText: releaseBody,
          expectedPageCount: workKind === 'manga'
            ? mangaPageUris.length || pending.expectedPages : undefined,
          authHeaders: buildWalletAuthHeaders(kp, 'creator-manage-work'),
        });
      }
      const workId = pending.workId;
      const releaseId = pending.releaseId;

      // Cover goes through the ownership-checked upload-work-media edge function
      // (service role), same as manga pages — a direct client storage write is
      // blocked by RLS since the app authenticates by wallet, not a Supabase
      // session. The function also records release_metadata.cover_url so the
      // catalog + detail screens can display it.
      if (coverUri && !pending.coverUrl) {
        const uploaded = await uploadWorkImage({
          keypair: kp, workId, role: 'cover', localUri: coverUri,
        });
        pending.coverUrl = uploaded.url;
      }

      if (workKind === 'manga' && mangaPageUris.length) {
        const pageResult = await uploadMangaPages({
          keypair: kp,
          workId,
          releaseId,
          localUris: mangaPageUris,
          paid: Number(priceText) > 0,
          skipPageNumbers: [...pending.uploadedPages],
          onPageUploaded: (pageNumber) => {
            pending!.uploadedPages.add(pageNumber);
            setDraftWorkId(workId);
          },
          onProgress: (done, total) => setMediaProgress(`Uploading pages ${done}/${total}…`),
        });
        if (pageResult.failed.length) {
          throw new Error(`Pages ${pageResult.failed.join(', ')} did not upload. Your draft is saved; retry with the same pages in order.`);
        }
      }

      if (workKind === 'anime' && videoUri && !pending.videoUploaded) {
        setMediaProgress('Uploading episode video…');
        await uploadAnimeEpisodeVideo({
          keypair: kp,
          workId,
          releaseId,
          localUri: videoUri,
          fileName: videoName ?? undefined,
          file: videoFile ?? undefined,
        });
        pending.videoUploaded = true;
      }
      for (const [index, asset] of attachments.entries()) {
        if (pending.uploadedAttachmentNames.has(asset.name)) continue;
        setMediaProgress(`Uploading attachment ${index + 1}/${attachments.length}…`);
        await uploadCreatorAttachment({
          keypair: kp, workId, releaseId, asset,
          sortOrder: pending.uploadedAttachmentNames.size + 1,
        });
        pending.uploadedAttachmentNames.add(asset.name);
        setUploadedAttachmentCount(pending.uploadedAttachmentNames.size);
      }
      setMediaProgress(null);

      const result = await publishWorkViaApi(kp, workId);

      const notified = result.followers_notified
        ? ` ${result.followers_notified} subscribers notified.`
        : '';
      const warnings: string[] = [];
      if (registerOnChain) {
        try {
          const txSignature = await registerWorkMintOnChain(kp, workId, workTitle.trim());
          await verifyWorkMint(kp, {
            workId, title: workTitle.trim(), kind: workKind,
            coverUrl: pending.coverUrl, txSignature,
          });
        } catch (error) {
          warnings.push(`The optional on-chain registration is incomplete: ${error instanceof Error ? error.message : 'try again later'}.`);
        }
      }
      const base = `Your work is live on Sakura.${notified}`;
      const body = warnings.length ? `${base}\n\n⚠️ ${warnings.join('\n')}` : base;

      // RN Alert is a no-op on web, so this button's onPress never fired there —
      // a successful publish left the creator sitting on the form with no
      // confirmation and no navigation. Navigate unconditionally instead.
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showAlert('Published', body);
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
    /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(priceText.trim()) &&
    Number(priceText) <= 1_000_000_000 &&
    (workKind !== 'novel' || releaseBody.trim().length > 0) &&
    (workKind !== 'manga' || mangaPageUris.length > 0 ||
      (pendingRef.current?.uploadedPages.size ?? 0) >= Math.max(1, pendingRef.current?.expectedPages ?? 0)) &&
    (workKind !== 'anime' || !!videoUri || !!pendingRef.current?.videoUploaded);

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
              <KindSelector value={workKind} onChange={(kind) => {
                if (draftWorkId && kind !== workKind) {
                  showAlert('Format locked', 'A saved draft cannot change format. Start a new release for another format.');
                } else setWorkKind(kind);
              }} colors={colors} />
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
              <FormField
                label="Price in SAKURA"
                hint={draftWorkId
                  ? 'Price is fixed for this draft. Discard it to choose a different price.'
                  : '0 makes the work free. A paid work unlocks once per reader; tokens go straight to your wallet.'}
                colors={colors}
                value={priceText}
                onChangeText={setPriceText}
                editable={!draftWorkId}
                keyboardType="decimal-pad"
                placeholder="0"
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
                      : pendingRef.current?.uploadedPages.size
                        ? `${pendingRef.current.uploadedPages.size} pages uploaded in saved draft`
                      : 'Add chapter pages'}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 18 }}>
                    {mangaPageUris.length
                      ? 'Tap to re-select. Pages upload in the order you picked them.'
                      : pendingRef.current?.uploadedPages.size
                        ? 'If pages are missing, re-select the full chapter in its original reading order.'
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
                    {videoUri ? videoName ?? 'Episode video selected'
                      : pendingRef.current?.videoUploaded ? 'Episode video uploaded' : 'Add episode video'}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 18 }}>
                    {videoUri
                      ? 'Tap to replace. A poster frame is generated automatically.'
                      : pendingRef.current?.videoUploaded
                        ? 'Your saved draft has a video ready to publish.'
                      : 'MP4, MOV, or WebM. Hosted on the Sakura media server — a thumbnail is generated for you.'}
                  </Text>
                </TouchableOpacity>
              )}
            </FormSection>

            <FormSection
              title="Extra files"
              subtitle="Add audio, scripts, PDFs, source files, or other downloads. Up to 10 files, 50 MB each."
              colors={colors}
            >
              <TouchableOpacity
                onPress={onTap(pickAttachments)}
                activeOpacity={0.85}
                accessibilityRole="button"
                style={{ backgroundColor: colors.surfaceSecondary, borderRadius: Radius.lg,
                  padding: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border }}
              >
                <Text style={{ color: colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold }}>
                  {attachments.length || uploadedAttachmentCount
                    ? `${attachments.length} selected · ${uploadedAttachmentCount} uploaded`
                    : 'Choose files'}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs, marginTop: 4 }}>
                  Files are shared as downloads alongside this chapter or episode.
                </Text>
              </TouchableOpacity>
              {attachments.map((file, index) => (
                <Text key={`${file.name}-${index}`} style={{ color: colors.textSecondary,
                  fontSize: FontSize.xs, marginTop: 6 }} numberOfLines={1}>
                  {file.name}{file.size ? ` · ${(file.size / 1024 / 1024).toFixed(1)} MB` : ''}
                </Text>
              ))}
            </FormSection>

            <FormSection
              title="On-chain record (optional)"
              subtitle="After publishing, you can sign a Solana Memo that links this work to your wallet. This does not mint an NFT."
              colors={colors}
            >
              <TouchableOpacity
                onPress={() => setRegisterOnChain((v) => !v)}
                activeOpacity={0.85}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: colors.surfaceSecondary,
                  borderRadius: Radius.lg,
                  padding: 14,
                  borderWidth: 1,
                  borderColor: registerOnChain ? colors.primary : colors.border,
                }}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text }}>
                    Sign an on-chain record
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 4, lineHeight: 18 }}>
                    Requires a network fee. Publishing succeeds even if registration fails.
                  </Text>
                </View>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    borderWidth: 2,
                    borderColor: registerOnChain ? colors.primary : colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: registerOnChain ? colors.primary : 'transparent',
                  }}
                >
                  {registerOnChain ? <Text style={{ color: '#fff', fontSize: 12 }}>✓</Text> : null}
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
              ? 'Ready to publish publicly on Sakura'
              : 'Add a title, release title, and chapter content to continue'}
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
            <Text style={styles.primaryBtnText}>Publish to Sakura</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
