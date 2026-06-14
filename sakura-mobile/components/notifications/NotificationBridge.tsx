import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useWallet } from '@/lib/wallet/context';
import { AppSettings } from '@/lib/settings';
import { registerForPushNotifications } from '@/lib/notifications';
import { pingPushActivity, syncPushRegistration } from '@/lib/push-tokens';

function routeFromNotificationData(
  router: ReturnType<typeof useRouter>,
  data: Record<string, unknown> | undefined,
) {
  if (!data) return;
  const type = data.type as string | undefined;
  const id = data.id as string | undefined;

  if (type === 'home') {
    router.push('/(tabs)');
    return;
  }
  if (type === 'new_releases') {
    router.push('/new-releases');
    return;
  }
  if (type === 'pass_reminder') {
    router.push('/(tabs)/settings');
    return;
  }
  if (type === 'chat_message') {
    const threadId = data.threadId ? String(data.threadId) : undefined;
    const wallet = data.wallet ? String(data.wallet) : undefined;
    if (threadId) {
      router.push({
        pathname: '/creator-chat',
        params: { thread: threadId, wallet },
      } as never);
    }
    return;
  }
  if (!type || !id) return;

  if (type === 'anime') {
    router.push({ pathname: '/anime/[id]', params: { id } });
    return;
  }
  if (type === 'manga') {
    const chapterId = data.chapterId as string | undefined;
    if (chapterId) {
      router.push({ pathname: '/chapter/[id]', params: { id: chapterId } });
      return;
    }
    router.push({ pathname: '/manga/[id]', params: { id } });
    return;
  }
  if (type === 'novel') {
    router.push(`/novel/ext?path=${encodeURIComponent(id)}` as any);
    return;
  }
  if (type === 'chapter') {
    const page = data.page != null ? String(data.page) : undefined;
    router.push({
      pathname: '/chapter/[id]',
      params: page ? { id, p: page } : { id },
    });
  }
}

export default function NotificationBridge() {
  const router = useRouter();
  const { address } = useWallet();
  const syncingRef = useRef(false);

  const refreshRegistration = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      const enabled = await AppSettings.getPushEnabled();
      if (!enabled) return;
      await registerForPushNotifications();
      await syncPushRegistration(address);
      await pingPushActivity(address).catch(() => {});
    } catch {
      // ignore background refresh failures
    } finally {
      syncingRef.current = false;
    }
  };

  useEffect(() => {
    if (!address) return;
    refreshRegistration();
  }, [address]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshRegistration();
    });
    return () => sub.remove();
  }, [address]);

  useEffect(() => {
    const open = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      routeFromNotificationData(router, data);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        const data = response.notification.request.content.data as Record<string, unknown> | undefined;
        routeFromNotificationData(router, data);
      })
      .catch(() => {});

    return () => open.remove();
  }, [router]);

  return null;
}
