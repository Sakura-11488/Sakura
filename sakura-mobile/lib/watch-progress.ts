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
  /** Exact resume time in seconds when known (native player) */
  positionSeconds?: number;
  updatedAt: number;
}

type WatchProgressStore = {
  anime: Record<string, AnimeWatchProgress>;
};

const FILE = `${FileSystem.documentDirectory}sakura_watch_progress.json`;
const mem: WatchProgressStore = { anime: {} };
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeWatchProgress(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(FILE);
      const parsed = JSON.parse(raw) as WatchProgressStore;
      mem.anime = parsed?.anime || {};
    }
  } catch {
    mem.anime = {};
  } finally {
    loaded = true;
  }
}

async function persist() {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(mem));
    notify();
  } catch {
    // ignore
  }
}

export const RESUME_MIN = 0.03;

export async function getAnimeWatchProgress(animeId: string): Promise<AnimeWatchProgress | null> {
  if (!animeId) return null;
  await ensureLoaded();
  return mem.anime[animeId] || null;
}

const COMPLETE_THRESHOLD = 0.98;

export async function setAnimeWatchProgress(entry: AnimeWatchProgress): Promise<void> {
  if (!entry.animeId || !entry.episodeId) return;
  await ensureLoaded();
  mem.anime[entry.animeId] = {
    ...entry,
    progress: Math.min(1, Math.max(0, entry.progress || 0)),
    positionSeconds:
      typeof entry.positionSeconds === 'number' && entry.positionSeconds > 0
        ? entry.positionSeconds
        : undefined,
    updatedAt: Date.now(),
  };
  await persist();
}

/** Saves progress; when an episode is finished, queues the next episode from the start. */
export async function setAnimeWatchProgressWithAdvance(
  entry: AnimeWatchProgress,
  episodes: Array<{ id: string; number: number; title: string; thumbnail?: string }>,
): Promise<void> {
  const progress = Math.min(1, Math.max(0, entry.progress || 0));
  if (progress >= COMPLETE_THRESHOLD) {
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
      });
      return;
    }
    await setAnimeWatchProgress({ ...entry, progress: 1 });
    return;
  }
  await setAnimeWatchProgress({ ...entry, progress });
}

export async function getContinueWatching(limit = 12): Promise<AnimeWatchProgress[]> {
  await ensureLoaded();
  return Object.values(mem.anime)
    .filter((e) => e.progress < COMPLETE_THRESHOLD && (e.progress >= 0.01 || e.progress === 0))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
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
  mem.anime = {};
  await persist();
}

export async function getAllWatchHistory(): Promise<AnimeWatchProgress[]> {
  await ensureLoaded();
  return Object.values(mem.anime).filter(Boolean);
}

/** Merge a cloud snapshot of watch progress, newest-updatedAt wins. */
export async function importWatchProgress(entries: AnimeWatchProgress[]): Promise<void> {
  await ensureLoaded();
  for (const entry of entries) {
    if (!entry?.animeId) continue;
    const local = mem.anime[entry.animeId];
    if (!local || (entry.updatedAt || 0) > (local.updatedAt || 0)) {
      mem.anime[entry.animeId] = entry;
    }
  }
  await persist();
}
