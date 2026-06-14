type Listener = (count: number) => void;

let unreadCount = 0;
const listeners = new Set<Listener>();

export function getChatUnreadCount(): number {
  return unreadCount;
}

export function setChatUnreadCount(count: number): void {
  unreadCount = count;
  listeners.forEach((listener) => listener(count));
}

export function subscribeChatUnreadCount(listener: Listener): () => void {
  listeners.add(listener);
  listener(unreadCount);
  return () => listeners.delete(listener);
}
