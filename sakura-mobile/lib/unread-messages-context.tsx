import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { useWallet } from './wallet/context';
import { getPassiveSessionKeypair } from './wallet/app-session';
import { listChatThreads, isThreadUnread, type ChatThreadSummary } from './chat';
import { subscribeToInboxThreads } from './chat-realtime';

type UnreadMessagesContextValue = {
  unreadCount: number;
  threads: ChatThreadSummary[];
  refresh: () => Promise<void>;
};

const UnreadMessagesContext = createContext<UnreadMessagesContextValue>({
  unreadCount: 0,
  threads: [],
  refresh: async () => {},
});

export function useUnreadMessages() {
  return useContext(UnreadMessagesContext);
}

function countUnread(threads: ChatThreadSummary[], wallet: string | null): number {
  if (!wallet) return 0;
  return threads.filter((t) => isThreadUnread(t, wallet)).length;
}

export function UnreadMessagesProvider({ children }: { children: React.ReactNode }) {
  const { address, connected } = useWallet();
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const keypairRef = useRef<Awaited<ReturnType<typeof getPassiveSessionKeypair>>>(null);

  const applyThreads = useCallback(
    (next: ChatThreadSummary[]) => {
      setThreads(next);
      setUnreadCount(countUnread(next, address));
    },
    [address],
  );

  const refresh = useCallback(async () => {
    if (!connected || !address) {
      applyThreads([]);
      return;
    }
    try {
      if (!keypairRef.current) {
        // Passive on purpose: this provider is mounted at the app root and runs
        // on every launch, so unlocking here popped "Confirm transaction" on the
        // home screen (and Face ID on native) before the user had done anything
        // — for an unread badge. The passive read signs only if the wallet is
        // already warm, or on web where the key is readable without a prompt.
        // An unread count is not worth a wallet prompt; it fills in as soon as
        // any real wallet action unlocks the session.
        keypairRef.current = await getPassiveSessionKeypair();
      }
      const kp = keypairRef.current;
      if (!kp) return;
      const list = await listChatThreads(kp);
      applyThreads(list);
    } catch {
      // ignore — network, locked wallet, etc.
    }
  }, [connected, address, applyThreads]);

  useEffect(() => {
    keypairRef.current = null;
    refresh();
  }, [address, connected, refresh]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const threadIdsKey = useMemo(
    () => threads.map((t) => t.thread_id).sort().join(','),
    [threads],
  );

  useEffect(() => {
    if (!address || !threadIdsKey) return;

    const ids = threadIdsKey.split(',').filter(Boolean);
    // Passive for the same reason as refresh() above — a background inbox
    // subscription must never be the thing that asks for the wallet.
    return subscribeToInboxThreads(ids, address, getPassiveSessionKeypair, (threadId, msg) => {
      setThreads((prev) => {
        const next = prev.map((t) =>
          t.thread_id === threadId
            ? {
                ...t,
                last_message: msg.content,
                last_message_at: msg.created_at,
                last_message_sender: msg.sender_wallet,
              }
            : t,
        );
        setUnreadCount(countUnread(next, address));
        return next;
      });
    });
  }, [address, threadIdsKey]);

  const value = useMemo(
    () => ({ unreadCount, threads, refresh }),
    [unreadCount, threads, refresh],
  );

  return (
    <UnreadMessagesContext.Provider value={value}>
      {children}
    </UnreadMessagesContext.Provider>
  );
}
