import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { mergeChatMessages, type ChatMessageRow } from '@/lib/chat-utils';
import { ensureRealtimeAuth } from '@/lib/wallet-realtime-session';

const FALLBACK_POLL_MS = 30_000;

type RealtimeRow = {
  id: string;
  sender_wallet: string;
  content: string;
  created_at: string;
  moderation_state?: string;
};

type Options = {
  threadId: string | null;
  enabled: boolean;
  paused?: boolean;
  walletAddress?: string | null;
  unlock: () => Promise<import('@solana/web3.js').Keypair | null>;
  onMessages: (messages: ChatMessageRow[]) => void;
  onFallbackPoll?: () => void;
};

function toChatRow(row: RealtimeRow): ChatMessageRow {
  return {
    id: row.id,
    sender_wallet: row.sender_wallet,
    content: row.content,
    created_at: row.created_at,
  };
}

export function useChatRealtime({
  threadId,
  enabled,
  paused,
  walletAddress,
  unlock,
  onMessages,
  onFallbackPoll,
}: Options) {
  const messagesRef = useRef<ChatMessageRow[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pausedRef = useRef(paused ?? false);
  const onMessagesRef = useRef(onMessages);
  const onFallbackPollRef = useRef(onFallbackPoll);

  pausedRef.current = paused ?? false;
  onMessagesRef.current = onMessages;
  onFallbackPollRef.current = onFallbackPoll;

  const setMessages = useCallback((messages: ChatMessageRow[]) => {
    messagesRef.current = messages;
  }, []);

  const appendRow = useCallback((row: RealtimeRow) => {
    if (pausedRef.current) return;
    if (row.moderation_state === 'removed') return;
    const merged = mergeChatMessages(messagesRef.current, [toChatRow(row)]);
    if (merged !== messagesRef.current) {
      messagesRef.current = merged;
      onMessagesRef.current(merged);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!threadId || !enabled) return;

      let active = true;
      let fallbackTimer: ReturnType<typeof setInterval> | null = null;
      let realtimeReady = false;

      const startFallback = () => {
        if (fallbackTimer || !onFallbackPollRef.current) return;
        fallbackTimer = setInterval(() => {
          if (active && !pausedRef.current) onFallbackPollRef.current?.();
        }, FALLBACK_POLL_MS);
      };

      const stopFallback = () => {
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
      };

      (async () => {
        try {
          await ensureRealtimeAuth(unlock, walletAddress ?? null);
          if (!active) return;

          const channel = supabase
            .channel(`chat-thread:${threadId}`)
            .on(
              'postgres_changes',
              {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
                filter: `thread_id=eq.${threadId}`,
              },
              (payload) => {
                appendRow(payload.new as RealtimeRow);
              },
            )
            .subscribe((status) => {
              if (status === 'SUBSCRIBED') {
                realtimeReady = true;
                stopFallback();
              }
              if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                realtimeReady = false;
                startFallback();
              }
            });

          channelRef.current = channel;
        } catch {
          startFallback();
        }
      })();

      return () => {
        active = false;
        stopFallback();
        if (channelRef.current) {
          supabase.removeChannel(channelRef.current);
          channelRef.current = null;
        }
        if (!realtimeReady) {
          // next focus will retry
        }
      };
    }, [appendRow, enabled, threadId, unlock, walletAddress]),
  );

  return { setMessages };
}
