import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { AppSettings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';

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

    AppSettings.getLegalAccepted()
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
