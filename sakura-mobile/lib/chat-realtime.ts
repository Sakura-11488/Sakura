import type { Keypair } from '@solana/web3.js';
import { supabase } from './supabase';
import type { ChatMessage } from './chat';
import { ensureRealtimeAuth } from './wallet-realtime-session';

const TYPING_TTL_MS = 5000;

export type ChatRealtimeHandlers = {
  onMessage: (message: ChatMessage) => void;
  onPeerRead?: (lastReadAt: string) => void;
  onPeerTyping?: (typing: boolean) => void;
};

export type InboxMessageHandler = (threadId: string, message: ChatMessage) => void;

type UnlockFn = () => Promise<Keypair | null>;

let channelSeq = 0;

function uniqueChannelName(prefix: string): string {
  channelSeq += 1;
  return `${prefix}-${channelSeq}-${Date.now().toString(36)}`;
}

function isTypingActive(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  return Date.now() - new Date(updatedAt).getTime() <= TYPING_TTL_MS;
}

/** Live updates for an open conversation thread. */
export function subscribeToChatThread(
  threadId: string,
  myWallet: string | null,
  unlock: UnlockFn,
  handlers: ChatRealtimeHandlers,
): () => void {
  let active = true;
  let channelCleanup: (() => void) | null = null;

  (async () => {
    try {
      await ensureRealtimeAuth(unlock, myWallet);
      if (!active) return;

      const channel = supabase
        .channel(uniqueChannelName(`chat-thread-${threadId}`))
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            handlers.onMessage(payload.new as ChatMessage);
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'chat_members',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            const row = payload.new as { wallet_address?: string; last_read_at?: string | null };
            if (!myWallet || row.wallet_address === myWallet) return;
            if (row.last_read_at && handlers.onPeerRead) {
              handlers.onPeerRead(row.last_read_at);
            }
          },
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'chat_typing',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            const row = (payload.new ?? payload.old) as {
              wallet_address?: string;
              updated_at?: string;
            } | null;
            if (!row?.wallet_address || !myWallet || row.wallet_address === myWallet) return;
            if (payload.eventType === 'DELETE') {
              handlers.onPeerTyping?.(false);
              return;
            }
            handlers.onPeerTyping?.(isTypingActive(row.updated_at));
          },
        )
        .subscribe();

      channelCleanup = () => {
        supabase.removeChannel(channel);
      };
    } catch {
      // caller falls back to polling
    }
  })();

  return () => {
    active = false;
    channelCleanup?.();
    channelCleanup = null;
  };
}

/** Patch inbox rows when new messages arrive on background threads. */
export function subscribeToInboxThreads(
  threadIds: string[],
  myWallet: string | null,
  unlock: UnlockFn,
  handler: InboxMessageHandler,
): () => void {
  const ids = [...new Set(threadIds.filter(Boolean))].slice(0, 30);
  if (!ids.length) return () => {};

  let active = true;
  let channelCleanup: (() => void) | null = null;

  (async () => {
    try {
      await ensureRealtimeAuth(unlock, myWallet);
      if (!active) return;

      const channel = supabase.channel(
        uniqueChannelName(`chat-inbox-${ids.length}-${ids[0]?.slice(0, 8) ?? 'x'}`),
      );

      for (const threadId of ids) {
        channel.on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages',
            filter: `thread_id=eq.${threadId}`,
          },
          (payload) => {
            handler(threadId, payload.new as ChatMessage);
          },
        );
      }

      channel.subscribe();
      channelCleanup = () => {
        supabase.removeChannel(channel);
      };
    } catch {
      // inbox still refreshes on focus
    }
  })();

  return () => {
    active = false;
    channelCleanup?.();
    channelCleanup = null;
  };
}
