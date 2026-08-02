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
import LottieView from 'lottie-react-native';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import { onTap } from '@/lib/sound';
import { CreatorProfileSkeleton } from '@/components/creator/CreatorSkeletons';
import { CreatorScreenHeader, FormField, FormSection } from '@/components/creator/CreatorForm';
import { FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { getCreatorProfile, updateCreatorProfile } from '@/lib/creator';

export default function CreatorProfileScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connected, address, shortAddress, restoring } = useWallet();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');

  const refresh = useCallback(async () => {
    if (!address) {
      router.replace('/become-creator');
      return;
    }
    setLoading(true);
    try {
      const profile = await getCreatorProfile(address);
      if (!profile.username) {
        router.replace('/become-creator');
        return;
      }
      setUsername(profile.username.username);
      setDisplayName(profile.username.display_name || profile.profile?.display_name || '');
      setBio(profile.profile?.bio || '');
    } catch {
      showAlert('Profile', 'Could not load your creator profile.');
    } finally {
      setLoading(false);
    }
  }, [address, router]);

  useFocusEffect(
    useCallback(() => {
      // See creator-upload.tsx: don't judge the session until it has loaded.
      if (restoring) return;
      if (!connected) {
        router.replace('/become-creator');
        return;
      }
      refresh();
    }, [restoring, connected, refresh, router]),
  );

  const handleSave = async () => {
    if (!address) return;
    setSaving(true);
    try {
      await updateCreatorProfile({ walletAddress: address, displayName, bio });
      showAlert('Saved', 'Your creator profile was updated.');
      router.back();
    } catch (e) {
      showAlert('Update failed', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        profileHead: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: Spacing.lg },
        lottieBadge: {
          width: 52,
          height: 52,
          borderRadius: 26,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1.5,
          backgroundColor: `${colors.primary}14`,
          borderColor: `${colors.primary}35`,
        },
        lottie: { width: 36, height: 36 },
        handle: { fontSize: FontSize.lg, fontWeight: FontWeight.bold, color: colors.text },
        handleSub: { fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 3 },
        walletPill: {
          alignSelf: 'flex-start',
          backgroundColor: `${colors.primary}12`,
          borderRadius: Radius.full,
          paddingHorizontal: 12,
          paddingVertical: 8,
          marginBottom: Spacing.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: `${colors.primary}25`,
        },
        walletText: { color: colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
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
        },
        primaryBtn: {
          backgroundColor: colors.primary,
          borderRadius: Radius.full,
          paddingVertical: 15,
          alignItems: 'center',
          ...Shadow.sm,
        },
        primaryBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  if (loading) return <CreatorProfileSkeleton />;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <CreatorScreenHeader
        title="Edit profile"
        subtitle="Update how readers see you"
        colors={colors}
        onBack={onTap(() => router.back())}
      />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 120 + insets.bottom, paddingTop: Spacing.sm }}
        >
          <Animated.View entering={FadeInUp.duration(350)}>
            <FormSection title="Creator identity" subtitle="Your @handle cannot be changed after signup." colors={colors}>
              <View style={styles.profileHead}>
                <View style={styles.lottieBadge}>
                  <LottieView
                    source={require('@/assets/lottie/write.json')}
                    style={styles.lottie}
                    autoPlay
                    loop
                    speed={0.8}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.handle}>@{username}</Text>
                  <Text style={styles.handleSub}>Permanent creator handle</Text>
                </View>
              </View>
              <View style={styles.walletPill}>
                <Text style={styles.walletText}>{shortAddress}</Text>
              </View>
            </FormSection>

            <FormSection title="Public profile" subtitle="Shown on your creator page and works." colors={colors}>
              <FormField
                label="Display name"
                colors={colors}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="How fans will see you"
              />
              <FormField
                label="Bio"
                hint="A few sentences about you and your work"
                colors={colors}
                value={bio}
                onChangeText={setBio}
                multiline
                placeholder="Tell readers about your stories…"
                inputStyle={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }}
              />
            </FormSection>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Save changes</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
