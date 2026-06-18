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
  const { address, connected, unlockForAppSession } = useWallet();
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const keypairRef = useRef<Awaited<ReturnType<typeof unlockForAppSession>>>(null);

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
        keypairRef.current = await unlockForAppSession();
      }
      const kp = keypairRef.current;
      if (!kp) return;
      const list = await listChatThreads(kp);
      applyThreads(list);
    } catch {
      // ignore — Face ID cancel, network, etc.
    }
  }, [connected, address, unlockForAppSession, applyThreads]);

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
    return subscribeToInboxThreads(ids, address, unlockForAppSession, (threadId, msg) => {
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
  }, [address, threadIdsKey, unlockForAppSession]);

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
