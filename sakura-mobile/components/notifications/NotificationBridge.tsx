import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useWallet } from '@/lib/wallet/context';
import { AppSettings } from '@/lib/settings';
import { registerForPushNotifications, getNotificationPermissionStatus } from '@/lib/notifications';
import { pingPushActivity, syncPushRegistration } from '@/lib/push-tokens';
import { useTransferCelebration } from '@/lib/wallet/transfer-celebration';

/**
 * The reader route for a chapter push, or null when the payload cannot name
 * one. The reader only understands `<seriesId>~<chapterId>` — it needs the
 * series to load the chapter list and pages — but push-manga-updates sends
 * the two separately ({ type: 'manga', id: seriesId, chapterId, chapter: 12 }),
 * and the old route passed the chapter id alone, so every new-chapter tap
 * opened an empty "No pages found" reader. Exported for its test.
 */
export function chapterRouteFromPush(data: Record<string, unknown>): {
  pathname: '/chapter/[id]';
  params: Record<string, string>;
} | null {
  const str = (value: unknown) =>
    typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const type = str(data.type);
  const id = str(data.id);
  let seriesId = str(data.mangaId) || str(data.seriesId);
  let chapterId = str(data.chapterId);
  if (type === 'manga') {
    seriesId = seriesId || id;
  } else if (type === 'chapter') {
    // Already a reader id, or a bare chapter id alongside its series.
    if (id.includes('~')) {
      const at = id.indexOf('~');
      seriesId = seriesId || id.slice(0, at);
      chapterId = chapterId || id.slice(at + 1);
    } else {
      chapterId = chapterId || id;
    }
  } else {
    return null;
  }
  if (!seriesId || !chapterId) return null;
  const params: Record<string, string> = { id: `${seriesId}~${chapterId}` };
  const number = str(data.chapter);
  const label = str(data.chapterLabel) || (number ? `Chapter ${number}` : '');
  if (label) params.chapter = label;
  const title = str(data.title) || str(data.seriesTitle);
  if (title) params.title = title;
  const page = str(data.page);
  if (page) params.p = page;
  // Manhwa and comics chapters only open through their own source.
  const source = str(data.source);
  if (source) params.source = source;
  return { pathname: '/chapter/[id]', params };
}

export function routeFromNotificationData(
  router: Pick<ReturnType<typeof useRouter>, 'push'>,
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
    router.push('/home');
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
    const chapterRoute = data.chapterId ? chapterRouteFromPush(data) : null;
    if (chapterRoute) {
      router.push(chapterRoute);
      return;
    }
    const source = typeof data.source === 'string' && data.source ? { source: data.source } : {};
    router.push({ pathname: '/manga/[id]', params: { id, ...source } });
    return;
  }
  if (type === 'novel') {
    router.push(`/novel/ext?path=${encodeURIComponent(id)}` as any);
    return;
  }
  if (type === 'chapter') {
    // Only with both halves of the id; a bare chapter id cannot be opened.
    const chapterRoute = chapterRouteFromPush(data);
    if (chapterRoute) router.push(chapterRoute);
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
