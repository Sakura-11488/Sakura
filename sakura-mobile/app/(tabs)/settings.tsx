import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, Alert, Linking, ActivityIndicator, TextInput,
  Clipboard, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import Svg, { Path, Circle } from 'react-native-svg';
import Constants from 'expo-constants';
import { useTheme, AppColors } from '@/lib/theme';
import { AppSettings } from '@/lib/settings';
import { useContentPrefs } from '@/lib/content-prefs';
import { confirmDestructive } from '@/lib/confirm-alert';
import {
  getNotificationPermissionStatus,
  openNotificationSettings,
  PushRegistrationError,
  registerForPushNotifications,
  unregisterPushNotifications,
} from '@/lib/notifications';
import { syncPushRegistration, updatePushPrefsOnServer } from '@/lib/push-tokens';
import { getWalletWithBiometrics } from '@/lib/wallet/storage';
import { getExportKeyCopy } from '@/lib/wallet/platform-labels';
import { getProfile, upsertProfile } from '@/lib/supabase';
import { useWallet } from '@/lib/wallet/context';
import { clearApiCache, getApiCacheSizeBytes } from '@/lib/cache';
import { clearAnimeSessionCache } from '@/lib/anime';
import InstallGuideModal, { isStandaloneWebApp } from '@/components/InstallGuideModal';
import { clearAllWatchProgress } from '@/lib/watch-progress';
import { clearAllReadingProgress } from '@/lib/reader-progress';
import { clearAllOfflineEpisodes } from '@/lib/anime-offline';
import { clearAllOfflineManga } from '@/lib/manga-offline';
import { clearAllOfflineNovel } from '@/lib/novel-offline';
import { Fonts, FontSize, FontWeight, Radius, Shadow, Spacing } from '@/constants/theme';
import * as Sound from '@/lib/sound';
import bs58 from 'bs58';

// ─── Icons ────────────────────────────────────────────────────────────────────
const I = {
  Moon: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill={c} /></Svg>,
  Bell: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" /></Svg>,
  Tv: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path fillRule="evenodd" clipRule="evenodd" d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7zm2 0h16v10H4V7zm5 7.5l5-2.5-5-2.5v5z" fill={c} /></Svg>,
  Book: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" /><Path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke={c} strokeWidth={2} fill="none" /></Svg>,
  Wallet: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M21 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" stroke={c} strokeWidth={2} fill="none" /><Circle cx="16" cy="12" r="1.5" fill={c} /></Svg>,
  Key: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" /></Svg>,
  User: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke={c} strokeWidth={2} fill="none" /><Circle cx="12" cy="7" r="4" stroke={c} strokeWidth={2} fill="none" /></Svg>,
  Scroll: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke={c} strokeWidth={2} strokeLinecap="round" /></Svg>,
  Page: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke={c} strokeWidth={2} fill="none" /><Path d="M14 2v6h6" stroke={c} strokeWidth={2} fill="none" /></Svg>,
  Shield: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke={c} strokeWidth={2} fill="none" /></Svg>,
  Mail: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke={c} strokeWidth={2} fill="none" /><Path d="m22 6-10 7L2 6" stroke={c} strokeWidth={2} /></Svg>,
  Download: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>,
  Info: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Circle cx="12" cy="12" r="10" stroke={c} strokeWidth={2} fill="none" /><Path d="M12 16v-4M12 8h.01" stroke={c} strokeWidth={2} strokeLinecap="round" /></Svg>,
  Trash: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>,
  Star: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill={c} /></Svg>,
  Chart: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M18 20V10M12 20V4M6 20v-6" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" /></Svg>,
  Chevron: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M9 18l6-6-6-6" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" /></Svg>,
  Flame: ({ c }: { c: string }) => <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M12 2s5 4 5 9a5 5 0 0 1-10 0c0-1.5.5-2.5 1-3.5C8.5 9 9 11 10 11c1.5 0 1-3 0-5 2 1 2 3 2 3s1-2 0-7z" fill={c} /></Svg>,
  Back: ({ c }: { c: string }) => <Svg width={22} height={22} viewBox="0 0 24 24"><Path d="M19 12H5M12 5l-7 7 7 7" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function getDirectorySizeBytes(dir: string): Promise<number> {
  try {
    const files = await FileSystem.readDirectoryAsync(dir);
    const stats = await Promise.all(
      files.map(async (name) => {
        try {
          const info = await FileSystem.getInfoAsync(`${dir}${name}`);
          return ((info as any).size ?? 0) as number;
        } catch {
          return 0;
        }
      }),
    );
    return stats.reduce((sum, n) => sum + n, 0);
  } catch {
    return 0;
  }
}

async function getCacheSize(): Promise<string> {
  try {
    const dir = FileSystem.cacheDirectory ?? '';
    const [apiBytes, dirBytes] = await Promise.all([
      getApiCacheSizeBytes(),
      dir ? getDirectorySizeBytes(dir) : Promise.resolve(0),
    ]);
    return formatBytes(apiBytes + dirBytes);
  } catch { return '—'; }
}

async function clearCache(): Promise<void> {
  try {
    clearAnimeSessionCache();
    await clearAllWatchProgress();
    await clearAllReadingProgress();
    await clearAllOfflineEpisodes();
    await clearAllOfflineManga();
    await clearAllOfflineNovel();
    await clearApiCache();
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    const files = await FileSystem.readDirectoryAsync(dir);
    await Promise.all(files.map((f) => FileSystem.deleteAsync(dir + f, { idempotent: true })));
  } catch { }
}

async function copyToClipboard(text: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error('Clipboard is not available in this browser.');
  }
  Clipboard.setString(text);
}

// ─── Re-usable building blocks ────────────────────────────────────────────────
function SectionHeader({ title, colors }: { title: string; colors: AppColors }) {
  return (
    <Text style={{
      fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: colors.primary,
      letterSpacing: 0.8, textTransform: 'uppercase',
      marginHorizontal: Spacing.md, marginBottom: 6, marginTop: 24,
    }}>
      {title}
    </Text>
  );
}

function Group({ children, colors }: { children: React.ReactNode; colors: AppColors }) {
  return (
    <View style={{
      marginHorizontal: Spacing.md, backgroundColor: colors.surface,
      borderRadius: Radius.lg, overflow: 'hidden', ...Shadow.sm,
    }}>
      {children}
    </View>
  );
}

function Badge({ bg: _bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: '#5A6272', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  );
}

function Divider({ colors }: { colors: AppColors }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.borderLight, marginLeft: 56 }} />;
}

function ToggleRow({ badge, label, sub, value, onToggle, disabled, colors }: {
  badge: React.ReactNode; label: string; sub?: string;
  value: boolean; onToggle: (v: boolean) => void;
  disabled?: boolean; colors: AppColors;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: 12, gap: 12 }}>
      {badge}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.medium, color: disabled ? colors.textTertiary : colors.text }}>{label}</Text>
        {sub ? <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 1 }}>{sub}</Text> : null}
      </View>
      <Switch
        value={value} onValueChange={onToggle} disabled={disabled}
        trackColor={{ false: colors.border, true: `${colors.primary}80` }}
        thumbColor={value ? colors.primary : colors.textTertiary}
        ios_backgroundColor={colors.border}
      />
    </View>
  );
}

function TapRow({ badge, label, sub, right, onPress, destructive, colors }: {
  badge: React.ReactNode; label: string; sub?: string;
  right?: React.ReactNode; onPress?: () => void;
  destructive?: boolean; colors: AppColors;
}) {
  return (
    <TouchableOpacity
      onPress={onPress} activeOpacity={0.7} disabled={!onPress}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: 13, gap: 12 }}
    >
      {badge}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.medium, color: destructive ? '#FF3B30' : colors.text }}>{label}</Text>
        {sub ? <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 1 }}>{sub}</Text> : null}
      </View>
      {right ?? (onPress ? <I.Chevron c={colors.textTertiary} /> : null)}
    </TouchableOpacity>
  );
}

function PillPicker({ value, options, onChange, colors }: {
  value: string; options: { key: string; label: string }[];
  onChange: (v: string) => void; colors: AppColors;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {options.map((o) => (
        <TouchableOpacity
          key={o.key}
          onPress={() => onChange(o.key)}
          activeOpacity={0.7}
          style={{
            paddingHorizontal: 14, paddingVertical: 6, borderRadius: Radius.full,
            backgroundColor: value === o.key ? colors.primary : colors.surfaceSecondary,
            borderWidth: 1, borderColor: value === o.key ? colors.primary : colors.border,
          }}
        >
          <Text style={{ fontSize: FontSize.xs, fontWeight: FontWeight.bold, color: value === o.key ? '#fff' : colors.textSecondary }}>
            {o.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function SettingsScreen() {
  const { isDark, toggleTheme, colors } = useTheme();
  const { connected, address, shortAddress, disconnect } = useWallet();
  const { allowAdult, setAllowAdult } = useContentPrefs();

  // ── Notifications ──
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushEpisodes, setPushEpisodes] = useState(true);
  const [pushChapters, setPushChapters] = useState(true);
  const [pushPass, setPushPass] = useState(true);
  const [pushMarketing, setPushMarketing] = useState(true);
  const [togglingPush, setTogglingPush] = useState(false);

  // ── Reader ──
  const [readingMode, setReadingMode] = useState('scroll');
  const [dataSaver, setDataSaver] = useState(false);
  const [pnlTracker, setPnlTracker] = useState(false);

  // ── Content ──
  const [autoplay, setAutoplay] = useState(true);
  const [readDir, setReadDir] = useState('ltr');

  // ── Profile ──
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // ── Email ──
  const [email, setEmail] = useState('');
  const [emailSaved, setEmailSaved] = useState(false);

  // ── Storage ──
  const [cacheSize, setCacheSize] = useState('');
  const [clearingCache, setClearingCache] = useState(false);
  // Web-only: lets users re-open the "add to home screen" tutorial any time,
  // even after dismissing the install banner.
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const canShowInstallRow = Platform.OS === 'web' && !isStandaloneWebApp();

  // ── Wallet export ──
  const [exportLoading, setExportLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [pe, pep, pec, ppp, pmm, ap, rd, rm, ds, pnl, em, cs] = await Promise.all([
          AppSettings.getPushEnabled(),
          AppSettings.getPushEpisodes(),
          AppSettings.getPushChapters(),
          AppSettings.getPushPass(),
          AppSettings.getPushMarketing(),
          AppSettings.getAutoplay(),
          AppSettings.getReadDirection(),
          AppSettings.getMangaReadingMode(),
          AppSettings.getDataSaver(),
          AppSettings.getPnlTracker(),
          AppSettings.getEmail(),
          getCacheSize(),
        ]);
        if (Platform.OS !== 'web' && pe) {
          const status = await getNotificationPermissionStatus();
          const granted = status === 'granted';
          setPushEnabled(granted);
          if (!granted) await AppSettings.setPushEnabled(false);
        }
        setPushEpisodes(pep); setPushChapters(pec); setPushPass(ppp); setPushMarketing(pmm);
        setAutoplay(ap); setReadDir(rd); setReadingMode(rm);
        setDataSaver(ds); setPnlTracker(pnl); setEmail(em); setCacheSize(cs);
      } catch {
        // keep defaults if any storage read fails on web
      }
    })();
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return;
      let cancelled = false;
      (async () => {
        const enabledLocally = await AppSettings.getPushEnabled();
        if (!enabledLocally) return;
        const status = await getNotificationPermissionStatus();
        const granted = status === 'granted';
        if (cancelled) return;
        setPushEnabled(granted);
        if (granted && address) {
          try {
            await registerForPushNotifications();
            await syncPushRegistration(address);
          } catch {
            // user may still be in settings flow
          }
        } else if (!granted) {
          await AppSettings.setPushEnabled(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [address]),
  );

  useEffect(() => {
    if (!address) return;
    getProfile(address).then((p) => {
      if (p) { setDisplayName(p.display_name ?? ''); setBio(p.bio ?? ''); }
    }).catch(() => { });
  }, [address]);

  const handlePushToggle = useCallback(async (next: boolean) => {
    if (Platform.OS === 'web') return;
    setTogglingPush(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      if (next) {
        if (!address) {
          Alert.alert(
            'Connect account',
            'Connect your Sakura account before enabling push notifications.',
          );
          return;
        }

        await registerForPushNotifications();
        setPushEnabled(true);
        await AppSettings.setPushEnabled(true);
        await syncPushRegistration(address);
      } else {
        await unregisterPushNotifications();
        setPushEnabled(false);
        await AppSettings.setPushEnabled(false);
      }
    } catch (e) {
      setPushEnabled(false);
      await AppSettings.setPushEnabled(false);
      if (e instanceof PushRegistrationError && e.code === 'permission_denied') {
        Alert.alert(
          'Notifications blocked',
          'Sakura needs notification permission. Open Settings to allow notifications for Sakura, then try again.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => openNotificationSettings() },
          ],
        );
        return;
      }
      const msg =
        e instanceof PushRegistrationError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Could not enable push notifications.';
      Alert.alert('Push Notifications', msg);
    } finally {
      setTogglingPush(false);
    }
  }, [address]);

  const handleSaveProfile = useCallback(async () => {
    if (!address) return;
    setProfileLoading(true);
    try {
      await upsertProfile(address, displayName.trim() || null, bio.trim() || null, email || null);
      setProfileSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setProfileSaved(false), 2000);
    } catch { }
    setProfileLoading(false);
  }, [address, displayName, bio, email]);

  const handleExportKey = useCallback(async () => {
    setExportLoading(true);
    try {
      const kp = await getWalletWithBiometrics();
      if (!kp) throw new Error('Could not unlock account');
      const secret = bs58.encode(kp.secretKey);
      await copyToClipboard(secret);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Private Key Copied', 'Your private key has been copied to the clipboard.\n\nNEVER share this with anyone.');
    } catch (e: any) {
      if (!e.message?.includes('cancelled')) {
        Alert.alert('Export Failed', e.message ?? 'Authentication failed');
      }
    }
    setExportLoading(false);
  }, []);

  const handleDisconnect = useCallback(() => {
    confirmDestructive(
      'Sign Out',
      'This removes your account from this device. Make sure your private key is backed up.',
    ).then(async (ok) => {
      if (ok) await disconnect();
    });
  }, [disconnect]);

  const handleClearCache = useCallback(() => {
    confirmDestructive('Clear Cache', `Clear ${cacheSize} of cached data?`).then(async (ok) => {
      if (!ok) return;
      setClearingCache(true);
      await clearCache();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCacheSize(await getCacheSize());
      setClearingCache(false);
    });
  }, [cacheSize]);

  const version = Constants.expoConfig?.version ?? '1.9.0';
  const s = useMemo(() => makeStyles(colors), [colors]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* ── Header ── */}
          <View style={s.headerRow}>
            <TouchableOpacity onPress={Sound.onTap(() => router.navigate('/profile'))} style={s.backBtn} activeOpacity={0.7}>
              <I.Back c={colors.text} />
            </TouchableOpacity>
            <Text style={s.heading}>Settings</Text>
            <View style={{ width: 40 }} />
          </View>

          {/* ── APPEARANCE ─────────────────────────────── */}
          <SectionHeader title="Appearance" colors={colors} />
          <Group colors={colors}>
            <ToggleRow
              badge={<Badge bg="#5856D6"><I.Moon c="#fff" /></Badge>}
              label="Dark Mode"
              sub={isDark ? 'Currently dark' : 'Currently light'}
              value={isDark}
              onToggle={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); toggleTheme(); }}
              colors={colors}
            />
          </Group>

          {/* ── WALLET ─────────────────────────────────── */}
          <SectionHeader title="Sakura Account" colors={colors} />
          <Group colors={colors}>
            <TapRow
              badge={<Badge bg={connected ? colors.primary : colors.surfaceTertiary}><I.Wallet c="#fff" /></Badge>}
              label={connected ? 'Connected' : 'Not Connected'}
              sub={connected ? shortAddress ?? undefined : 'Go to Profile to connect your account'}
              colors={colors}
            />
            {connected && (
              <>
                <Divider colors={colors} />
                <TapRow
                  badge={<Badge bg="#FF9500"><I.Key c="#fff" /></Badge>}
                  label="Export Private Key"
                  sub={getExportKeyCopy()}
                  onPress={exportLoading ? undefined : handleExportKey}
                  colors={colors}
                  right={exportLoading ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined}
                />
                <Divider colors={colors} />
                <TapRow
                  badge={<Badge bg="#FF3B3015"><I.Wallet c="#FF3B30" /></Badge>}
                  label="Sign Out"
                  onPress={handleDisconnect}
                  destructive
                  colors={colors}
                />
              </>
            )}
          </Group>

          {/* ── PROFILE ────────────────────────────────── */}
          {connected && (
            <>
              <SectionHeader title="Profile" colors={colors} />
              <Group colors={colors}>
                <View style={s.inputSection}>
                  <Text style={[s.inputLabel, { color: colors.textSecondary }]}>Display Name</Text>
                  <TextInput
                    style={[s.input, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                    value={displayName}
                    onChangeText={(t) => setDisplayName(t.slice(0, 24))}
                    placeholder="Enter display name..."
                    placeholderTextColor={colors.textTertiary}
                    maxLength={24}
                    autoCorrect={false}
                  />
                  <Text style={[s.charCount, { color: colors.textTertiary }]}>{displayName.length}/24</Text>
                </View>
                <Divider colors={colors} />
                <View style={s.inputSection}>
                  <Text style={[s.inputLabel, { color: colors.textSecondary }]}>Bio  <Text style={{ fontSize: FontSize.xs, color: colors.textTertiary }}>({bio.length}/140)</Text></Text>
                  <TextInput
                    style={[s.input, s.bioInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                    value={bio}
                    onChangeText={(t) => setBio(t.slice(0, 140))}
                    placeholder="Tell the community about yourself..."
                    placeholderTextColor={colors.textTertiary}
                    maxLength={140}
                    multiline
                    textAlignVertical="top"
                  />
                </View>
                <Divider colors={colors} />
                <TouchableOpacity
                  onPress={handleSaveProfile}
                  disabled={profileLoading}
                  activeOpacity={0.85}
                  style={[s.saveBtn, { backgroundColor: colors.primary }]}
                >
                  {profileLoading
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={s.saveBtnText}>{profileSaved ? '✓ Saved' : 'Save Profile'}</Text>
                  }
                </TouchableOpacity>
              </Group>
            </>
          )}

          {/* ── READER ─────────────────────────────────── */}
          <SectionHeader title="Reader" colors={colors} />
          <Group colors={colors}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: 12, gap: 12 }}>
              <Badge bg="#AF52DE"><I.Page c="#fff" /></Badge>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.medium, color: colors.text }}>Reading Mode</Text>
                <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 1 }}>Default view for manga and novel chapters</Text>
              </View>
              <PillPicker
                value={readingMode}
                options={[{ key: 'page', label: 'Page' }, { key: 'scroll', label: 'Scroll' }]}
                onChange={async (v) => {
                  setReadingMode(v);
                  await AppSettings.setReadingMode(v);
                  await AppSettings.setMangaReadingMode(v);
                  Haptics.selectionAsync();
                }}
                colors={colors}
              />
            </View>
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#34C759"><I.Scroll c="#fff" /></Badge>}
              label="Data Saver"
              sub="Use compressed images (lower quality)"
              value={dataSaver}
              onToggle={async (v) => { setDataSaver(v); await AppSettings.setDataSaver(v); }}
              colors={colors}
            />
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#FF9500"><I.Chart c="#fff" /></Badge>}
              label="PNL Tracker"
              sub="Show live SOL PNL widget while reading"
              value={pnlTracker}
              onToggle={async (v) => { setPnlTracker(v); await AppSettings.setPnlTracker(v); }}
              colors={colors}
            />
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#FF2D55"><I.Flame c="#fff" /></Badge>}
              label="Allow 18+ Content"
              sub="Show an 18+ category on the home page"
              value={allowAdult}
              onToggle={async (v) => {
                if (!v) {
                  setAllowAdult(false);
                  return;
                }
                // Web-aware confirm: Alert.alert with buttons is a no-op on
                // react-native-web, so use confirmDestructive (window.confirm on
                // web, native Alert on device) or the toggle can never turn on.
                const ok = await confirmDestructive(
                  'Adult content',
                  'This shows adult (18+) content. Confirm you are 18 or older.',
                );
                if (ok) {
                  Haptics.selectionAsync();
                  setAllowAdult(true);
                }
              }}
              colors={colors}
            />
            <Divider colors={colors} />
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: 12, gap: 12 }}>
              <Badge bg="#007AFF"><I.Book c="#fff" /></Badge>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: FontSize.md, fontWeight: FontWeight.medium, color: colors.text }}>Reading Direction</Text>
                <Text style={{ fontSize: FontSize.xs, color: colors.textSecondary, marginTop: 1 }}>Text direction for manga and novels</Text>
              </View>
              <PillPicker
                value={readDir}
                options={[{ key: 'ltr', label: 'LTR' }, { key: 'rtl', label: 'RTL' }]}
                onChange={async (v) => { setReadDir(v); await AppSettings.setReadDirection(v); Haptics.selectionAsync(); }}
                colors={colors}
              />
            </View>
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#007AFF"><I.Tv c="#fff" /></Badge>}
              label="Autoplay Videos"
              sub="Automatically play next episode"
              value={autoplay}
              onToggle={async (v) => { setAutoplay(v); await AppSettings.setAutoplay(v); }}
              colors={colors}
            />
          </Group>

          {/* ── NOTIFICATIONS ──────────────────────────── */}
          <SectionHeader title="Notifications" colors={colors} />
          <Group colors={colors}>
            <ToggleRow
              badge={<Badge bg={colors.primary}><I.Bell c="#fff" /></Badge>}
              label="Push Notifications"
              sub={Platform.OS === 'web' ? 'Not available on web' : pushEnabled ? 'Enabled' : 'Tap to allow notifications'}
              value={pushEnabled}
              onToggle={Platform.OS === 'web' || togglingPush ? () => { } : handlePushToggle}
              disabled={Platform.OS === 'web' || togglingPush}
              colors={colors}
            />
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#FF9500"><I.Tv c="#fff" /></Badge>}
              label="New Anime Episodes"
              value={pushEpisodes}
              onToggle={async (v) => {
                setPushEpisodes(v);
                await AppSettings.setPushEpisodes(v);
                await updatePushPrefsOnServer(address, { notifyEpisodes: v }).catch(() => { });
              }}
              disabled={Platform.OS === 'web' || !pushEnabled}
              colors={colors}
            />
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#34C759"><I.Book c="#fff" /></Badge>}
              label="New Manga Chapters"
              value={pushChapters}
              onToggle={async (v) => {
                setPushChapters(v);
                await AppSettings.setPushChapters(v);
                await updatePushPrefsOnServer(address, { notifyChapters: v }).catch(() => { });
              }}
              disabled={Platform.OS === 'web' || !pushEnabled}
              colors={colors}
            />
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#5856D6"><I.Star c="#fff" /></Badge>}
              label="Pass Expiry Reminder"
              sub="Remind me before your pass expires"
              value={pushPass}
              onToggle={async (v) => {
                setPushPass(v);
                await AppSettings.setPushPass(v);
                await updatePushPrefsOnServer(address, { notifyPass: v }).catch(() => { });
              }}
              disabled={Platform.OS === 'web' || !pushEnabled}
              colors={colors}
            />
            <Divider colors={colors} />
            <ToggleRow
              badge={<Badge bg="#FF2D55"><I.Star c="#fff" /></Badge>}
              label="Tips & Highlights"
              sub="Catchy reminders when you've been away"
              value={pushMarketing}
              onToggle={async (v) => {
                setPushMarketing(v);
                await AppSettings.setPushMarketing(v);
                await updatePushPrefsOnServer(address, { notifyMarketing: v }).catch(() => { });
              }}
              disabled={Platform.OS === 'web' || !pushEnabled}
              colors={colors}
            />
          </Group>

          {/* ── EMAIL ──────────────────────────────────── */}
          <SectionHeader title="Email (Optional)" colors={colors} />
          <Group colors={colors}>
            <View style={s.inputSection}>
              <Text style={[s.inputLabel, { color: colors.textSecondary }]}>Add your email for updates and special offers</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput
                  style={[s.input, { flex: 1, color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="your@email.com"
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  onPress={async () => {
                    await AppSettings.setEmail(email);
                    if (address) upsertProfile(address, displayName || null, bio || null, email || null).catch(() => { });
                    setEmailSaved(true);
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    setTimeout(() => setEmailSaved(false), 2000);
                  }}
                  style={[s.saveBtn, { paddingHorizontal: 16 }]}
                  activeOpacity={0.85}
                >
                  <Text style={s.saveBtnText}>{emailSaved ? '✓' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Group>

          {/* ── ABOUT ──────────────────────────────────── */}
          <SectionHeader title="About" colors={colors} />
          <Group colors={colors}>
            <TapRow
              badge={<Badge bg={colors.surfaceTertiary}><I.Info c="#fff" /></Badge>}
              label="Version"
              colors={colors}
              right={<Text style={{ fontSize: FontSize.sm, color: colors.textSecondary }}>v{version}</Text>}
            />
            <Divider colors={colors} />
            <TapRow
              badge={<Badge bg={colors.primary}><I.Mail c="#fff" /></Badge>}
              label="Contact Us"
              sub="sakuramanga162@gmail.com"
              onPress={() => Linking.openURL('mailto:sakuramanga162@gmail.com')}
              colors={colors}
            />
            {canShowInstallRow ? (
              <>
                <Divider colors={colors} />
                <TapRow
                  badge={<Badge bg={colors.primary}><I.Download c="#fff" /></Badge>}
                  label="Install as App"
                  sub="Add Sakura to your home screen"
                  onPress={() => setShowInstallGuide(true)}
                  colors={colors}
                />
              </>
            ) : null}
          </Group>
          {/* ── LEGAL ──────────────────────────────────── */}
          <SectionHeader title="Legal" colors={colors} />
          <Group colors={colors}>
            <TapRow
              badge={<Badge bg={colors.primary}><I.Shield c="#fff" /></Badge>}
              label="Privacy Policy"
              sub="How Sakura handles your data"
              onPress={() => WebBrowser.openBrowserAsync('https://sakuraonseeker.com/privacy.html', { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET })}
              colors={colors}
            />
            <Divider colors={colors} />
            <TapRow
              badge={<Badge bg="#8E8E93"><I.Shield c="#fff" /></Badge>}
              label="Terms of Service"
              sub="Rules, responsibilities, and risk disclosures"
              onPress={() => WebBrowser.openBrowserAsync('https://sakuraonseeker.com/terms.html', { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET })}
              colors={colors}
            />
          </Group>

          {/* ── STORAGE ────────────────────────────────── */}
          <SectionHeader title="Storage" colors={colors} />
          <Group colors={colors}>
            <TapRow
              badge={<Badge bg="#FF3B30"><I.Trash c="#fff" /></Badge>}
              label="Clear Cache"
              sub={cacheSize ? `${cacheSize} cached` : ''}
              onPress={clearingCache ? undefined : handleClearCache}
              destructive
              colors={colors}
              right={clearingCache ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined}
            />
          </Group>

          <View style={{ height: 120 }} />
        </ScrollView>
      </KeyboardAvoidingView>
      <InstallGuideModal visible={showInstallGuide} onClose={() => setShowInstallGuide(false)} />
    </SafeAreaView>
  );
}

function makeStyles(colors: AppColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: 4 },
    backBtn: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
    heading: { fontFamily: Fonts.display, fontWeight: Fonts.displayWeight, fontSize: 28, color: colors.text, letterSpacing: 0.3 },
    inputSection: { padding: Spacing.md, gap: 8 },
    inputLabel: { fontSize: FontSize.sm, fontWeight: FontWeight.medium },
    input: { borderRadius: Radius.md, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: FontSize.md },
    bioInput: { minHeight: 72, paddingTop: 10 },
    charCount: { fontSize: FontSize.xs, textAlign: 'right' },
    saveBtn: { backgroundColor: colors.primary, borderRadius: Radius.full, paddingVertical: 12, alignItems: 'center', marginHorizontal: Spacing.md, marginBottom: Spacing.md },
    saveBtnText: { color: '#fff', fontSize: FontSize.md, fontFamily: Fonts.display, fontWeight: Fonts.displayWeight },
  });
}
