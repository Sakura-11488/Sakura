import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useWallet } from '@/lib/wallet/context';
import { AppSettings } from '@/lib/settings';
import { registerForPushNotifications, getNotificationPermissionStatus } from '@/lib/notifications';
import { pingPushActivity, syncPushRegistration } from '@/lib/push-tokens';
import { useTransferCelebration } from '@/lib/wallet/transfer-celebration';

function routeFromNotificationData(
  router: ReturnType<typeof useRouter>,
  data: Record<string, unknown> | undefined,
) {
  if (!data) return;
  const type = data.type as string | undefined;
  const id = data.id as string | undefined;

  if (type === 'chat_message') {
    const threadId = typeof data.threadId === 'string' ? data.threadId : undefined;
    const senderWallet = typeof data.wallet === 'string' ? data.wallet : '';
    if (threadId) {
      router.push({
        pathname: '/messages/[threadId]',
        params: {
          threadId,
          peerName: typeof data.peerName === 'string' ? data.peerName : '',
          peerUsername: typeof data.peerUsername === 'string' ? data.peerUsername : '',
          peerSeed: senderWallet ? senderWallet.slice(0, 8) : '',
        },
      } as never);
    } else {
      router.push('/(tabs)/messages');
    }
    return;
  }

  if (type === 'home') {
    router.push('/(tabs)/home');
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
  const { showCelebration } = useTransferCelebration();
  const syncingRef = useRef(false);

  const handleTransferNotification = (data: Record<string, unknown> | undefined) => {
    if (!data) return;
    const type = data.type as string | undefined;
    if (type !== 'sakura_transfer' && type !== 'sol_transfer') return;
    if (data.role !== 'received') return;
    const amount = Number(data.amount);
    const counterparty = typeof data.counterparty === 'string' ? data.counterparty : '';
    if (!Number.isFinite(amount) || amount <= 0 || !counterparty) return;
    const asset = type === 'sol_transfer' || data.asset === 'sol' ? 'sol' : 'sakura';
    showCelebration({
      role: 'received',
      asset,
      amount,
      counterparty,
    });
  };

  const refreshRegistration = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      const enabled = await AppSettings.getPushEnabled();
      if (!enabled) return;

      const permission = await getNotificationPermissionStatus();
      if (permission !== 'granted') {
        await AppSettings.setPushEnabled(false);
        return;
      }

      if (!address) return;

      await registerForPushNotifications();
      await syncPushRegistration(address);
      await pingPushActivity(address).catch(() => {});
    } catch (e) {
      if (__DEV__) console.warn('[push] refresh registration failed', e);
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
    const received = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as Record<string, unknown> | undefined;
      handleTransferNotification(data);
    });

    const open = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      handleTransferNotification(data);
      routeFromNotificationData(router, data);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        const data = response.notification.request.content.data as Record<string, unknown> | undefined;
        handleTransferNotification(data);
        routeFromNotificationData(router, data);
      })
      .catch(() => {});

    return () => {
      received.remove();
      open.remove();
    };
  }, [router, showCelebration]);

  return null;
}
