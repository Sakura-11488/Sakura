import type { ChatThreadSummary } from './creator-social';

export type ChatMessageRow = {
  id: string;
  sender_wallet: string;
  content: string;
  created_at: string;
  pending?: boolean;
};

export function isThreadUnread(thread: ChatThreadSummary): boolean {
  if (!thread.last_message_at) return false;
  if (!thread.last_read_at) return true;
  return new Date(thread.last_message_at) > new Date(thread.last_read_at);
}

export function countUnreadThreads(threads: ChatThreadSummary[]): number {
  return threads.filter(isThreadUnread).length;
}

export function mergeChatMessages(existing: ChatMessageRow[], incoming: ChatMessageRow[]): ChatMessageRow[] {
  const pending = existing.filter((m) => m.pending);
  const byId = new Map<string, ChatMessageRow>();

  for (const row of incoming) {
    byId.set(row.id, row);
  }
  for (const row of pending) {
    byId.set(row.id, row);
  }

  const merged = [...byId.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  if (
    merged.length === existing.length &&
    merged.every((row, i) => row.id === existing[i]?.id && row.content === existing[i]?.content)
  ) {
    return existing;
  }

  return merged;
}

export function hasNewIncomingMessages(
  existing: ChatMessageRow[],
  incoming: ChatMessageRow[],
  viewerWallet: string,
): boolean {
  const existingIds = new Set(existing.map((m) => m.id));
  return incoming.some((m) => !existingIds.has(m.id) && m.sender_wallet !== viewerWallet);
}

export function formatPeerLabel(input: {
  peer_username?: string | null;
  peer_display_name?: string | null;
  peer_wallet?: string | null;
}): string {
  if (input.peer_username) return `@${input.peer_username}`;
  if (input.peer_display_name?.trim()) return input.peer_display_name.trim();
  if (input.peer_wallet) return `${input.peer_wallet.slice(0, 4)}…${input.peer_wallet.slice(-4)}`;
  return 'Unknown';
}
