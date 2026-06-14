import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchCreatorChatMessages } from '@/lib/creator-social';
import { mergeChatMessages, type ChatMessageRow } from '@/lib/chat-utils';
import type { WalletAuthHeaders } from '@/lib/wallet-auth';

const POLL_MS = 4000;

type Options = {
  threadId: string | null;
  authHeaders: () => Promise<WalletAuthHeaders>;
  paused?: boolean;
  onMessages: (messages: ChatMessageRow[]) => void;
  onIncoming?: (messages: ChatMessageRow[]) => void;
};

export function useChatPolling({ threadId, authHeaders, paused, onMessages, onIncoming }: Options) {
  const messagesRef = useRef<ChatMessageRow[]>([]);

  const poll = useCallback(async () => {
    if (!threadId || paused) return;
    try {
      const headers = await authHeaders();
      const rows = await fetchCreatorChatMessages({
        threadId,
        authHeaders: headers,
        markRead: true,
      });
      const merged = mergeChatMessages(messagesRef.current, rows);
      if (merged !== messagesRef.current) {
        onIncoming?.(merged);
        messagesRef.current = merged;
        onMessages(merged);
      }
    } catch {
      // silent poll failure
    }
  }, [authHeaders, onIncoming, onMessages, paused, threadId]);

  const setMessages = useCallback((messages: ChatMessageRow[]) => {
    messagesRef.current = messages;
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!threadId) return;
      poll();
      const id = setInterval(poll, POLL_MS);
      return () => clearInterval(id);
    }, [poll, threadId]),
  );

  return { setMessages, refresh: poll };
}
