export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  updatedAt: string;
  lastMessage: string;
}

const MAX_TURNS = 200;
const PREFIX = 'sakura_ai_';

function sanitize(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44);
}

function indexKey(walletKey: string): string {
  return `${PREFIX}threads_${sanitize(walletKey)}`;
}

function msgsKey(walletKey: string, threadId: string): string {
  return `${PREFIX}msgs_${sanitize(walletKey)}_${sanitize(threadId)}`;
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, data: unknown): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, JSON.stringify(data));
}

export async function loadHistory(walletKey: string, threadId: string): Promise<StoredMessage[]> {
  return readJSON<StoredMessage[]>(msgsKey(walletKey, threadId), []);
}

export async function saveMessage(
  walletKey: string,
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  isFirstInThread = false,
): Promise<void> {
  const messageKey = msgsKey(walletKey, threadId);
  let msgs = readJSON<StoredMessage[]>(messageKey, []);
  msgs.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
  });
  if (msgs.length > MAX_TURNS) msgs = msgs.slice(-MAX_TURNS);
  writeJSON(messageKey, msgs);

  const threadIndexKey = indexKey(walletKey);
  let threads = readJSON<ChatThread[]>(threadIndexKey, []);
  const pos = threads.findIndex((t) => t.id === threadId);
  const title =
    isFirstInThread && role === 'user'
      ? content.slice(0, 44)
      : pos >= 0
        ? threads[pos].title
        : 'New Chat';
  const entry: ChatThread = {
    id: threadId,
    title,
    updatedAt: new Date().toISOString(),
    lastMessage: content.slice(0, 80),
  };
  if (pos >= 0) threads[pos] = entry;
  else threads.unshift(entry);
  writeJSON(threadIndexKey, threads);
}

export async function listThreads(walletKey: string): Promise<ChatThread[]> {
  const threads = readJSON<ChatThread[]>(indexKey(walletKey), []);
  return threads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function deleteThread(walletKey: string, threadId: string): Promise<void> {
  const threadIndexKey = indexKey(walletKey);
  let threads = readJSON<ChatThread[]>(threadIndexKey, []);
  threads = threads.filter((t) => t.id !== threadId);
  writeJSON(threadIndexKey, threads);
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(msgsKey(walletKey, threadId));
  }
}

export function makeThreadId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function formatThreadTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
