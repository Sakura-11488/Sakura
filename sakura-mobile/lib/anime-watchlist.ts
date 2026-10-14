import { readStore, writeStore } from '@/lib/kv-store';

/**
 * Anime list statuses, the way MAL and AniList users organise what they watch:
 * Watching, Plan to watch, Completed, On hold, Dropped.
 *
 * The library bookmark only says "saved"; it cannot tell a show someone is
 * following week to week from one they gave up on, which is exactly what the
 * "New episodes for you" shelf needs to know. Statuses live in their own small
 * store (kv-store: a file on native, localStorage on web) so the library model
 * and its cloud sync stay untouched; setting a status from the UI also saves
 * the title to the library so it still appears there.
 */
export type WatchlistStatus = 'watching' | 'plan' | 'completed' | 'on-hold' | 'dropped';

export const WATCHLIST_STATUSES: ReadonlyArray<{ value: WatchlistStatus; label: string }> = [
  { value: 'watching', label: 'Watching' },
  { value: 'plan', label: 'Plan to watch' },
  { value: 'completed', label: 'Completed' },
  { value: 'on-hold', label: 'On hold' },
  { value: 'dropped', label: 'Dropped' },
];

export function watchlistStatusLabel(status: WatchlistStatus | null | undefined): string {
  return WATCHLIST_STATUSES.find((entry) => entry.value === status)?.label ?? 'Add to list';
}

export interface WatchlistEntry {
  animeId: string;
  title: string;
  cover: string;
  status: WatchlistStatus;
  updatedAt: number;
  /** Set by playback rather than chosen by the viewer. */
  auto?: boolean;
}

export type WatchlistTitle = { animeId: string; title: string; cover: string };

const FILE = 'sakura_anime_watchlist.json';
const LIMIT = 2000;
const VALID = new Set<string>(WATCHLIST_STATUSES.map((entry) => entry.value));
const mem = new Map<string, WatchlistEntry>();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let pendingWrite: Promise<unknown> = Promise.resolve();

/** Untrusted JSON (a hand-edited or older store) becomes valid entries only. */
export function normalizeWatchlist(value: unknown): WatchlistEntry[] {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  const entries = new Map<string, WatchlistEntry>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Partial<WatchlistEntry>;
    if (typeof item.animeId !== 'string' || !item.animeId || item.animeId.length > 128) continue;
    if (typeof item.status !== 'string' || !VALID.has(item.status)) continue;
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) && item.updatedAt >= 0 ? item.updatedAt : 0;
    const previous = entries.get(item.animeId);
    if (previous && previous.updatedAt > updatedAt) continue;
    entries.set(item.animeId, {
      animeId: item.animeId,
      title: typeof item.title === 'string' ? item.title.slice(0, 300) : '',
      cover: typeof item.cover === 'string' && /^(https:|\/)/.test(item.cover) ? item.cover.slice(0, 2048) : '',
      status: item.status as WatchlistStatus,
      updatedAt,
      ...(item.auto === true ? { auto: true } : {}),
    });
  }
  return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIMIT);
}

function ensureLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await readStore(FILE);
        for (const entry of normalizeWatchlist(raw ? JSON.parse(raw) : [])) mem.set(entry.animeId, entry);
      } catch {
        // A corrupt store starts empty rather than breaking the anime screens.
      }
    })();
  }
  return loading;
}

function persist(): Promise<unknown> {
  const snapshot = JSON.stringify([...mem.values()]);
  pendingWrite = pendingWrite.then(() => writeStore(FILE, snapshot)).catch(() => false);
  listeners.forEach((listener) => {
    try { listener(); } catch { /* one subscriber must not break another */ }
  });
  return pendingWrite;
}

export function subscribeWatchlist(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
  await ensureLoaded();
  return [...mem.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((entry) => ({ ...entry }));
}

export async function getWatchlistStatus(animeId: string): Promise<WatchlistStatus | null> {
  await ensureLoaded();
  return mem.get(animeId)?.status ?? null;
}

/** The viewer's own choice; `null` removes the title from the list. */
export async function setWatchlistStatus(title: WatchlistTitle, status: WatchlistStatus | null): Promise<void> {
  if (!title.animeId) return;
  await ensureLoaded();
  if (status === null) {
    if (!mem.delete(title.animeId)) return;
  } else {
    if (!VALID.has(status)) return;
    mem.set(title.animeId, { animeId: title.animeId, title: title.title, cover: title.cover, status, updatedAt: Date.now() });
  }
  await persist();
}

/**
 * The status playback implies, or null for "leave it alone".
 * - Pressing play on something listed as planned, on hold or dropped (or not
 *   listed) means the viewer is watching it now.
 * - Watching every episode of a finished series completes it.
 * - A rewatch never demotes Completed.
 */
export function nextAutoStatus(current: WatchlistStatus | null, event: 'started' | 'finished-series'): WatchlistStatus | null {
  if (event === 'finished-series') return current === 'completed' ? null : 'completed';
  return current === 'watching' || current === 'completed' ? null : 'watching';
}

export async function noteAnimePlayback(title: WatchlistTitle, event: 'started' | 'finished-series'): Promise<void> {
  if (!title.animeId) return;
  await ensureLoaded();
  const current = mem.get(title.animeId);
  const next = nextAutoStatus(current?.status ?? null, event);
  if (!next) return;
  mem.set(title.animeId, {
    animeId: title.animeId,
    title: title.title || current?.title || '',
    cover: title.cover || current?.cover || '',
    status: next,
    updatedAt: Date.now(),
    auto: true,
  });
  await persist();
}

/** Highest episode number marked watched (completed or ticked) in a watch-progress entry. */
export function highestWatchedEpisode(progress: {
  episodeNumber: number;
  completed?: boolean;
  progress: number;
  episodeHistory?: Record<string, { episodeNumber: number; watched: boolean }>;
}): number {
  let highest = 0;
  for (const row of Object.values(progress.episodeHistory ?? {})) {
    if (row?.watched && Number.isFinite(row.episodeNumber)) highest = Math.max(highest, row.episodeNumber);
  }
  if (!highest && (progress.completed === true || progress.progress >= 0.98)) highest = progress.episodeNumber;
  return highest;
}

export type NewEpisodeCandidate = { animeId: string; title: string; cover: string; highestWatched: number; lastPlayedAt: number };
export type NewEpisodeAiring = { id: string; status: string; nextEpisode: number | null; nextAiringAt: number | null; title?: string; image?: string };
export type NewEpisodeItem = {
  animeId: string;
  title: string;
  cover: string;
  /** The first episode the viewer has not seen. */
  nextEpisode: number;
  /** The newest episode that has aired. */
  latestAired: number;
  newCount: number;
};

/**
 * "New episodes for you": airing shows the viewer is keeping up with (at most
 * three aired episodes behind) that have an aired episode they have not seen.
 * A deep backlog — 5 of 1,100 One Piece episodes — is Continue Watching, not
 * news, so it is left out.
 */
export function findNewEpisodes(candidates: NewEpisodeCandidate[], airing: NewEpisodeAiring[], maxBehind = 3): NewEpisodeItem[] {
  const byId = new Map(airing.map((row) => [row.id, row]));
  const items: Array<NewEpisodeItem & { order: number; lastPlayedAt: number }> = [];
  for (const candidate of candidates) {
    const row = byId.get(candidate.animeId);
    if (!row || row.status !== 'RELEASING' || !row.nextEpisode || row.nextEpisode < 2) continue;
    const latestAired = row.nextEpisode - 1;
    const newCount = latestAired - candidate.highestWatched;
    if (candidate.highestWatched < 1 || newCount < 1 || newCount > maxBehind) continue;
    items.push({
      animeId: candidate.animeId,
      title: candidate.title || row.title || '',
      cover: candidate.cover || row.image || '',
      nextEpisode: candidate.highestWatched + 1,
      latestAired,
      newCount,
      // Weekly shows: the one whose next broadcast is furthest away aired most recently.
      order: row.nextAiringAt ?? 0,
      lastPlayedAt: candidate.lastPlayedAt,
    });
  }
  return items
    .sort((a, b) => b.order - a.order || b.lastPlayedAt - a.lastPlayedAt)
    .map(({ order: _order, lastPlayedAt: _lastPlayedAt, ...item }) => item);
}
