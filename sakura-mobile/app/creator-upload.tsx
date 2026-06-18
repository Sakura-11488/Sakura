import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
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
  uploadWorkCover,
  type CreatorWorkKind,
} from '@/lib/creator';
import {
  publishWorkViaApi,
  registerWorkMintOnChain,
  verifyWorkMint,
} from '@/lib/work-mint';

export default function CreatorUploadScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connected, address, signWithBiometrics } = useWallet();

  const [checking, setChecking] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [workKind, setWorkKind] = useState<CreatorWorkKind>('novel');
  const [workTitle, setWorkTitle] = useState('');
  const [workDescription, setWorkDescription] = useState('');
  const [releaseTitle, setReleaseTitle] = useState('');
  const [releaseBody, setReleaseBody] = useState('');
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [mintAsNft, setMintAsNft] = useState(true);

  useFocusEffect(
    useCallback(() => {
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
    }, [connected, address, router]),
  );

  const step = useMemo((): 1 | 2 | 3 => {
    if (!workTitle.trim()) return 1;
    if (!releaseTitle.trim()) return 2;
    return 3;
  }, [workTitle, releaseTitle]);

  const pickCover = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos', 'Allow photo access to upload a cover.');
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

  const handleUpload = async () => {
    if (!address) return;
    if (!workTitle.trim()) {
      Alert.alert('Title required', 'Give your work a title.');
      return;
    }
    if (!releaseTitle.trim()) {
      Alert.alert('Release required', 'Add a chapter or episode title.');
      return;
    }
    if (workKind === 'novel' && !releaseBody.trim()) {
      Alert.alert('Content required', 'Paste or write your chapter text.');
      return;
    }

    setUploading(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      const work = await createCreatorWork({
        walletAddress: address,
        kind: workKind,
        title: workTitle,
        description: workDescription,
      });

      await createWorkRelease({
        workId: work.id,
        kind: workKind,
        title: releaseTitle,
        summary: workDescription,
        bodyText: releaseBody,
      });

      let coverUrl: string | null = null;
      if (coverUri) {
        coverUrl = await uploadWorkCover({
          walletAddress: address,
          workId: work.id,
          localUri: coverUri,
        });
      }

      const kp = await signWithBiometrics();
      if (!kp) throw new Error('Could not unlock account.');

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

      Alert.alert(
        mintAsNft ? 'Published & minted' : 'Published',
        mintAsNft
          ? `Your work is live. NFT receipt registered to your account.${result.followers_notified ? ` ${result.followers_notified} subscribers notified.` : ''}`
          : `Your work is live on Sakura.${result.followers_notified ? ` ${result.followers_notified} subscribers notified.` : ''}`,
        [{ text: 'View dashboard', onPress: () => router.replace('/creator-dashboard') }],
      );
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
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
              {workKind !== 'novel' && (
                <Text style={{ fontSize: FontSize.sm, color: colors.textSecondary, lineHeight: 20 }}>
                  Page and video uploads for manga & anime are coming to mobile soon. For now, publish metadata and cover — then add pages from Sakura Studio on web.
                </Text>
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
          {canPublish
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
