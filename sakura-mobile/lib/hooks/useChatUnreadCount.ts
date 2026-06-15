import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { fetchChatThreads } from '@/lib/creator-social';
import { countUnreadThreads } from '@/lib/chat-utils';
import { getChatUnreadCount, setChatUnreadCount, subscribeChatUnreadCount } from '@/lib/chat-unread-store';
import { getOrRefreshWalletAuthSession, peekWalletAuthSession } from '@/lib/wallet-auth-session';
import { useWallet } from '@/lib/wallet/context';
import { useChatInboxRealtime } from '@/lib/hooks/useChatInboxRealtime';

export function useChatUnreadCount(options?: { allowUnlock?: boolean }) {
  const { connected, address, unlockForAppSession } = useWallet();
  const [unreadCount, setUnreadCount] = useState(getChatUnreadCount());

  useEffect(() => subscribeChatUnreadCount(setUnreadCount), []);

  const refresh = useCallback(async () => {
    if (!connected) {
      setChatUnreadCount(0);
      return;
    }

    let headers = peekWalletAuthSession('creator-chat');
    if (!headers && options?.allowUnlock) {
      headers = await getOrRefreshWalletAuthSession(unlockForAppSession, 'creator-chat');
    }
    if (!headers) return;

    try {
      const threads = await fetchChatThreads(headers);
      setChatUnreadCount(countUnreadThreads(threads));
    } catch {
      // keep last known count
    }
  }, [connected, options?.allowUnlock, unlockForAppSession]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  useChatInboxRealtime({
    enabled: connected && !!address && !!options?.allowUnlock,
    walletAddress: address,
    unlock: unlockForAppSession,
    onNewMessage: refresh,
  });

  return { unreadCount, refresh };
}
