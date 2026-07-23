import type { ChatMessage } from './chat';
import { pendingMatchesConfirmed } from './chat-media';

const LOCAL_ORPHAN_MS = 120_000;

export type ChatListItem =
  | { kind: 'date'; id: string; label: string }
  | {
      kind: 'message';
      id: string;
      message: ChatMessage;
      isMine: boolean;
      isFirstInGroup: boolean;
      isLastInGroup: boolean;
      showMeta: boolean;
      pending?: boolean;
    };

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatChatDateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfMsg.getTime()) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function buildChatListItems(
  messages: ChatMessage[],
  myWallet: string | null,
): ChatListItem[] {
  const items: ChatListItem[] = [];
  let lastDay = '';

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const dk = dayKey(message.created_at);
    if (dk !== lastDay) {
      lastDay = dk;
      items.push({
        kind: 'date',
        id: `date-${dk}`,
        label: formatChatDateLabel(message.created_at),
      });
    }

    const isMine = message.sender_wallet === myWallet;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const prevSame =
      prev &&
      prev.sender_wallet === message.sender_wallet &&
      dayKey(prev.created_at) === dk;
    const nextSame =
      next &&
      next.sender_wallet === message.sender_wallet &&
      dayKey(next.created_at) === dk;

    items.push({
      kind: 'message',
      id: message.id,
      message,
      isMine,
      isFirstInGroup: !prevSame,
      isLastInGroup: !nextSame,
      showMeta: !nextSame,
      pending: message.id.startsWith('pending-'),
    });
  }

  return items;
}

export function mergeChatMessagesFromServer(
  prev: ChatMessage[],
  server: ChatMessage[],
  _myWallet: string | null = null,
): ChatMessage[] {
  const serverIds = new Set(server.map((m) => m.id));

  const pending = prev.filter(
    (m) =>
      m.id.startsWith('pending-') &&
      !server.some((s) => pendingMatchesConfirmed(m, s)),
  );

  // The server only returns the latest page (~50). As new messages arrive, that
  // window slides forward and older already-loaded messages fall out of it — the
  // previous 120s-only rule then dropped them, so messages you'd already scrolled
  // silently vanished. Keep an orphan (not in this page) when it is EITHER older
  // than the page's oldest row (scroll-back history below the window) OR a very
  // recent realtime insert. A message that sits inside the window yet is absent
  // from the page is a genuine removal, so it is (correctly) dropped.
  const oldestServer = server.length
    ? Math.min(...server.map((m) => new Date(m.created_at).getTime()))
    : Infinity;
  const recentOrphans = prev.filter((m) => {
    if (m.id.startsWith('pending-') || serverIds.has(m.id)) return false;
    const t = new Date(m.created_at).getTime();
    return t < oldestServer || Date.now() - t < LOCAL_ORPHAN_MS;
  });

  const byId = new Map<string, ChatMessage>();
  for (const message of [...server, ...pending, ...recentOrphans]) {
    byId.set(message.id, message);
  }

  return [...byId.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

export function mergeChatMessage(
  prev: ChatMessage[],
  incoming: ChatMessage,
  myWallet: string | null,
): ChatMessage[] {
  if (prev.some((m) => m.id === incoming.id)) return prev;

  let next = prev;
  if (incoming.sender_wallet === myWallet) {
    next = prev.filter(
      (m) => !(m.id.startsWith('pending-') && pendingMatchesConfirmed(m, incoming)),
    );
    if (next.some((m) => m.id === incoming.id)) return next;
  }

  return [...next, incoming].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

export function createPendingMessage(
  threadId: string,
  senderWallet: string,
  content: string,
  messageType = 'text',
): ChatMessage {
  return {
    id: `pending-${Date.now()}`,
    thread_id: threadId,
    sender_wallet: senderWallet,
    content,
    message_type: messageType,
    created_at: new Date().toISOString(),
  };
}
