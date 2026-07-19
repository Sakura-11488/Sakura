import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Radius, FontSize, FontWeight } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import InstallGuideModal, {
  detectInstallFlavor,
  isStandaloneWebApp,
} from '@/components/InstallGuideModal';

const ACCENT = '#E84545';
const DISMISS_KEY = 'sakura_install_banner_dismissed';

/**
 * Prompts web visitors to install Sakura to their home screen, and teaches them
 * how. Chrome/Edge get the real install prompt via `beforeinstallprompt`; iOS
 * has no install API, so it gets the Share-sheet tutorial instead. Hidden once
 * installed or dismissed. Native renders the no-op variant (.native.tsx).
 */
export default function InstallAppBanner() {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const flavor = useMemo(detectInstallFlavor, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (isStandaloneWebApp()) return; // already installed
    let dismissed = false;
    try {
      dismissed = window.localStorage?.getItem(DISMISS_KEY) === '1';
    } catch {
      // storage blocked (private mode) — just show it
    }
    if (dismissed) return;

    // Chrome fires this once the app meets the install criteria.
    const onBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);

    // iOS never fires that event, so surface the tutorial on its own.
    const t = setTimeout(() => {
      if (flavor === 'ios') setVisible(true);
    }, 2500);

    const onInstalled = () => setVisible(false);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      clearTimeout(t);
    };
  }, [flavor]);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      window.localStorage?.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  const handleInstall = useCallback(async () => {
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        setDeferredPrompt(null);
        if (choice?.outcome === 'accepted') setVisible(false);
        return;
      } catch {
        // fall through to the manual tutorial
      }
    }
    setShowGuide(true);
  }, [deferredPrompt]);

  const s = useMemo(
    () =>
      StyleSheet.create({
        banner: {
          position: Platform.OS === 'web' ? ('fixed' as any) : 'absolute',
          left: 12,
          right: 12,
          bottom: 12,
          zIndex: 9998,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: colors.surface,
          borderRadius: 18,
          borderWidth: 1,
          borderColor: colors.borderLight,
          paddingVertical: 12,
          paddingHorizontal: 14,
          maxWidth: 520,
          marginHorizontal: 'auto' as any,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.25,
          shadowRadius: 20,
          elevation: 10,
        },
        mark: {
          width: 38,
          height: 38,
          borderRadius: 12,
          backgroundColor: `${ACCENT}18`,
          borderWidth: 1,
          borderColor: `${ACCENT}40`,
          alignItems: 'center',
          justifyContent: 'center',
        },
        markText: { fontSize: 20 },
        copy: { flex: 1, minWidth: 0 },
        title: { color: colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
        sub: { color: colors.textSecondary, fontSize: FontSize.xs, marginTop: 1 },
        cta: {
          backgroundColor: ACCENT,
          borderRadius: Radius.full,
          paddingHorizontal: 16,
          paddingVertical: 9,
        },
        ctaText: { color: '#fff', fontSize: FontSize.sm, fontWeight: FontWeight.bold },
        close: { paddingHorizontal: 6, paddingVertical: 4 },
        closeText: { color: colors.textTertiary, fontSize: 16, fontWeight: FontWeight.bold },
      }),
    [colors],
  );

  if (Platform.OS !== 'web') return null;

  return (
    <>
      {visible ? (
        <Animated.View entering={FadeInUp.duration(320)} style={s.banner}>
          <View style={s.mark}>
            <Text style={s.markText}>🌸</Text>
          </View>
          <View style={s.copy}>
            <Text style={s.title} numberOfLines={1}>
              Install Sakura
            </Text>
            <Text style={s.sub} numberOfLines={1}>
              {flavor === 'ios'
                ? 'Add it to your Home Screen for a full-screen app'
                : 'Get the full-screen app experience'}
            </Text>
          </View>
          <TouchableOpacity style={s.cta} activeOpacity={0.85} onPress={handleInstall}>
            <Text style={s.ctaText}>{flavor === 'ios' ? 'How' : 'Install'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.close} onPress={dismiss} accessibilityLabel="Dismiss">
            <Text style={s.closeText}>✕</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : null}

      <InstallGuideModal
        visible={showGuide}
        flavor={flavor}
        onClose={() => {
          setShowGuide(false);
          dismiss();
        }}
      />
    </>
  );
}
