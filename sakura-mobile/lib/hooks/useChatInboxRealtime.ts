import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { ensureRealtimeAuth } from '@/lib/wallet-realtime-session';

type Options = {
  enabled: boolean;
  walletAddress?: string | null;
  unlock: () => Promise<import('@solana/web3.js').Keypair | null>;
  onNewMessage: () => void;
};

export function useChatInboxRealtime({ enabled, walletAddress, unlock, onNewMessage }: Options) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onNewMessageRef = useRef(onNewMessage);
  onNewMessageRef.current = onNewMessage;

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;

      let active = true;

      (async () => {
        try {
          await ensureRealtimeAuth(unlock, walletAddress ?? null);
          if (!active) return;

          const channel = supabase
            .channel(`chat-inbox:${walletAddress ?? 'anon'}`)
            .on(
              'postgres_changes',
              {
                event: 'INSERT',
                schema: 'public',
                table: 'chat_messages',
              },
              () => {
                onNewMessageRef.current();
              },
            )
            .subscribe();

          channelRef.current = channel;
        } catch {
          // inbox falls back to focus refresh
        }
      })();

      return () => {
        active = false;
        if (channelRef.current) {
          supabase.removeChannel(channelRef.current);
          channelRef.current = null;
        }
      };
    }, [enabled, unlock, walletAddress]),
  );
}
