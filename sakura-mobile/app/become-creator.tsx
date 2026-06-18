import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import SakuraLottie from '@/components/ui/SakuraLottie';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import WalletModal from '@/components/wallet/WalletModal';
import { onTap, playTap } from '@/lib/sound';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import { getCreatorProfile, registerCreator, validateUsername } from '@/lib/creator';
import { BecomeCreatorSkeleton } from '@/components/creator/CreatorSkeletons';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = 210;

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
      Alert.alert('Creator', 'Could not load your creator profile.');
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
      Alert.alert('Username', usernameErr);
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
      Alert.alert('Could not create profile', e instanceof Error ? e.message : 'Try again.');
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
          height: HERO_H,
          borderRadius: Radius.xl,
          overflow: 'hidden',
          marginBottom: Spacing.lg,
          backgroundColor: '#181818',
          ...Shadow.md,
        },
        heroImage: { ...StyleSheet.absoluteFill },
        heroGradBottom: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '85%',
        },
        heroGradTint: { ...StyleSheet.absoluteFill },
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
          backgroundColor: 'rgba(0,0,0,0.4)',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: 'rgba(255,255,255,0.25)',
        },
        heroFooter: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          flexDirection: 'row',
          alignItems: 'flex-end',
          paddingHorizontal: Spacing.lg,
          paddingBottom: Spacing.lg,
          paddingTop: Spacing.xl,
          zIndex: 1,
        },
        heroTextCol: { flex: 1, paddingRight: Spacing.sm },
        heroTag: {
          alignSelf: 'flex-start',
          backgroundColor: 'rgba(255,255,255,0.18)',
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: Radius.full,
          marginBottom: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: 'rgba(255,255,255,0.28)',
        },
        heroTagText: { color: '#fff', fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1 },
        heroTitle: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 24,
          color: '#fff',
        },
        heroSub: { color: 'rgba(255,255,255,0.9)', fontSize: FontSize.sm, marginTop: 6, lineHeight: 18 },
        heroLottie: { width: 72, height: 72, flexShrink: 0 },
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
    [colors],
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
            <Image
              source={require('@/assets/images/banner.png')}
              style={styles.heroImage}
              contentFit="cover"
              transition={300}
            />
            <LinearGradient
              colors={['transparent', 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0.92)']}
              locations={[0.15, 0.45, 0.78, 1]}
              style={styles.heroGradBottom}
            />
            <LinearGradient
              colors={['rgba(232,69,69,0.22)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0.6 }}
              style={styles.heroGradTint}
            />

            <TouchableOpacity
              onPress={onTap(() => router.back())}
              style={styles.heroBackBtn}
              activeOpacity={0.85}
            >
              <BackIcon color="#fff" />
            </TouchableOpacity>

            <View style={styles.heroFooter}>
              <View style={styles.heroTextCol}>
                <View style={styles.heroTag}>
                  <Text style={styles.heroTagText}>SAKURA CREATORS</Text>
                </View>
                <Text style={styles.heroTitle}>Become a creator</Text>
                <Text style={styles.heroSub} numberOfLines={2}>
                  Claim your @username and start publishing on Sakura.
                </Text>
              </View>
              <SakuraLottie
                source={require('@/assets/lottie/write.json')}
                style={styles.heroLottie}
                autoPlay
                loop
                speed={0.85}
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
