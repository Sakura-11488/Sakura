import * as FileSystem from 'expo-file-system/legacy';

export interface AnimePlaybackPosition {
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

export interface AnimeEpisodeHistory extends AnimePlaybackPosition {
  watched: boolean;
  watchedUpdatedAt: number;
  /** Timestamp of the captured player event, used to reject delayed older saves. */
  observedAt?: number;
  /** Explicit status changes win over player events captured before the action. */
  manualStatusAt?: number;
}

export interface AnimeWatchProgress extends AnimePlaybackPosition {
  animeId: string;
  title: string;
  cover: string;
  episodeHistory?: Record<string, AnimeEpisodeHistory>;
  bookmarkUpdatedAt?: number;
  bookmarkObservedAt?: number;
  /** Last known episode catalog; completion is only for these known episodes. */
  knownEpisodes?: Array<{ id: string; number: number }>;
  catalogUpdatedAt?: number;
  lastPlayedAt?: number;
  continueDismissedAt?: number;
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

function normalizePosition(value: unknown): AnimePlaybackPosition | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<AnimePlaybackPosition>;
  if (!validId(entry.episodeId)) return null;
  const duration = finite(entry.durationSeconds) && entry.durationSeconds > 0 ? entry.durationSeconds : undefined;
  const position = finite(entry.positionSeconds) && entry.positionSeconds >= 0
    ? Math.min(entry.positionSeconds, duration ?? Infinity) : undefined;
  return {
    episodeId: entry.episodeId,
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

const timestamp = (value: unknown) => finite(value) && value >= 0 ? value : 0;
const catalogId = /^(?:mal|hi)-\d+-\d+$/;
function normalizeCatalog(value: unknown): Array<{ id: string; number: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter(row => row && validId(row.id) && finite(row.number) && row.number > 0);
  return Array.from(new Map(rows.map(row => [row.id, { id: row.id, number: row.number }])).values());
}
function historyEntry(value: unknown): AnimeEpisodeHistory | null {
  const position = normalizePosition(value);
  if (!position) return null;
  const extra = value as Partial<AnimeEpisodeHistory>;
  return { ...position, watched: typeof extra.watched === 'boolean' ? extra.watched : isWatchProgressComplete(position),
    watchedUpdatedAt: timestamp(extra.watchedUpdatedAt) || position.updatedAt,
    observedAt: timestamp(extra.observedAt) || position.updatedAt,
    manualStatusAt: timestamp(extra.manualStatusAt) || undefined };
}
function normalizeEntry(value: unknown): AnimeWatchProgress | null {
  const position = normalizePosition(value);
  if (!position) return null;
  const entry = value as Partial<AnimeWatchProgress>;
  if (!validId(entry.animeId)) return null;
  const history: Record<string, AnimeEpisodeHistory> = Object.create(null);
  if (entry.episodeHistory && typeof entry.episodeHistory === 'object' && !Array.isArray(entry.episodeHistory)) {
    for (const value of Object.values(entry.episodeHistory)) {
      const episode = historyEntry(value);
      if (episode) history[episode.episodeId] = episode;
    }
  }
  // Existing local/cloud snapshots migrate lazily without losing their bookmark.
  history[position.episodeId] ??= historyEntry({ ...position, observedAt: entry.bookmarkObservedAt })!;
  return { ...position, animeId: entry.animeId, title: typeof entry.title === 'string' ? entry.title : '',
    cover: typeof entry.cover === 'string' ? entry.cover : '', episodeHistory: mergeHistory(history),
    bookmarkUpdatedAt: timestamp(entry.bookmarkUpdatedAt) || position.updatedAt,
    bookmarkObservedAt: timestamp(entry.bookmarkObservedAt) || position.updatedAt,
    knownEpisodes: normalizeCatalog(entry.knownEpisodes), catalogUpdatedAt: timestamp(entry.catalogUpdatedAt) || undefined,
    lastPlayedAt: finite(entry.lastPlayedAt) && entry.lastPlayedAt >= 0 ? entry.lastPlayedAt : position.updatedAt,
    continueDismissedAt: timestamp(entry.continueDismissedAt) || undefined };
}
function copy(entry: AnimeWatchProgress): AnimeWatchProgress {
  return { ...entry, knownEpisodes: entry.knownEpisodes?.map(row => ({ ...row })), episodeHistory: Object.fromEntries(Object.entries(entry.episodeHistory ?? {}).map(([id, row]) => [id, { ...row }])) };
}
function mergeEpisode(local: AnimeEpisodeHistory, incoming: AnimeEpisodeHistory): AnimeEpisodeHistory {
  // An offline device may flush a player event after a manual status action.
  // Capture time, rather than eventual write time, decides whether that event applies.
  const localAction = local.manualStatusAt ?? 0;
  const incomingAction = incoming.manualStatusAt ?? 0;
  if ((incoming.observedAt ?? incoming.updatedAt) < localAction && incomingAction < localAction) return { ...local };
  if ((local.observedAt ?? local.updatedAt) < incomingAction && localAction < incomingAction) return { ...incoming };
  const clock = incoming.updatedAt > local.updatedAt ? incoming : local;
  const status = incoming.watchedUpdatedAt > local.watchedUpdatedAt ? incoming : local;
  return { ...clock, watched: status.watched, watchedUpdatedAt: status.watchedUpdatedAt,
    manualStatusAt: Math.max(local.manualStatusAt ?? 0, incoming.manualStatusAt ?? 0) || undefined };
}
function mergeHistory(a: Record<string, AnimeEpisodeHistory> = {}, b: Record<string, AnimeEpisodeHistory> = {}): Record<string, AnimeEpisodeHistory> {
  const merged = new Map<string, AnimeEpisodeHistory>();
  for (const incoming of [...Object.values(a), ...Object.values(b)]) {
    const key = catalogId.test(incoming.episodeId) ? `catalog:${incoming.episodeNumber}` : incoming.episodeId;
    const local = merged.get(key);
    merged.set(key, { ...(local ? mergeEpisode(local, incoming) : incoming), episodeId: incoming.episodeId });
  }
  return Object.assign(Object.create(null), Object.fromEntries(Array.from(merged.values(), row => [row.episodeId, row])));
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

export function isWatchProgressComplete(entry: AnimePlaybackPosition): boolean {
  return typeof entry.completed === 'boolean' ? entry.completed : entry.progress >= COMPLETE_THRESHOLD;
}

/** Exact early playback is resumable; legacy estimates keep their existing threshold. */
export function canResumeWatchProgress(entry: AnimePlaybackPosition | null | undefined): boolean {
  if (!entry || isWatchProgressComplete(entry)) return false;
  if (finite(entry.positionSeconds) && entry.positionSeconds >= 0) return entry.positionSeconds > 0;
  return finite(entry.progress) && entry.progress >= RESUME_MIN && entry.progress < 1;
}

/** Returns zero for a restart/finished entry. Pass a newly measured duration when available. */
export function resumePosition(entry: AnimePlaybackPosition | null | undefined, durationSeconds?: number): number {
  if (!entry || !canResumeWatchProgress(entry)) return 0;
  const duration = finite(durationSeconds) && durationSeconds > 0 ? durationSeconds
    : finite(entry.durationSeconds) && entry.durationSeconds > 0 ? entry.durationSeconds : undefined;
  if (finite(entry.positionSeconds) && entry.positionSeconds > 0) {
    return Math.min(entry.positionSeconds, duration ?? Infinity);
  }
  return duration ? Math.min(duration, Math.max(0, entry.progress * duration)) : 0;
}

export function getEpisodeWatchProgress(entry: AnimeWatchProgress | null | undefined, episodeId: string, episodeNumber?: number): AnimeEpisodeHistory | null {
  if (!entry) return null;
  const candidates = Object.values(entry.episodeHistory ?? {}).filter(row => row.episodeId === episodeId ||
    (episodeNumber && catalogId.test(episodeId) && catalogId.test(row.episodeId) && row.episodeNumber === episodeNumber));
  if (candidates.length) return { ...candidates.reduce(mergeEpisode), episodeId };
  return entry.episodeId === episodeId ? historyEntry({ ...entry, observedAt: entry.bookmarkObservedAt }) : null;
}

export function isEpisodeWatched(entry: AnimeWatchProgress | null | undefined, episodeId: string, episodeNumber?: number): boolean {
  return getEpisodeWatchProgress(entry, episodeId, episodeNumber)?.watched === true;
}

/** A zero bookmark or an explicit unwatched action is not evidence of viewing. */
export function hasAnimeViewingHistory(entry: AnimeWatchProgress | null | undefined): boolean {
  if (!entry) return false;
  const rows = Object.values(mergeHistory(entry.episodeHistory));
  if (!rows.length) rows.push(historyEntry(entry)!);
  return rows.some(row => row.watched || (row.positionSeconds ?? 0) > 0 || row.progress > 0);
}

export function getAnimeViewingStatus(entry: AnimeWatchProgress | null | undefined,
  episodes?: Array<{ id: string; number: number }>): 'not-started' | 'started' | 'completed' {
  if (!entry || !hasAnimeViewingHistory(entry)) return 'not-started';
  const catalog = episodes ?? entry.knownEpisodes;
  return catalog?.length && catalog.every(episode => isEpisodeWatched(entry, episode.id, episode.number)) ? 'completed' : 'started';
}

/** Metadata refresh does not create history or move the latest playback bookmark. */
export async function registerAnimeEpisodeCatalog(animeId: string, episodes: Array<{ id: string; number: number }>): Promise<void> {
  if (!loaded) await ensureLoaded();
  const local = mem.anime[animeId];
  const catalog = normalizeCatalog(episodes);
  if (!local || !catalog?.length || JSON.stringify(catalog) === JSON.stringify(local.knownEpisodes)) return;
  const now = Math.max(Date.now(), local.updatedAt + 1);
  mem.anime[animeId] = { ...local, knownEpisodes: catalog, catalogUpdatedAt: now, updatedAt: now };
  await persist();
}

export async function getAnimeWatchProgress(animeId: string, episodeId?: string, episodeNumber?: number): Promise<AnimeWatchProgress | null> {
  if (!animeId) return null;
  await ensureLoaded();
  const entry = mem.anime[animeId];
  if (!entry) return null;
  const result = copy(entry);
  if (episodeId) {
    const episode = getEpisodeWatchProgress(entry, episodeId, episodeNumber);
    if (episode) return { ...result, ...episode };
  }
  return result;
}

function savePosition(entry: AnimeWatchProgress, advance?: Array<{ id: string; number: number; title: string; thumbnail?: string }>) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return false;
  const local = mem.anime[entry.animeId];
  const previous = getEpisodeWatchProgress(local, entry.episodeId, entry.episodeNumber);
  const observedAt = timestamp(entry.updatedAt) || Date.now();
  if (previous && observedAt < Math.max(previous.observedAt ?? 0, previous.manualStatusAt ?? 0)) return false;
  const now = Math.max(Date.now(), (local?.updatedAt ?? 0) + 1);
  const complete = isWatchProgressComplete(normalized);
  const placeholder = normalized.progress === 0 && normalized.positionSeconds === undefined && !complete;
  // A queued next-episode bookmark is not playback. Its synthetic zero row must
  // not compete with that episode's existing measured clock or watched status.
  const incomingHistory = Object.fromEntries(Object.entries(normalized.episodeHistory ?? {}).filter(([, row]) =>
    !previous || !(row.episodeId === entry.episodeId || (catalogId.test(row.episodeId) && catalogId.test(entry.episodeId) && row.episodeNumber === entry.episodeNumber))));
  const history = mergeHistory(local?.episodeHistory, incomingHistory);
  // Keep one status for catalog aliases (MAL and HiAnime can identify the same episode).
  if (catalogId.test(entry.episodeId)) for (const row of Object.values(history)) {
    if (row.episodeId !== entry.episodeId && catalogId.test(row.episodeId) && row.episodeNumber === entry.episodeNumber) delete history[row.episodeId];
  }
  if (placeholder && previous) history[entry.episodeId] = { ...previous, episodeId: entry.episodeId };
  else history[entry.episodeId] = {
    ...normalizePosition(normalized)!, updatedAt: now, observedAt,
    watched: complete || previous?.watched === true,
    watchedUpdatedAt: complete ? now : previous?.watchedUpdatedAt ?? now,
    manualStatusAt: previous?.manualStatusAt,
  };
  let bookmark = normalized;
  if (complete && advance) {
    const index = advance.findIndex(episode => episode.id === entry.episodeId);
    const next = index >= 0 ? advance[index + 1] : undefined;
    if (next) bookmark = { ...normalized, episodeId: next.id, episodeNumber: next.number, episodeTitle: next.title,
      episodeThumbnail: next.thumbnail, progress: 0, positionSeconds: undefined, durationSeconds: undefined, completed: false };
    else bookmark = { ...normalized, progress: 1, completed: true };
  }
  const latest = !local || observedAt >= (local.bookmarkObservedAt ?? 0);
  const catalog = normalizeCatalog(advance);
  mem.anime[entry.animeId] = { ...(latest ? bookmark : local), episodeHistory: history, updatedAt: now,
    bookmarkUpdatedAt: latest ? now : local?.bookmarkUpdatedAt,
    bookmarkObservedAt: latest ? observedAt : local?.bookmarkObservedAt,
    knownEpisodes: catalog?.length ? catalog : local?.knownEpisodes,
    catalogUpdatedAt: catalog?.length ? now : local?.catalogUpdatedAt,
    lastPlayedAt: observedAt > (local?.continueDismissedAt ?? -1) ? now : local?.lastPlayedAt,
    continueDismissedAt: local?.continueDismissedAt };
  return true;
}

export async function setAnimeWatchProgress(entry: AnimeWatchProgress): Promise<void> {
  if (!loaded) await ensureLoaded();
  if (savePosition(entry)) await persist();
}

/** Saves progress; when an episode is finished, queues the next episode from the start. */
export async function setAnimeWatchProgressWithAdvance(
  entry: AnimeWatchProgress,
  episodes: Array<{ id: string; number: number; title: string; thumbnail?: string }>,
): Promise<void> {
  if (!loaded) await ensureLoaded();
  if (savePosition(entry, episodes)) await persist();
}

/** Hide only this row. A new playback checkpoint makes it visible again. */
export async function removeFromContinueWatching(animeId: string): Promise<void> {
  if (!loaded) await ensureLoaded();
  const entry = mem.anime[animeId];
  if (!entry) return;
  const now = Math.max(Date.now(), entry.updatedAt + 1);
  mem.anime[animeId] = { ...entry, continueDismissedAt: now, updatedAt: now };
  await persist();
}

/** Marking watched preserves a measured clock; unwatched explicitly resets that episode. */
export async function setAnimeEpisodeWatched(entry: AnimeWatchProgress, watched: boolean, episodes?: Array<{ id: string; number: number }>): Promise<void> {
  const normalized = normalizeEntry(entry);
  if (!normalized) return;
  if (!loaded) await ensureLoaded();
  const local = mem.anime[entry.animeId];
  const previous = getEpisodeWatchProgress(local, entry.episodeId, entry.episodeNumber);
  // Strictly after the caller's own timestamp too. With no history yet, the
  // base is built from `entry` itself, which carries an unwatched row stamped
  // `entry.updatedAt`; the screens stamp it Date.now() and call straight in,
  // so both landed in the same millisecond and the merge kept the unwatched
  // row on the tie: the first "Mark watched" on a title said "Episode marked
  // watched" and stored nothing.
  const now = Math.max(Date.now(), (local?.updatedAt ?? 0) + 1, normalized.updatedAt + 1);
  const row: AnimeEpisodeHistory = { ...normalizePosition(previous ?? normalized)!, episodeId: entry.episodeId,
    progress: watched ? 1 : 0, positionSeconds: watched ? previous?.positionSeconds : 0,
    durationSeconds: previous?.durationSeconds, completed: watched, watched, watchedUpdatedAt: now,
    manualStatusAt: now, observedAt: now, updatedAt: now };
  const base = local ?? normalized;
  const sameEpisode = base.episodeId === entry.episodeId || (catalogId.test(base.episodeId) && catalogId.test(entry.episodeId) && base.episodeNumber === entry.episodeNumber);
  const current = sameEpisode ? { ...base, ...normalizePosition(row)!, bookmarkUpdatedAt: now, bookmarkObservedAt: now } : base;
  const catalog = normalizeCatalog(episodes);
  mem.anime[entry.animeId] = { ...current, knownEpisodes: catalog?.length ? catalog : base.knownEpisodes,
    catalogUpdatedAt: catalog?.length ? now : base.catalogUpdatedAt, episodeHistory: mergeHistory(base.episodeHistory, { [entry.episodeId]: row }),
    updatedAt: now, lastPlayedAt: local?.lastPlayedAt ?? 0, continueDismissedAt: local?.continueDismissedAt };
  await persist();
}

export async function getContinueWatching(limit = 12): Promise<AnimeWatchProgress[]> {
  await ensureLoaded();
  return Object.values(mem.anime)
    .filter((e) => (e.lastPlayedAt ?? e.updatedAt) > 0 && (e.lastPlayedAt ?? e.updatedAt) > (e.continueDismissedAt ?? -1) && !isWatchProgressComplete(e) && (canResumeWatchProgress(e) || e.progress >= 0.01 || e.progress === 0))
    .sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt))
    .slice(0, limit)
    .map(copy);
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
  return Object.values(mem.anime).map(copy);
}

/** Merge bookmarks, per-episode clocks/status, and dismissal tombstones independently. */
export async function importWatchProgress(entries: AnimeWatchProgress[]): Promise<void> {
  await ensureLoaded();
  for (const value of entries) {
    const entry = normalizeEntry(value);
    if (!entry) continue;
    const local = mem.anime[entry.animeId];
    if (!local) { mem.anime[entry.animeId] = entry; continue; }
    const latest = (entry.bookmarkUpdatedAt ?? 0) > (local.bookmarkUpdatedAt ?? 0) ? entry : local;
    const catalog = (entry.catalogUpdatedAt ?? 0) > (local.catalogUpdatedAt ?? 0) ? entry : local;
    mem.anime[entry.animeId] = { ...latest, knownEpisodes: catalog.knownEpisodes, catalogUpdatedAt: catalog.catalogUpdatedAt, episodeHistory: mergeHistory(local.episodeHistory, entry.episodeHistory),
      updatedAt: Math.max(local.updatedAt, entry.updatedAt), lastPlayedAt: Math.max(local.lastPlayedAt ?? 0, entry.lastPlayedAt ?? 0),
      continueDismissedAt: Math.max(local.continueDismissedAt ?? 0, entry.continueDismissedAt ?? 0) || undefined };
  }
  await persist();
}
