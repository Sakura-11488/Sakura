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
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Image } from 'expo-image';
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
  updateCreatorReleaseDraft,
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

type MangaChapterDraft = {
  key: string;
  title: string;
  pages: string[];
  releaseId: string | null;
  uploadedPages: number[];
  expectedPages: number;
};

export default function CreatorUploadScreen() {
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const spaciousLayout = Platform.OS === 'web' && windowWidth >= 900;
  const compactLayout = windowWidth < 360;
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
  const [existingPublishedWork, setExistingPublishedWork] = useState(false);
  const [mangaChapters, setMangaChapters] = useState<MangaChapterDraft[]>([]);

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
          const work = works.find((item) => item.id === requestedWorkId &&
            ['draft', 'published'].includes(item.publication_status));
          if (!work) throw new Error('Series not found in this creator account.');
          if (work.publication_status === 'published' && work.kind !== 'manga') {
            throw new Error('Adding releases to this format is not available from this page yet.');
          }
          const [releases, assets] = await Promise.all([
            getWorkReleases(work.id, buildWalletAuthHeaders(keypair, 'creator-manage-work')),
            getWorkAssets(work.id, buildWalletAuthHeaders(keypair, 'creator-manage-work')),
          ]);
          const draftReleases = releases.filter((item) => item.publication_status === 'draft');
          const release = draftReleases[0] ?? null;
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
          setExistingPublishedWork(work.publication_status === 'published');
          setWorkKind(work.kind);
          setWorkTitle(work.title);
          setWorkDescription(work.description);
          setPriceText(String(work.price_sakura ?? 0));
          if (coverUrl) setCoverUri(coverUrl);
          setReleaseTitle(release?.title ?? '');
          setReleaseBody(release?.body_text ?? '');
          setMangaChapters(draftReleases.slice(1).map((item) => {
            const uploaded = assets.filter((asset) =>
              asset.release_id === item.id && asset.role === 'manga_page' &&
              asset.asset_files?.status === 'ready').map((asset) => asset.sort_order);
            return {
              key: item.id, title: item.title, pages: [], releaseId: item.id,
              uploadedPages: uploaded,
              expectedPages: Number(item.release_metadata?.expected_page_count) || uploaded.length,
            };
          }));
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

  const pickAdditionalMangaPages = async (key: string) => {
    const chapter = mangaChapters.find((item) => item.key === key);
    if (!chapter) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      showAlert('Photos', 'Allow photo access to add chapter pages.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsMultipleSelection: true,
      orderedSelection: true, selectionLimit: 60, quality: 0.8,
    });
    if (result.canceled || !result.assets.length) return;
    if (chapter.expectedPages && chapter.releaseId &&
      result.assets.length !== chapter.expectedPages) {
      showAlert('Select the full chapter',
        `This saved chapter expects ${chapter.expectedPages} pages. Re-select them all in their original order.`);
      return;
    }
    setMangaChapters((items) => items.map((item) => item.key === key
      ? { ...item, pages: result.assets.map((asset) => asset.uri) } : item));
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
    if (workKind === 'manga') {
      const incomplete = mangaChapters.find((chapter) => !chapter.title.trim() ||
        (!chapter.pages.length && chapter.uploadedPages.length < Math.max(1, chapter.expectedPages)));
      if (incomplete) {
        showAlert('Chapter incomplete', 'Give every chapter a title and select its pages before publishing.');
        return;
      }
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
        const authHeaders = buildWalletAuthHeaders(kp, 'creator-manage-work');
        if (existingPublishedWork) {
          await updateCreatorReleaseDraft({
            workId: pending.workId, releaseId: pending.releaseId,
            releaseTitle,
            expectedPageCount: workKind === 'manga'
              ? mangaPageUris.length || pending.expectedPages : undefined,
            authHeaders,
          });
        } else {
          await updateCreatorDraft({
            workId: pending.workId, releaseId: pending.releaseId,
            title: workTitle, description: workDescription, releaseTitle,
            bodyText: releaseBody,
            expectedPageCount: workKind === 'manga'
              ? mangaPageUris.length || pending.expectedPages : undefined,
            authHeaders,
          });
        }
      }
      const workId = pending.workId;
      const releaseId = pending.releaseId;
      const savedMangaChapters = [...mangaChapters];
      if (workKind === 'manga') {
        // Save every chapter before sending page bytes. If an upload stops, the
        // dashboard can recover the whole batch from the server.
        for (const [index, chapter] of savedMangaChapters.entries()) {
          if (chapter.releaseId) continue;
          const created = await createWorkRelease({
            workId, title: chapter.title,
            expectedPageCount: chapter.pages.length,
            authHeaders: buildWalletAuthHeaders(kp, 'creator-manage-work'),
          });
          savedMangaChapters[index] = {
            ...chapter, releaseId: created.id, expectedPages: chapter.pages.length,
          };
          setMangaChapters((items) => items.map((item) => item.key === chapter.key
            ? { ...item, releaseId: created.id, expectedPages: chapter.pages.length } : item));
        }
      }

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

      if (workKind === 'manga') {
        for (const [index, chapter] of savedMangaChapters.entries()) {
          const chapterReleaseId = chapter.releaseId!;
          await updateCreatorReleaseDraft({
            workId, releaseId: chapterReleaseId, releaseTitle: chapter.title,
            expectedPageCount: chapter.pages.length || chapter.expectedPages,
            authHeaders: buildWalletAuthHeaders(kp, 'creator-manage-work'),
          });
          if (chapter.pages.length) {
            const pageResult = await uploadMangaPages({
              keypair: kp, workId, releaseId: chapterReleaseId,
              localUris: chapter.pages, paid: Number(priceText) > 0,
              skipPageNumbers: chapter.uploadedPages,
              onPageUploaded: (number) => setMangaChapters((items) => items.map((item) =>
                item.key === chapter.key
                  ? { ...item, uploadedPages: [...item.uploadedPages, number] } : item)),
              onProgress: (done, total) => setMediaProgress(
                `Chapter ${index + 2}/${savedMangaChapters.length + 1}: page ${done}/${total}…`),
            });
            if (pageResult.failed.length) {
              throw new Error(`Chapter ${index + 2}: pages ${pageResult.failed.join(', ')} failed. Your draft is saved; retry with the same pages in order.`);
            }
          }
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
      if (registerOnChain && !existingPublishedWork) {
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
        intro: {
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.md,
          padding: spaciousLayout ? Spacing.lg : Spacing.md,
          borderRadius: Radius.xl,
          borderWidth: 1,
          borderColor: '#F7D8E4',
          backgroundColor: '#FFF1F6',
          flexDirection: compactLayout ? 'column-reverse' : 'row',
          alignItems: compactLayout ? 'stretch' : 'center',
          overflow: 'hidden',
        },
        introCopy: {
          flex: compactLayout ? 0 : 1,
          maxWidth: spaciousLayout ? 610 : undefined,
          paddingRight: compactLayout ? 0 : Spacing.sm,
        },
        introEyebrow: {
          color: '#B94E74',
          fontSize: FontSize.xs,
          fontWeight: FontWeight.bold,
          letterSpacing: 1.1,
          marginBottom: 6,
        },
        introTitle: {
          color: '#5A273C',
          fontSize: spaciousLayout ? FontSize.display : FontSize.xxl,
          fontWeight: FontWeight.heavy,
          lineHeight: spaciousLayout ? 30 : 25,
        },
        introDescription: {
          color: '#70475A',
          fontSize: FontSize.sm,
          lineHeight: 18,
          marginTop: Spacing.sm,
        },
        introImage: {
          width: spaciousLayout ? 185 : 108,
          height: spaciousLayout ? 185 : 108,
          flexShrink: 0,
          marginLeft: spaciousLayout ? 'auto' : 0,
          alignSelf: compactLayout ? 'center' : undefined,
          marginBottom: compactLayout ? Spacing.sm : 0,
        },
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
    [colors, spaciousLayout, compactLayout],
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
    (workKind !== 'manga' || mangaChapters.every((chapter) => chapter.title.trim() &&
      (chapter.pages.length > 0 ||
        chapter.uploadedPages.length >= Math.max(1, chapter.expectedPages)))) &&
    (workKind !== 'anime' || !!videoUri || !!pendingRef.current?.videoUploaded);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <CreatorScreenHeader
        title={existingPublishedWork ? 'Add chapters' : 'New release'}
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
            <View style={styles.intro}>
              <View style={styles.introCopy}>
                <Text style={styles.introEyebrow}>SAKURA STUDIO</Text>
                <Text style={styles.introTitle}>
                  {existingPublishedWork ? 'Your next chapter starts here' : 'Let your story bloom'}
                </Text>
                <Text style={styles.introDescription}>
                  {existingPublishedWork
                    ? 'Add the next chapter to your series and bring your readers back for more.'
                    : 'Share your novels, manga, and anime with readers. Arrange chapters, add your art, and publish your way.'}
                </Text>
              </View>
              <Image
                source={require('@/assets/images/creator-sakura.png')}
                style={styles.introImage}
                contentFit="contain"
                accessibilityLabel="Smiling Sakura blossom drawing in a sketchbook"
              />
            </View>
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
              {!existingPublishedWork && <CoverPicker uri={coverUri} onPress={pickCover} colors={colors} />}
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
                editable={!existingPublishedWork}
                placeholder="e.g. Sakura Chronicles"
              />
              <FormField
                label="Synopsis"
                hint="A short hook — shown on your series page"
                colors={colors}
                value={workDescription}
                onChangeText={setWorkDescription}
                editable={!existingPublishedWork}
                multiline
                placeholder="What is your story about?"
                inputStyle={{ minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }}
              />
              <FormField
                label="Price in SAKURA"
                hint={existingPublishedWork
                  ? 'The existing series price also applies to new chapters.'
                  : draftWorkId
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
              title={workKind === 'anime' ? 'First episode'
                : existingPublishedWork ? 'Next chapter' : 'First chapter'}
              subtitle={workKind === 'manga'
                ? 'Add all the chapters you want to publish together.'
                : 'This release goes live immediately after publishing.'}
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

            {workKind === 'manga' && (
              <FormSection title="More chapters" subtitle="Upload several chapters to this series in one submission." colors={colors}>
                {mangaChapters.map((chapter, index) => (
                  <View key={chapter.key} style={{ marginBottom: Spacing.md }}>
                    <FormField
                      label={`Additional chapter ${index + 1} title`}
                      colors={colors}
                      value={chapter.title}
                      onChangeText={(title) => setMangaChapters((items) => items.map((item) =>
                        item.key === chapter.key ? { ...item, title } : item))}
                      placeholder={`Chapter title`}
                    />
                    <TouchableOpacity
                      onPress={onTap(() => pickAdditionalMangaPages(chapter.key))}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      style={{ backgroundColor: colors.surfaceSecondary, borderRadius: Radius.lg,
                        padding: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border }}
                    >
                      <Text style={{ color: colors.text, fontWeight: FontWeight.bold }}>
                        {chapter.pages.length
                          ? `${chapter.pages.length} pages selected`
                          : chapter.uploadedPages.length
                            ? `${chapter.uploadedPages.length} pages uploaded in saved draft`
                            : 'Select chapter pages'}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs, marginTop: 4 }}>
                        Select up to 60 pages in reading order.
                      </Text>
                    </TouchableOpacity>
                    {!chapter.releaseId && (
                      <TouchableOpacity
                        onPress={() => setMangaChapters((items) => items.filter((item) => item.key !== chapter.key))}
                        accessibilityRole="button"
                        style={{ paddingVertical: Spacing.sm }}
                      >
                        <Text style={{ color: colors.textSecondary }}>Remove chapter</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
                {mangaChapters.length < 9 && (
                  <TouchableOpacity
                    onPress={() => setMangaChapters((items) => [...items, {
                      key: `new-${Date.now()}-${items.length}`, title: '', pages: [],
                      releaseId: null, uploadedPages: [], expectedPages: 0,
                    }])}
                    accessibilityRole="button"
                    style={{ padding: 14, borderRadius: Radius.lg,
                      borderWidth: 1, borderColor: colors.primary }}
                  >
                    <Text style={{ color: colors.primary, fontWeight: FontWeight.bold }}>+ Add another chapter</Text>
                  </TouchableOpacity>
                )}
              </FormSection>
            )}

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

            {!existingPublishedWork && <FormSection
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
            </FormSection>}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
        <Text style={styles.footerHint}>
          {mediaProgress
            ? mediaProgress
            : canPublish
              ? workKind === 'manga'
                ? `Ready to publish ${mangaChapters.length + 1} chapter${mangaChapters.length ? 's' : ''}`
                : 'Ready to publish publicly on Sakura'
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
