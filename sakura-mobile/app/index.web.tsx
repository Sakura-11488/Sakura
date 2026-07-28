import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { AppSettings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';

/** Longest the launch screen may wait on the legal-accepted read before it
 *  stops trusting it. Generous — a cold storage read is not instant — but
 *  finite, which is the whole point. */
const BOOT_TIMEOUT_MS = 3000;

function isAppRootPath(): boolean {
  if (typeof window === 'undefined') return true;
  const path = window.location.pathname.replace(/\/$/, '');
  return path === '' || path === '/app';
}

export default function WebIndex() {
  const router = useRouter();
  const { colors } = useTheme();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;

    if (!isAppRootPath()) {
      setChecking(false);
      return () => {
        mounted = false;
      };
    }

    // Raced against a timeout, because this screen's only other state is an
    // indefinite spinner. Observed live: arriving here with a stale query string
    // (`/app/?id=<chapterId>`, which is where router.back() lands a reader that
    // has nothing to pop) left the promise unsettled, so neither the redirect
    // nor `setChecking(false)` ever ran and the app sat on a spinner forever —
    // reported as a blank white screen. A stuck read must not be able to
    // swallow the entire app.
    const decided = Promise.race([
      AppSettings.getLegalAccepted(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BOOT_TIMEOUT_MS)),
    ]);

    decided
      .then((accepted) => {
        if (!mounted) return;
        // A timeout resolves null and is treated exactly like a failed read:
        // the legal gate is the one thing that must not be skipped on a guess.
        router.replace(accepted ? '/(tabs)/home' : '/welcome');
      })
      .catch(() => {
        if (mounted) router.replace('/welcome');
      })
      .finally(() => {
        if (mounted) setChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  if (!checking) return null;

  return (
    <View style={[styles.wrap, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
