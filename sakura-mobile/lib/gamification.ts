import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '@/lib/supabase';
import { buildWalletAuthHeaders } from '@/lib/wallet-auth';
import { getCachedSessionKeypair } from '@/lib/wallet/app-session';

/**
 * Client half of reading gamification. Records local reading events into an
 * offline-safe queue and flushes them to the `reading-progress-ingest` edge
 * function — but only signs when the wallet is ALREADY unlocked this session
 * (`getCachedSessionKeypair`), so passive reading never triggers a biometric
 * prompt. XP/streaks/quests/badges are awarded server-side; this file only
 * reports what was read.
 */

/** Client mirror of the server XP curve (supabase/functions/_shared/xp.ts). */
export function levelFloor(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return 50 * (l - 1) * l;
}
export function levelProgress(xp: number): { level: number; intoLevel: number; toNext: number } {
  const x = Math.max(0, Math.floor(xp));
  let level = 1;
  while (x >= levelFloor(level + 1)) level += 1;
  const floor = levelFloor(level);
  const next = levelFloor(level + 1);
  return { level, intoLevel: Math.max(0, x - floor), toNext: Math.max(1, next - floor) };
}

export type ReadKind = 'manga' | 'novel' | 'anime';

export interface ReadingEventInput {
  kind: ReadKind;
  contentId: string;
  chapterId: string;
  seriesId?: string;
  progress: number; // 0..1
  dwellMs: number;
  completed: boolean;
}

export interface GamificationQuest {
  code: string;
  title: string;
  description: string;
  target: number;
  xp_reward: number;
  progress: number;
  completed: boolean;
}

export interface GamificationBadge {
  code: string;
  title: string;
  description: string;
  icon: string | null;
  tier: string;
  unlocked: boolean;
  unlocked_at: string | null;
}

export interface GamificationState {
  xp: number;
  level: number;
  current_streak: number;
  longest_streak: number;
  chapters_total: number;
  quests: GamificationQuest[];
  badges: GamificationBadge[];
}

type QueuedEvent = {
  kind: ReadKind;
  content_id: string;
  chapter_id: string;
  series_id: string;
  progress: number;
  dwell_ms: number;
  completed: boolean;
  client_reported_at: string;
};

const QUEUE_FILE = `${FileSystem.documentDirectory ?? ''}gamification-queue.json`;
let memQueue: QueuedEvent[] = [];
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
/** Subscribe to "state may have changed" pings (fired after a successful flush). */
export function subscribeGamification(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function ping() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}

async function loadQueue(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await FileSystem.readAsStringAsync(QUEUE_FILE);
    memQueue = JSON.parse(raw) as QueuedEvent[];
  } catch {
    memQueue = [];
  }
  loaded = true;
}

async function saveQueue(): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(QUEUE_FILE, JSON.stringify(memQueue.slice(-500)));
  } catch {
    /* memory-only fallback (e.g. web) */
  }
}

export async function recordReadingEvent(ev: ReadingEventInput): Promise<void> {
  await loadQueue();
  memQueue.push({
    kind: ev.kind,
    content_id: ev.contentId,
    chapter_id: ev.chapterId,
    series_id: ev.seriesId || ev.contentId,
    progress: Math.max(0, Math.min(1, ev.progress)),
    dwell_ms: Math.max(0, Math.round(ev.dwellMs)),
    completed: ev.completed,
    client_reported_at: new Date().toISOString(),
  });
  await saveQueue();
  scheduleFlush();
}

function scheduleFlush(delayMs = 8000): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushReadingEvents();
  }, delayMs);
}

/** Flush queued events if the wallet is already unlocked. Returns fresh state or null. */
export async function flushReadingEvents(): Promise<GamificationState | null> {
  await loadQueue();
  if (memQueue.length === 0) return null;
  const kp = getCachedSessionKeypair();
  if (!kp) return null; // not unlocked this session; keep queued for later

  const batch = memQueue.slice(0, 100);
  try {
    const headers = buildWalletAuthHeaders(kp, 'reading-ingest');
    const { error } = await supabase.functions.invoke('reading-progress-ingest', {
      body: { events: batch },
      headers,
    });
    if (error) return null;
    memQueue = memQueue.slice(batch.length);
    await saveQueue();
    const state = await fetchGamificationState(kp.publicKey.toBase58());
    ping();
    return state;
  } catch {
    return null;
  }
}

export async function fetchGamificationState(wallet: string): Promise<GamificationState | null> {
  try {
    const { data, error } = await supabase.functions.invoke('read-gamification', {
      body: { wallet_address: wallet },
    });
    if (error || !data || (data as { error?: string }).error) return null;
    return data as GamificationState;
  } catch {
    return null;
  }
}
