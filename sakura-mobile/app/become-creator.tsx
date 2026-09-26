import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import SakuraLottie from '@/components/ui/SakuraLottie';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { showAlert } from '@/lib/confirm-alert';
import WalletModal from '@/components/wallet/WalletModal';
import { onTap, playTap } from '@/lib/sound';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { getCreatorProfile, registerCreator, validateUsername } from '@/lib/creator';
import { BecomeCreatorSkeleton } from '@/components/creator/CreatorSkeletons';
import { contentWidth } from '@/constants/layout';

const HERO_H = 252;

/**
 * Read reactively. This was a module constant off Dimensions.get('window'),
 * captured once at bundle evaluation and never re-read — no listener exists
 * anywhere in the app. contentWidth() rather than the window width, because on
 * desktop web the sidebar is a sibling of the content column and anything sized
 * off the window overflows by exactly SIDEBAR_WIDTH.
 */
function useScreenW() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => (Platform.OS === 'web' ? contentWidth(windowW) : windowW), [windowW]);
}

function CardHeader({ title, subtitle, colors }: { title: string; subtitle?: string; colors: { text: string; textSecondary: string; primary: string } }) {
  return (
    <View style={cardHeaderStyles.wrap}>
      <View style={[cardHeaderStyles.lottieBadge, { backgroundColor: `${colors.primary}14`, borderColor: `${colors.primary}35` }]}>
        <SakuraLottie
          source={require('@/assets/lottie/write.json')}
          style={cardHeaderStyles.lottie}
          autoPlay
          loop
          speed={0.8}
        />
      </View>
      <View style={cardHeaderStyles.textCol}>
        <Text style={[cardHeaderStyles.title, { color: colors.text }]}>{title}</Text>
        {subtitle ? <Text style={[cardHeaderStyles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

const cardHeaderStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: Spacing.lg },
  lottieBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    flexShrink: 0,
  },
  lottie: { width: 36, height: 36 },
  textCol: { flex: 1 },
  title: {
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
    fontSize: FontSize.lg,
  },
  subtitle: { fontSize: FontSize.sm, marginTop: 3, lineHeight: 18 },
});

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function BecomeCreatorScreen() {
  const SCREEN_W = useScreenW();
  const { colors } = useTheme();
  const router = useRouter();
  const { connected, address, shortAddress } = useWallet();

  const [walletVisible, setWalletVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');

  const refresh = useCallback(async () => {
    if (!address) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const profile = await getCreatorProfile(address);
      if (profile.username) {
        router.replace('/creator-dashboard');
        return;
      }
      setDisplayName(profile.profile?.display_name || '');
      setBio(profile.profile?.bio || '');
    } catch {
      showAlert('Creator', 'Could not load your creator profile.');
    } finally {
      setLoading(false);
    }
  }, [address, router]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const handleRegister = async () => {
    if (!address) return;
    const usernameErr = validateUsername(username);
    if (usernameErr) {
      showAlert('Username', usernameErr);
      return;
    }
    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await registerCreator({
        walletAddress: address,
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        bio,
      });
      playTap();
      router.replace('/creator-dashboard');
    } catch (e) {
      showAlert('Could not create profile', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        hero: {
          marginHorizontal: Spacing.md,
          width: SCREEN_W - Spacing.md * 2,
          height: SCREEN_W >= 700 ? 270 : SCREEN_W < 360 ? 352 : HERO_H,
          borderRadius: Radius.xl,
          overflow: 'hidden',
          marginBottom: Spacing.lg,
          backgroundColor: '#FFF1F6',
          borderWidth: 1,
          borderColor: '#F7D8E4',
          ...Shadow.md,
        },
        heroImage: {
          width: SCREEN_W >= 700 ? 185 : SCREEN_W < 360 ? 96 : 112,
          height: SCREEN_W >= 700 ? 185 : SCREEN_W < 360 ? 96 : 112,
          flexShrink: 0,
          marginLeft: SCREEN_W >= 700 ? 'auto' : 0,
          alignSelf: SCREEN_W < 360 ? 'center' : undefined,
          marginBottom: SCREEN_W < 360 ? Spacing.sm : 0,
        },
        heroBackBtn: {
          position: 'absolute',
          top: Spacing.sm,
          left: Spacing.sm,
          zIndex: 2,
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.8)',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: '#F4C7D6',
        },
        heroFooter: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          flexDirection: SCREEN_W < 360 ? 'column-reverse' : 'row',
          alignItems: SCREEN_W < 360 ? 'flex-start' : SCREEN_W >= 700 ? 'center' : 'flex-end',
          paddingHorizontal: SCREEN_W < 360 ? Spacing.md : Spacing.lg,
          paddingBottom: Spacing.lg,
          paddingTop: SCREEN_W < 360 ? 52 : Spacing.xl,
          zIndex: 1,
        },
        heroTextCol: {
          flex: SCREEN_W < 360 ? 0 : 1,
          maxWidth: SCREEN_W >= 700 ? 570 : undefined,
          paddingRight: SCREEN_W < 360 ? 0 : Spacing.sm,
        },
        heroTag: {
          alignSelf: 'flex-start',
          backgroundColor: '#FFE2EC',
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: Radius.full,
          marginBottom: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: '#F4C7D6',
        },
        heroTagText: { color: '#B94E74', fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1 },
        heroTitle: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 24,
          color: '#5A273C',
        },
        heroSub: { color: '#70475A', fontSize: FontSize.sm, marginTop: 6, lineHeight: 18 },
        card: {
          marginHorizontal: Spacing.md,
          marginBottom: Spacing.md,
          backgroundColor: colors.surface,
          borderRadius: Radius.xl,
          padding: Spacing.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
          ...Shadow.sm,
        },
        sectionTitle: {
          fontSize: FontSize.xs,
          fontWeight: FontWeight.bold,
          color: colors.primary,
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          marginBottom: Spacing.sm,
        },
        label: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: colors.text, marginBottom: 6 },
        input: {
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          paddingHorizontal: Spacing.md,
          paddingVertical: 12,
          color: colors.text,
          fontSize: FontSize.md,
          marginBottom: Spacing.sm,
        },
        textarea: { minHeight: 110, textAlignVertical: 'top' },
        walletPill: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: `${colors.primary}12`,
          borderRadius: Radius.full,
          paddingHorizontal: 12,
          paddingVertical: 8,
          alignSelf: 'flex-start',
          marginBottom: Spacing.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: `${colors.primary}25`,
        },
        walletText: { color: colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
        primaryBtn: {
          backgroundColor: colors.primary,
          borderRadius: Radius.full,
          paddingVertical: 14,
          alignItems: 'center',
          marginTop: Spacing.sm,
          ...Shadow.sm,
        },
        primaryBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: FontWeight.bold },
        perk: { flexDirection: 'row', gap: 12, marginBottom: 12, alignItems: 'flex-start', paddingVertical: 4 },
        perkDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary, marginTop: 7 },
        perkText: { flex: 1, color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 21 },
      }),
    [colors, SCREEN_W],
  );

  if (connected && loading) {
    return <BecomeCreatorSkeleton />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 120, paddingTop: Spacing.sm }}
        >
          <Animated.View entering={FadeInDown.duration(450)} style={styles.hero}>
            <TouchableOpacity
              onPress={onTap(() => router.back())}
              style={styles.heroBackBtn}
              activeOpacity={0.85}
            >
              <BackIcon color="#5A273C" />
            </TouchableOpacity>

            <View style={styles.heroFooter}>
              <View style={styles.heroTextCol}>
                <View style={styles.heroTag}>
                  <Text style={styles.heroTagText}>SAKURA CREATORS</Text>
                </View>
                <Text style={styles.heroTitle}>Become a creator</Text>
                <Text style={styles.heroSub}>
                  Bring your novels, manga, and anime to life. Share new chapters, grow your audience, and let readers support you with SAKURA.
                </Text>
              </View>
              <Image
                source={require('@/assets/images/creator-sakura.png')}
                style={styles.heroImage}
                contentFit="contain"
                accessibilityLabel="Smiling Sakura blossom drawing in a sketchbook"
              />
            </View>
          </Animated.View>

          {!connected ? (
            <Animated.View entering={FadeInUp.delay(80).duration(400)} style={styles.card}>
              <CardHeader
                colors={colors}
                title="Connect your account"
                subtitle="Link your Sakura account to claim a creator username."
              />
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setWalletVisible(true)} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>Connect Account</Text>
              </TouchableOpacity>
            </Animated.View>
          ) : (
            <Animated.View entering={FadeInUp.delay(80).duration(400)} style={styles.card}>
              <CardHeader
                colors={colors}
                title="Create your profile"
                subtitle="Pick a username and tell readers about your work."
              />
              <View style={styles.walletPill}>
                <Text style={styles.walletText}>{shortAddress}</Text>
              </View>
              <Text style={styles.label}>Username</Text>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="your_name"
                placeholderTextColor={colors.textTertiary}
              />
              <Text style={styles.label}>Display name</Text>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="How fans will see you"
                placeholderTextColor={colors.textTertiary}
              />
              <Text style={styles.label}>Bio</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={bio}
                onChangeText={setBio}
                multiline
                placeholder="Tell readers about your work…"
                placeholderTextColor={colors.textTertiary}
              />
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleRegister}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Become a Creator</Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          )}

          {!connected && (
            <Animated.View entering={FadeInUp.delay(120).duration(400)} style={styles.card}>
              <Text style={styles.sectionTitle}>Why create on Sakura?</Text>
              {[
                'Claim a unique @username linked to your account',
                'Publish novels, manga chapters, and anime episodes',
                'Sync your creator profile across Sakura apps',
                'Reach readers who already live in the app',
              ].map((line) => (
                <View key={line} style={styles.perk}>
                  <View style={styles.perkDot} />
                  <Text style={styles.perkText}>{line}</Text>
                </View>
              ))}
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <WalletModal visible={walletVisible} onClose={() => setWalletVisible(false)} />
    </SafeAreaView>
  );
}
