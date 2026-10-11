import * as FileSystem from 'expo-file-system/legacy';

export interface AnimeWatchProgress {
  animeId: string;
  title: string;
  cover: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  episodeThumbnail?: string;
  /** Playback position within the episode (0–1) */
  progress: number;
  /** Exact playback position when the player exposes its clock, including zero on restart. */
  positionSeconds?: number;
  /** Measured media duration, never an estimated episode length. */
  durationSeconds?: number;
  /** New players report actual completion; older entries retain the 98% rule. */
  completed?: boolean;
  updatedAt: number;
}

type WatchProgressStore = {
  anime: Record<string, AnimeWatchProgress>;
};

const FILE = `${FileSystem.documentDirectory}sakura_watch_progress.json`;
const mem: WatchProgressStore = { anime: Object.create(null) };
let loaded = false;
let loading: Promise<void> | null = null;
let pendingWrite: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* A subscriber must not interrupt saving. */ }
  });
}

export function subscribeWatchProgress(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 512;

function normalizeEntry(value: unknown): AnimeWatchProgress | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<AnimeWatchProgress>;
  if (!validId(entry.animeId) || !validId(entry.episodeId)) return null;
  const duration = finite(entry.durationSeconds) && entry.durationSeconds > 0 ? entry.durationSeconds : undefined;
  const position = finite(entry.positionSeconds) && entry.positionSeconds >= 0
    ? Math.min(entry.positionSeconds, duration ?? Infinity) : undefined;
  return {
    animeId: entry.animeId,
    episodeId: entry.episodeId,
    title: typeof entry.title === 'string' ? entry.title : '',
    cover: typeof entry.cover === 'string' ? entry.cover : '',
    episodeTitle: typeof entry.episodeTitle === 'string' ? entry.episodeTitle : '',
    episodeNumber: finite(entry.episodeNumber) && entry.episodeNumber > 0 ? entry.episodeNumber : 1,
    episodeThumbnail: typeof entry.episodeThumbnail === 'string' ? entry.episodeThumbnail : undefined,
    progress: finite(entry.progress) ? Math.min(1, Math.max(0, entry.progress)) : 0,
    positionSeconds: position,
    durationSeconds: duration,
    completed: typeof entry.completed === 'boolean' ? entry.completed : undefined,
    updatedAt: finite(entry.updatedAt) && entry.updatedAt >= 0 ? entry.updatedAt : 0,
  };
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) loading = (async () => {
    try {
      const info = await FileSystem.getInfoAsync(FILE);
      if (info.exists) {
        const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(FILE));
        const entries = (parsed as Partial<WatchProgressStore> | null)?.anime;
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          for (const value of Object.values(entries)) {
            const entry = normalizeEntry(value);
            if (entry) mem.anime[entry.animeId] = entry;
          }
        }
      }
    } catch { /* A missing or corrupt snapshot starts an empty history. */ }
    finally { loaded = true; }
  })();
  return loading;
}

function persist(): Promise<void> {
  // Snapshot each mutation, and never let a slow older write finish after a newer one.
  const snapshot = JSON.stringify(mem);
  const write = async () => {
    try { await FileSystem.writeAsStringAsync(FILE, snapshot); }
    catch { /* Keep the in-memory bookmark usable when storage is unavailable. */ }
    notify();
  };
  // On a loaded, idle store this invokes the web shim's synchronous localStorage
  // write immediately, before the first await (including a pagehide checkpoint).
  const current = pendingWrite ? pendingWrite.then(write) : write();
  pendingWrite = current;
  void current.then(() => { if (pendingWrite === current) pendingWrite = null; });
  return current;
}

export const RESUME_MIN = 0.03;
const COMPLETE_THRESHOLD = 0.98;

export function isWatchProgressComplete(entry: AnimeWatchProgress): boolean {
  return typeof entry.completed === 'boolean' ? entry.completed : entry.progress >= COMPLETE_THRESHOLD;
}

/** Exact early playback is resumable; legacy estimates keep their existing threshold. */
export function canResumeWatchProgress(entry: AnimeWatchProgress | null | undefined): boolean {
  if (!entry || isWatchProgressComplete(entry)) return false;
  if (finite(entry.positionSeconds) && entry.positionSeconds >= 0) return entry.positionSeconds > 0;
  return finite(entry.progress) && entry.progress >= RESUME_MIN && entry.progress < 1;
}

/** Returns zero for a restart/finished entry. Pass a newly measured duration when available. */
export function resumePosition(entry: AnimeWatchProgress | null | undefined, durationSeconds?: number): number {
  if (!entry || !canResumeWatchProgress(entry)) return 0;
  const duration = finite(durationSeconds) && durationSeconds > 0 ? durationSeconds
    : finite(entry.durationSeconds) && entry.durationSeconds > 0 ? entry.durationSeconds : undefined;
  if (finite(entry.positionSeconds) && entry.positionSeconds > 0) {
    return Math.min(entry.positionSeconds, duration ?? Infinity);
  }
  return duration ? Math.min(duration, Math.max(0, entry.progress * duration)) : 0;
}

export async function getAnimeWatchProgress(animeId: string): Promise<AnimeWatchProgress | null> {
  if (!animeId) return null;
  await ensureLoaded();
  const entry = mem.anime[animeId];
  return entry ? { ...entry } : null;
}

export async function setAnimeWatchProgress(entry: AnimeWatchProgress): Promise<void> {
  const normalized = normalizeEntry(entry);
  if (!normalized) return;
  if (!loaded) await ensureLoaded();
  mem.anime[normalized.animeId] = { ...normalized, updatedAt: Date.now() };
  await persist();
}

/** Saves progress; when an episode is finished, queues the next episode from the start. */
export async function setAnimeWatchProgressWithAdvance(
  entry: AnimeWatchProgress,
  episodes: Array<{ id: string; number: number; title: string; thumbnail?: string }>,
): Promise<void> {
  const normalized = normalizeEntry(entry);
  if (!normalized) return;
  const progress = normalized.progress;
  if (isWatchProgressComplete(normalized)) {
    const idx = episodes.findIndex((e) => e.id === entry.episodeId);
    const next = idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null;
    if (next) {
      await setAnimeWatchProgress({
        ...entry,
        episodeId: next.id,
        episodeNumber: next.number,
        episodeTitle: next.title,
        episodeThumbnail: next.thumbnail,
        progress: 0,
        positionSeconds: undefined,
        durationSeconds: undefined,
        completed: false,
      });
      return;
    }
    await setAnimeWatchProgress({ ...entry, progress: 1, completed: true });
    return;
  }
  await setAnimeWatchProgress({ ...entry, progress });
}

export async function getContinueWatching(limit = 12): Promise<AnimeWatchProgress[]> {
  await ensureLoaded();
  return Object.values(mem.anime)
    .filter((e) => !isWatchProgressComplete(e) && (canResumeWatchProgress(e) || e.progress >= 0.01 || e.progress === 0))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((entry) => ({ ...entry }));
}

/** Default episode length for progress estimate when the embed player is opaque (minutes). */
export const ESTIMATED_EPISODE_MINUTES = 24;

export function estimateProgressFromWatchTime(
  elapsedMs: number,
  videoProgress = 0,
  episodeMinutes = ESTIMATED_EPISODE_MINUTES,
): number {
  const elapsedRatio = elapsedMs / 1000 / (episodeMinutes * 60);
  // Embed players often hide <video>; guarantee a bookmark after ~8s of watch time.
  const floor = elapsedMs >= 8_000 ? RESUME_MIN : elapsedMs >= 4_000 ? 0.015 : 0;
  return Math.min(0.95, Math.max(videoProgress, elapsedRatio, floor));
}

export async function clearAnimeWatchProgress(animeId: string): Promise<void> {
  if (!animeId) return;
  await ensureLoaded();
  delete mem.anime[animeId];
  await persist();
}

export async function clearAllWatchProgress(): Promise<void> {
  await ensureLoaded();
  mem.anime = Object.create(null);
  await persist();
}

export async function getAllWatchHistory(): Promise<AnimeWatchProgress[]> {
  await ensureLoaded();
  return Object.values(mem.anime).map((entry) => ({ ...entry }));
}

/** Merge a cloud snapshot of watch progress, newest-updatedAt wins. */
export async function importWatchProgress(entries: AnimeWatchProgress[]): Promise<void> {
  await ensureLoaded();
  for (const value of entries) {
    const entry = normalizeEntry(value);
    if (!entry) continue;
    const local = mem.anime[entry.animeId];
    if (!local || (entry.updatedAt || 0) > (local.updatedAt || 0)) {
      mem.anime[entry.animeId] = entry;
    }
  }
  await persist();
}
