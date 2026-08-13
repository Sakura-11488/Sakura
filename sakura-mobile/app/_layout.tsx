import { useEffect, useState } from 'react';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
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
import { WebTransactionAuthProvider } from '@/lib/wallet/web-transaction-auth';
import HttpImageShim from '@/components/web/HttpImageShim';
import {
  Platform,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { UnreadMessagesProvider } from '@/lib/unread-messages-context';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { I18nProvider } from '@/lib/i18n';
import { ContentPrefsProvider } from '@/lib/content-prefs';
import AnimatedSplash from '@/components/ui/AnimatedSplash';
import FallingLeaves from '@/components/ui/FallingLeaves';
import AnimeDownloadBridge from '@/components/anime/AnimeDownloadBridge';
import NotificationBridge from '@/components/notifications/NotificationBridge';
import PriceAlertBridge from '@/components/notifications/PriceAlertBridge';
import OtaUpdateBridge from '@/components/OtaUpdateBridge';
import AppUpdateBridge from '@/components/AppUpdateBridge';
import InstallAppBanner from '@/components/InstallAppBanner';
import WebUpdateBanner from '@/components/WebUpdateBanner';
import CloudSyncBridge from '@/components/CloudSyncBridge';
import AvatarApologyBridge from '@/components/AvatarApologyBridge';
import FloatingTradeWidget from '@/components/wallet/FloatingTradeWidget';
import { TransferCelebrationProvider } from '@/lib/wallet/transfer-celebration';

export const unstable_settings = {
  initialRouteName: 'index',
};

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
        // Preserve source/offline so a comic or 18+ chapter reopened from the
        // Live Activity routes to the right reader backend instead of manga.
        const source = parsed.queryParams?.source ? String(parsed.queryParams.source) : undefined;
        const offline = parsed.queryParams?.offline ? String(parsed.queryParams.offline) : undefined;
        router.push({
          pathname: '/chapter/[id]',
          params: {
            id,
            ...(page ? { p: page } : {}),
            ...(source ? { source } : {}),
            ...(offline ? { offline } : {}),
          },
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

/**
 * Root error boundary.
 *
 * Without this, any render-time crash leaves a blank screen and sends the reason
 * to a console. That is fine in a browser tab and useless in an installed PWA,
 * where the app runs in its own window with no easy devtools — which is exactly
 * the situation this was added in, after a blank screen that could not be
 * diagnosed because the only evidence was somewhere unreachable.
 *
 * The message is selectable so it can be copied into a bug report, and the stack
 * is included because "which component" is usually the entire question.
 *
 * Same principle as surfacing the real reason behind "Could not load anime":
 * a failure nobody can see is a failure nobody can fix.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={ebStyles.root}>
      <ScrollView contentContainerStyle={ebStyles.scroll}>
        <Text style={ebStyles.title}>Something broke</Text>
        <Text selectable style={ebStyles.message}>
          {error?.message ?? String(error)}
        </Text>
        {error?.stack ? (
          <Text selectable style={ebStyles.stack}>
            {error.stack.slice(0, 900)}
          </Text>
        ) : null}
        <TouchableOpacity onPress={() => retry()} style={ebStyles.button}>
          <Text style={ebStyles.buttonText}>Try again</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const ebStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0F0F13' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  title: { color: '#F2F2F7', fontSize: 20, fontWeight: '800' },
  message: { color: '#FF6B6B', fontSize: 14, lineHeight: 20 },
  stack: { color: '#98989F', fontSize: 11, lineHeight: 16 },
  button: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: '#252529',
    borderWidth: 1,
    borderColor: '#3A3A3E',
  },
  buttonText: { color: '#F2F2F7', fontWeight: '700' },
});

export default function RootLayout() {
  const [showSplash, setShowSplash] = useState(Platform.OS !== 'web');

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
        <ContentPrefsProvider>
        <WalletProvider>
          <WebTransactionAuthProvider>
          <UnreadMessagesProvider>
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
            <Stack.Screen name="swap-xp"      options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="trade"        options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="downloads"    options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="reading-history" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="user/[wallet]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator/[username]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="messages/[threadId]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-chat" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="become-creator" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-dashboard" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-upload" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-profile" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-verification" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-feed" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="creator-coin-launch" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="messages" options={{ animation: 'slide_from_right' }} />
          </Stack>
          <AnimeDownloadBridge />
          <OtaUpdateBridge />
          <AppUpdateBridge />
          <InstallAppBanner />
          <WebUpdateBanner />
          <CloudSyncBridge />
          <AvatarApologyBridge />
          <PriceAlertBridge />
          <FloatingTradeWidget />
          <FallingLeaves />
          {Platform.OS === 'web' ? <HttpImageShim /> : null}
          {showSplash && (
            <AnimatedSplash onFinish={() => setShowSplash(false)} />
          )}
          </TransferCelebrationProvider>
          </UnreadMessagesProvider>
          </WebTransactionAuthProvider>
        </WalletProvider>
        </ContentPrefsProvider>
        </I18nProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
