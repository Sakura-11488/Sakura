import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import {
  useFonts,
  Nunito_400Regular,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
} from '@expo-google-fonts/nunito';
import { WalletProvider } from '@/lib/wallet/context';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { I18nProvider } from '@/lib/i18n';
import AnimatedSplash from '@/components/ui/AnimatedSplash';
import FallingLeaves from '@/components/ui/FallingLeaves';
import AnimeDownloadBridge from '@/components/anime/AnimeDownloadBridge';
import NotificationBridge from '@/components/notifications/NotificationBridge';
import PriceAlertBridge from '@/components/notifications/PriceAlertBridge';
import OtaUpdateBridge from '@/components/OtaUpdateBridge';
import CloudSyncBridge from '@/components/CloudSyncBridge';
import FloatingTradeWidget from '@/components/wallet/FloatingTradeWidget';
import { TransferCelebrationProvider } from '@/lib/wallet/transfer-celebration';

SplashScreen.preventAutoHideAsync();

function ThemedStatusBar() {
  const { isDark } = useTheme();
  return <StatusBar style={isDark ? 'light' : 'dark'} />;
}

function LiveActivityDeepLinkBridge() {
  const router = useRouter();

  useEffect(() => {
    const handleUrl = (url: string | null | undefined) => {
      if (!url || !url.startsWith('sakura://')) return;
      const parsed = Linking.parse(url);
      const path = parsed.path || '';

      if (path.startsWith('chapter/')) {
        const id = decodeURIComponent(path.replace(/^chapter\//, ''));
        const page = parsed.queryParams?.p ? String(parsed.queryParams.p) : undefined;
        router.push({
          pathname: '/chapter/[id]',
          params: page ? { id, p: page } : { id },
        });
        return;
      }

      if (path === 'novel/read') {
        const chapterPath = parsed.queryParams?.path ? String(parsed.queryParams.path) : '';
        const offset = parsed.queryParams?.o ? String(parsed.queryParams.o) : undefined;
        if (!chapterPath) return;
        router.push({
          pathname: '/novel/read',
          params: offset ? { path: chapterPath, o: offset } : { path: chapterPath },
        });
        return;
      }

      if (path === 'anime/watch') {
        const animeId = parsed.queryParams?.id ? String(parsed.queryParams.id) : '';
        const episodeId = parsed.queryParams?.ep ? String(parsed.queryParams.ep) : '';
        if (!animeId || !episodeId) return;
        router.push({
          pathname: '/anime/watch',
          params: { id: animeId, ep: episodeId },
        });
      }
    };

    Linking.getInitialURL().then(handleUrl).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, [router]);

  return null;
}

export default function RootLayout() {
  const [showSplash, setShowSplash] = useState(true);

  const [fontsLoaded, fontError] = useFonts({
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    const t = setTimeout(() => SplashScreen.hideAsync(), 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
        <I18nProvider>
        <WalletProvider>
          <TransferCelebrationProvider>
          <ThemedStatusBar />
          <LiveActivityDeepLinkBridge />
          <NotificationBridge />
          <Stack screenOptions={{ headerShown: false, animation: 'fade_from_bottom' }}>
            <Stack.Screen name="index" options={{ animation: 'none' }} />
            <Stack.Screen name="welcome" options={{ animation: 'fade', gestureEnabled: false }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="manga/[id]"   options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="anime/[id]"   options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="novel/[id]"   options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="novel/ext"    options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="novel/read"   options={{ animation: 'slide_from_bottom', gestureEnabled: true, gestureDirection: 'vertical', fullScreenGestureEnabled: true }} />
            <Stack.Screen name="anime/watch"  options={{ animation: 'slide_from_bottom', gestureEnabled: true, gestureDirection: 'vertical', fullScreenGestureEnabled: true }} />
            <Stack.Screen name="chapter/[id]" options={{ animation: 'slide_from_bottom', gestureEnabled: true, gestureDirection: 'vertical', fullScreenGestureEnabled: true }} />
            <Stack.Screen name="new-releases"  options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="search"       options={{ animation: 'fade' }} />
            <Stack.Screen name="ai"           options={{ animation: 'slide_from_bottom', gestureEnabled: true, gestureDirection: 'vertical', fullScreenGestureEnabled: true }} />
            <Stack.Screen name="pass"         options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="trade"        options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="downloads"    options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="reading-history" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="user/[wallet]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="become-creator" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-dashboard" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-upload" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-profile" options={{ animation: 'slide_from_right' }} />
          </Stack>
          <AnimeDownloadBridge />
          <OtaUpdateBridge />
          <CloudSyncBridge />
          <PriceAlertBridge />
          <FloatingTradeWidget />
          <FallingLeaves />
          {showSplash && (
            <AnimatedSplash onFinish={() => setShowSplash(false)} />
          )}
          </TransferCelebrationProvider>
        </WalletProvider>
        </I18nProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
