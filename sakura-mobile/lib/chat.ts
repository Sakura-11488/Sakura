import type { Keypair } from '@solana/web3.js';
import { invokeCreatorFunction } from './creator-api';

export interface ChatThreadSummary {
  thread_id: string;
  role: string;
  last_read_at: string | null;
  peer_wallet: string | null;
  peer_username: string | null;
  peer_display_name: string | null;
  peer_avatar_url: string | null;
  peer_avatar_seed: string | null;
  peer_last_read_at: string | null;
  peer_is_typing?: boolean;
  last_message: string | null;
  last_message_at: string | null;
  last_message_sender: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  sender_wallet: string;
  content: string;
  message_type: string;
  created_at: string;
}

export interface ChatThreadPresence {
  peer_wallet: string | null;
  peer_last_read_at: string | null;
  peer_is_typing: boolean;
}

export interface ChatMessagesResult {
  messages: ChatMessage[];
  peer_last_read_at: string | null;
  peer_is_typing: boolean;
}

export function isMessageRead(messageCreatedAt: string, peerLastReadAt: string | null): boolean {
  if (!peerLastReadAt) return false;
  return new Date(peerLastReadAt).getTime() >= new Date(messageCreatedAt).getTime();
}

export function isThreadUnread(item: ChatThreadSummary, myWallet: string | null): boolean {
  if (!myWallet || !item.last_message_at) return false;
  if (item.last_message_sender === myWallet) return false;
  return !item.last_read_at || item.last_message_at > item.last_read_at;
}

export async function listChatThreads(keypair: Keypair): Promise<ChatThreadSummary[]> {
  const res = await invokeCreatorFunction<{ threads: ChatThreadSummary[] }>(
    'creator-chat',
    'creator-chat',
    keypair,
    { action: 'threads' },
  );
  return res.threads ?? [];
}

export async function getChatMessages(
  keypair: Keypair,
  threadId: string,
  markRead = true,
): Promise<ChatMessagesResult> {
  const res = await invokeCreatorFunction<ChatMessagesResult>(
    'creator-chat',
    'creator-chat',
    keypair,
    { action: 'messages', thread_id: threadId, mark_read: markRead },
  );
  return {
    messages: res.messages ?? [],
    peer_last_read_at: res.peer_last_read_at ?? null,
    peer_is_typing: res.peer_is_typing ?? false,
  };
}

export async function getChatThreadStatus(
  keypair: Keypair,
  threadId: string,
): Promise<ChatThreadPresence> {
  return invokeCreatorFunction<ChatThreadPresence>('creator-chat', 'creator-chat', keypair, {
    action: 'status',
    thread_id: threadId,
  });
}

export async function setChatTyping(
  keypair: Keypair,
  threadId: string,
  typing: boolean,
): Promise<void> {
  await invokeCreatorFunction('creator-chat', 'creator-chat', keypair, {
    action: 'typing',
    thread_id: threadId,
    typing,
  });
}

export async function startChatThread(
  keypair: Keypair,
  recipientWallet: string,
): Promise<string> {
  const res = await invokeCreatorFunction<{ thread_id: string }>(
    'creator-chat',
    'creator-chat',
    keypair,
    { action: 'start', recipient_wallet: recipientWallet },
  );
  if (!res.thread_id) throw new Error('Could not start chat.');
  return res.thread_id;
}

export async function sendChatMessage(
  keypair: Keypair,
  threadId: string,
  content: string,
  messageType = 'text',
): Promise<ChatMessage> {
  const res = await invokeCreatorFunction<{ message: ChatMessage; thread_id: string }>(
    'creator-chat',
    'creator-chat',
    keypair,
    { action: 'send', thread_id: threadId, content, message_type: messageType },
  );
  return res.message;
}

export async function markChatRead(keypair: Keypair, threadId: string): Promise<void> {
  await invokeCreatorFunction('creator-chat', 'creator-chat', keypair, {
    action: 'mark_read',
    thread_id: threadId,
  });
}
