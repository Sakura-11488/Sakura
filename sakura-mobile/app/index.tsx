import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { AppSettings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';

/** Longest the launch screen may wait on the legal-accepted read. */
const BOOT_TIMEOUT_MS = 3000;

export default function Index() {
  const router = useRouter();
  const { colors } = useTheme();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;
    // Raced against a timeout: this screen's only other state is an indefinite
    // spinner, so a storage read that never settles takes the whole app with
    // it. A timeout resolves null and is handled exactly like a failed read.
    Promise.race([
      AppSettings.getLegalAccepted(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BOOT_TIMEOUT_MS)),
    ])
      .then((accepted) => {
        if (!mounted) return;
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
