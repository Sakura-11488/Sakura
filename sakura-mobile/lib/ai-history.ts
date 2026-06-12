import { Directory, File, Paths } from 'expo-file-system';

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

const BASE_DIR = new Directory(Paths.document, 'ai-chat');
const MAX_TURNS = 200;

function sanitize(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44);
}

function indexFile(walletKey: string): File {
  return new File(BASE_DIR, `threads_${sanitize(walletKey)}.json`);
}

function msgsFile(walletKey: string, threadId: string): File {
  return new File(BASE_DIR, `msgs_${sanitize(walletKey)}_${sanitize(threadId)}.json`);
}

function ensureDir() {
  if (!BASE_DIR.exists) BASE_DIR.create({ intermediates: true });
}

async function readJSON<T>(file: File, fallback: T): Promise<T> {
  try {
    if (!file.exists) return fallback;
    const raw = await file.text();
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(file: File, data: unknown) {
  ensureDir();
  file.write(JSON.stringify(data));
}

export async function loadHistory(walletKey: string, threadId: string): Promise<StoredMessage[]> {
  return readJSON<StoredMessage[]>(msgsFile(walletKey, threadId), []);
}

export async function saveMessage(
  walletKey: string,
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  isFirstInThread = false,
): Promise<void> {
  const mf = msgsFile(walletKey, threadId);
  let msgs = await readJSON<StoredMessage[]>(mf, []);
  msgs.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
  });
  if (msgs.length > MAX_TURNS) msgs = msgs.slice(-MAX_TURNS);
  writeJSON(mf, msgs);

  const idx_f = indexFile(walletKey);
  let threads = await readJSON<ChatThread[]>(idx_f, []);
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
  writeJSON(idx_f, threads);
}

export async function listThreads(walletKey: string): Promise<ChatThread[]> {
  const threads = await readJSON<ChatThread[]>(indexFile(walletKey), []);
  return threads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function deleteThread(walletKey: string, threadId: string): Promise<void> {
  const idx_f = indexFile(walletKey);
  let threads = await readJSON<ChatThread[]>(idx_f, []);
  threads = threads.filter((t) => t.id !== threadId);
  writeJSON(idx_f, threads);
  const mf = msgsFile(walletKey, threadId);
  if (mf.exists) mf.delete();
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
