import type { StreamingSource } from '@/lib/anime';
import { fetchBrowserAnimeStream } from '@/lib/anime-stream-client';
import {
  checkMediaBytes,
  chooseVariant,
  estimateRenditionBytes,
  hasSeparateAudio,
  isMasterPlaylist,
  mediaPlaylistFingerprint,
  parseMasterVariants,
  planLocalPlaylist,
  summarizeMediaPlaylist,
  variantLabel,
  type HlsVariant,
  type LocalPlaylistPlan,
  type LocalResource,
} from '@/lib/hls-local-playlist';
import {
  ANIME_MANIFEST_URL,
  offlineCoverUrl,
  offlineEpisodeFileUrl,
  offlineEpisodeUrl,
  openOfflineLibrary,
} from '@/lib/offline-cache-keys';

/**
 * Offline anime library on web.
 *
 * The `.web.ts` counterpart of lib/anime-offline.ts, exporting the same surface
 * so app/downloads.tsx, app/anime/[id].tsx and app/anime/watch.tsx work
 * unchanged.
 *
 * IMPORTANT: never import '@/lib/anime-offline' from here — on web that
 * specifier resolves to THIS file.
 *
 * Two kinds of copy, chosen by the series id:
 *
 * - Sakura Originals are progressive MP4/MOV files served same-origin through
 *   /api/media-proxy/ with Access-Control-Allow-Origin and Range support. One
 *   episode is one Cache Storage entry at offlineEpisodeUrl, and
 *   web/public/sw.js serves byte ranges out of it so the player can seek.
 *
 * - Everything else is HLS through the signed `anime-stream` relay
 *   (supabase/functions/anime-stream). This used to be refused outright with
 *   "This series streams from a source that blocks browser downloads": the
 *   provider's CDN gates on a `Referer` header, which is a forbidden request
 *   header in fetch, so a browser could not obtain the bytes. That stopped
 *   being true when web playback moved to the relay — it adds the provider
 *   headers server-side and answers with Access-Control-Allow-Origin: *, so
 *   the same playlist, segments, keys and captions the web player streams can
 *   be fetched and kept. Each one is its own entry under
 *   offlineEpisodeFileUrl, with a rewritten `index.m3u8` that names those
 *   same-origin URLs. The `.m3u8` name sends WebVideoPlayer.web.tsx to hls.js,
 *   whose requests go through the service worker like any other.
 *
 * One entry per segment, rather than one assembled file, is what lets an HLS
 * download resume after a reload: whatever is already in the cache is skipped.
 * It also keeps a 400MB episode off the JS heap.
 */

export type OfflineEpisodeStatus = 'downloading' | 'paused' | 'ready' | 'error';

export interface OfflineEpisode {
  animeId: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  title: string;
  cover: string;
  episodeThumbnail?: string;
  category: 'sub' | 'dub';
  status: OfflineEpisodeStatus;
  progress: number;
  bytesDownloaded: number;
  totalSegments: number;
  completedSegments: number;
  /** The URL the player opens: the progressive file, or the HLS copy's index.m3u8. */
  localPlaylistUri?: string;
  error?: string;
  updatedAt: number;
  /** 'mp4' = one progressive file (Sakura Originals); 'hls' = playlist + segments. Absent on rows written before HLS: those are mp4. */
  format?: 'mp4' | 'hls';
  /** Names stored for this episode (offlineEpisodeFileUrl), for delete and size. */
  files?: string[];
  /** Caption tracks stored with the episode; `uri` is a same-origin URL. */
  subtitles?: Array<{ lang: string; label: string; uri: string }>;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  /** The rendition kept, e.g. '720p'. */
  quality?: string;
  /** Shape of the media playlist, to recognise it again on resume (hls-local-playlist.ts). */
  fingerprint?: string;
  /** Same-origin copies of the artwork, for pages rendered with no network. */
  offlineCover?: string;
  offlineThumbnail?: string;
}

const MANIFEST_URL = ANIME_MANIFEST_URL;

/**
 * 8 MiB chunks.
 *
 * Not one big GET: measured throughput through the proxy is ~5 MB/s, and
 * vercel.json declares no functions.maxDuration, so the function runs at the
 * plan default (10s Hobby / 15s Pro). A single request for a 600MB episode
 * would be killed mid-stream and leave a truncated file that looks complete.
 * Chunking also gives real progress and a cancel point.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** Below this, one plain GET — which is also the only shape Vercel's CDN caches. */
const SINGLE_GET_MAX = 10 * 1024 * 1024;
/** Leave the origin room to breathe; this shares a 1GB droplet with everything else. */
const CHUNK_CONCURRENCY = 2;

/** Room left for everything else on the origin, so a download never fills the quota to the byte. */
const STORAGE_HEADROOM = 200 * 1024 * 1024;

/**
 * Relay requests in flight across ALL episode downloads at once.
 *
 * The relay is shared with everyone streaming: it answers 503 once 24 requests
 * are active in an isolate and 429 past 600 media requests a minute per IP
 * (handler.ts rateLimit). Three keeps one episode near the measured ~2 minutes
 * (segments are ~1MB at ~1s each) without one viewer's queue of ten episodes
 * crowding out playback for the next.
 */
const RELAY_CONCURRENCY = 3;
/** Attempts per resource for network errors, timeouts and transient 5xx. */
const MAX_ATTEMPTS = 4;
/** 429/503 waits per resource; each honours Retry-After. */
const MAX_WAITS = 8;
const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 120_000;
/**
 * Fresh signed URLs per job. A capability lives two hours (handler.ts
 * TTL_SECONDS), so a download only needs this after a long pause or a very
 * slow link; the cap stops a relay that rejects every token from looping.
 */
const MAX_RESOLVES = 6;
/** The relay's own upstream deadline is 35s; give the body time to arrive after it. */
const FETCH_TIMEOUT_MS = 60_000;
const ARTWORK_TIMEOUT_MS = 15_000;
/** Each track is ~20-100KB; some episodes list 30. English first, then the rest up to this. */
const MAX_CAPTIONS = 12;
/** Progress is notified per segment; the manifest itself is rewritten at most this often. */
const PERSIST_INTERVAL_MS = 1_000;

const PLAYLIST_NAME = 'index.m3u8';
const THUMB_NAME = 'thumb';
/** Source segment for offlineCoverUrl; manga uses 'atsu' and the scraped sources. */
const COVER_SOURCE = 'anime';

const SOURCE_UNAVAILABLE = "This episode's source is temporarily unavailable for download. Try again later.";

type Manifest = { episodes: Record<string, OfflineEpisode> };

const mem: Manifest = { episodes: {} };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
/**
 * The running job per episode, so a second tap (or the Downloads screen's
 * Resume) joins it instead of racing it with a second set of workers.
 */
const activeJobs = new Map<string, Promise<void>>();
/** HLS jobs only: aborting it stops in-flight requests on pause and delete. */
const jobAborts = new Map<string, AbortController>();
const pausedEpisodeJobs = new Set<string>();
const canceledEpisodeJobs = new Set<string>();

/**
 * Completed chunks of a paused Sakura Original, so Resume does not start from
 * zero.
 *
 * Deliberately in memory only. Persisting partial chunks would mean one cache
 * entry per chunk plus stitching logic in the service worker; that is a real
 * optimisation but not a v1 requirement. A reload therefore loses the progress
 * of a paused Original and it restarts. (HLS copies do not have this problem:
 * every segment is already its own entry.)
 */
const partialChunks = new Map<string, { identity: string; parts: Blob[] }>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeOfflineEpisodes(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function episodeKey(animeId: string, episodeId: string) {
  return `${animeId}::${episodeId}`;
}

const openLibrary = openOfflineLibrary;

/**
 * Load the manifest once, shared by every caller.
 *
 * This used to set a `loaded` flag BEFORE awaiting the cache, so a second
 * caller arriving mid-load saw an empty library: the detail page could render
 * "Download" for an episode that was already on the device.
 *
 * It is also where interrupted downloads are settled. Nothing can be running
 * when the module has only just loaded, so a row still saying 'downloading'
 * was left by a closed or reloaded tab. It used to stay that way until the
 * Downloads screen happened to reconcile it, and a tap on the detail page in
 * the meantime said "Download paused" while the row went on showing a
 * percentage that never moved.
 */
function ensureLoaded(): Promise<void> {
  if (!loading) loading = loadManifest();
  return loading;
}

async function loadManifest(): Promise<void> {
  const cache = await openLibrary();
  if (!cache) return;
  try {
    const res = await cache.match(MANIFEST_URL);
    if (res) {
      const parsed = (await res.json()) as Manifest;
      if (parsed?.episodes) Object.assign(mem.episodes, parsed.episodes);
    }
  } catch {
    // A corrupt manifest must not take the app down.
  }
  let changed = false;
  for (const [key, row] of Object.entries(mem.episodes)) {
    if (row.status === 'downloading' && !activeJobs.has(key)) {
      mem.episodes[key] = { ...row, status: 'paused', updatedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) await persist();
}

let persistQueue: Promise<void> = Promise.resolve();
async function persist(required = false): Promise<void> {
  // Cache.put calls can finish out of order. Serialize snapshots so an older
  // progress write can never overwrite a completed copy or a deletion.
  const write = persistQueue.then(async () => {
    const cache = await openLibrary();
    if (!cache) throw new Error('Offline downloads are not available in this browser.');
    await cache.put(
      MANIFEST_URL,
      new Response(JSON.stringify(mem), { headers: { 'content-type': 'application/json' } }),
    );
  });
  persistQueue = write.catch(() => undefined);
  // Progress can be retried, but a copy must not be called ready until its
  // manifest is durable. Otherwise it disappears on the next page load.
  await (required ? write : persistQueue);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_INTERVAL_MS);
}

async function patch(record: OfflineEpisode, required = false): Promise<void> {
  const key = episodeKey(record.animeId, record.episodeId);
  // Deleted mid-download: a worker still finishing must not write the row back.
  if (canceledEpisodeJobs.has(key)) return;
  mem.episodes[key] = record;
  await persist(required);
  notify();
}

export async function getOfflineEpisode(
  animeId: string,
  episodeId: string,
): Promise<OfflineEpisode | null> {
  await ensureLoaded();
  return mem.episodes[episodeKey(animeId, episodeId)] || null;
}

export async function listOfflineEpisodes(): Promise<OfflineEpisode[]> {
  await ensureLoaded();
  return Object.values(mem.episodes).sort((a, b) => b.updatedAt - a.updatedAt);
}

const MODULE_LOADED_AT = Date.now();

/** Kept for the shared surface; ensureLoaded now does this on first use. */
export async function reconcileInterruptedEpisodes(): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const [key, row] of Object.entries(mem.episodes)) {
    if (row.status === 'downloading' && row.updatedAt < MODULE_LOADED_AT && !activeJobs.has(key)) {
      mem.episodes[key] = { ...row, status: 'paused', updatedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) {
    await persist();
    notify();
  }
}

export async function getOfflinePlaybackUri(
  animeId: string,
  episodeId: string,
): Promise<string | null> {
  const row = await getOfflineEpisode(animeId, episodeId);
  if (row?.status !== 'ready') return null;
  /*
   * Only a page the service worker controls can read these URLs. In an
   * uncontrolled tab (the very first load, or a shift-reload) the request goes
   * to the host, whose SPA rewrite answers /app/__offline/* with index.html and
   * status 200 — so the player received HTML and failed as a "broken video"
   * with a perfect copy sitting in the cache. Returning null lets watch.tsx
   * stream instead, or say the copy is unavailable when there is no network.
   */
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return null;
  const cache = await openLibrary();
  if (!cache) return null;
  const uri = await cachedPlaybackUri(cache, row);
  if (!uri) {
    // A ready row disables the download button. Make an evicted/incomplete
    // copy retryable instead of asking the user to redownload a disabled row.
    await patch({ ...row, status: 'error', error: 'Some downloaded files are missing. Connect and retry to repair this episode.', updatedAt: Date.now() });
  }
  return uri;
}

async function cachedPlaybackUri(cache: Cache, row: OfflineEpisode): Promise<string | null> {
  const { animeId, episodeId } = row;
  // Confirm the bytes are still there: Cache Storage is evictable and a
  // manifest row is not proof. Returning null lets the player fall back to
  // streaming rather than showing a broken video.
  if (row.format === 'hls') {
    const playlist = offlineEpisodeFileUrl(animeId, episodeId, PLAYLIST_NAME);
    const media = (row.files || []).filter((name) => /^(?:seg\d+\.|init\d+\.|key\d+\.)/.test(name));
    if (!media.length) return null;
    // Checking keys avoids loading hundreds of cached bodies into memory.
    // Missing a middle segment, init file or decryption key is just as fatal
    // as losing the first/last segment.
    const keys = await cache.keys().catch(() => [] as Request[]);
    const paths = new Set(keys.map((request) => new URL(request.url).pathname));
    return [playlist, ...media.map((name) => offlineEpisodeFileUrl(animeId, episodeId, name))]
      .every((path) => paths.has(path)) ? playlist : null;
  }
  const url = offlineEpisodeUrl(animeId, episodeId);
  const hit = await cache.match(url).catch(() => undefined);
  return hit ? url : null;
}

/** Every entry of one episode: the progressive file and everything under its HLS directory. */
async function deleteEpisodeFiles(cache: Cache, pairs: Array<{ animeId: string; episodeId: string }>) {
  if (!pairs.length) return;
  await Promise.all(pairs.map(({ animeId, episodeId }) =>
    cache.delete(offlineEpisodeUrl(animeId, episodeId)).catch(() => false)));
  const prefixes = pairs.map(({ animeId, episodeId }) => `${offlineEpisodeUrl(animeId, episodeId)}/`);
  let keys: readonly Request[] = [];
  try {
    keys = await cache.keys();
  } catch {
    return;
  }
  await Promise.all(keys
    .filter((req) => {
      let path: string;
      try {
        path = new URL(req.url).pathname;
      } catch {
        return false;
      }
      return prefixes.some((prefix) => path.startsWith(prefix));
    })
    .map((req) => cache.delete(req).catch(() => false)));
}

/** The cover is shared by a title's episodes; it goes with the last one. */
async function dropCoverIfUnused(cache: Cache, animeId: string) {
  if (Object.values(mem.episodes).some((row) => row.animeId === animeId)) return;
  await cache.delete(offlineCoverUrl(COVER_SOURCE, animeId)).catch(() => false);
}

export async function deleteOfflineEpisode(animeId: string, episodeId: string) {
  await ensureLoaded();
  const key = episodeKey(animeId, episodeId);
  // Stop an in-flight job first, or its worker writes the episode back in
  // after the delete.
  canceledEpisodeJobs.add(key);
  pausedEpisodeJobs.delete(key);
  jobAborts.get(key)?.abort();
  partialChunks.delete(key);
  delete mem.episodes[key];
  await persist();
  notify();
  const cache = await openLibrary();
  if (!cache) return;
  await deleteEpisodeFiles(cache, [{ animeId, episodeId }]);
  await dropCoverIfUnused(cache, animeId);
}

export async function clearAllOfflineEpisodes() {
  await ensureLoaded();
  // Cancel every running job and drop pause flags (see deleteOfflineEpisode).
  for (const key of activeJobs.keys()) {
    canceledEpisodeJobs.add(key);
    jobAborts.get(key)?.abort();
  }
  pausedEpisodeJobs.clear();
  const rows = Object.values(mem.episodes);
  mem.episodes = {};
  partialChunks.clear();
  await persist();
  notify();
  const cache = await openLibrary();
  if (!cache) return;
  await deleteEpisodeFiles(cache, rows);
  await Promise.all([...new Set(rows.map((row) => row.animeId))].map((animeId) =>
    cache.delete(offlineCoverUrl(COVER_SOURCE, animeId)).catch(() => false)));
}

export async function getOfflineStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.episodes)) {
    // A paused or failed HLS copy keeps its segments (that is how it resumes),
    // so they count. A partial Original lives only in memory and does not.
    if (row.status === 'ready' || row.format === 'hls') total += row.bytesDownloaded || 0;
  }
  return total;
}

/** Copied verbatim from the native store so both platforms format identically. */
export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function pauseAnimeEpisodeDownload(animeId: string, episodeId: string) {
  const key = episodeKey(animeId, episodeId);
  pausedEpisodeJobs.add(key);
  // An HLS job stops its in-flight requests now rather than after up to a
  // minute of segment; a partial segment is simply fetched again on resume.
  jobAborts.get(key)?.abort();
  const row = mem.episodes[key];
  if (row?.status === 'downloading' && !activeJobs.has(key)) {
    // Nothing is behind this row (its tab closed mid-download). Settle it here
    // so the button the user just pressed visibly does something.
    mem.episodes[key] = { ...row, status: 'paused', updatedAt: Date.now() };
    void persist();
  }
  // The native store always notified here and this one never did, so the
  // detail page kept rendering "Pause download" after a pause.
  notify();
}

export function resumeAnimeEpisodeDownload(animeId: string, episodeId: string) {
  pausedEpisodeJobs.delete(episodeKey(animeId, episodeId));
}

export function isAnimeEpisodePaused(animeId: string, episodeId: string): boolean {
  return pausedEpisodeJobs.has(episodeKey(animeId, episodeId));
}

/** Fetch Original bytes under one deadline, including reading the response body. */
async function originalRequest<T>(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  return withRetries(signal, async () => {
    if (signal.aborted) throw new Aborted();
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers, signal: ctrl.signal });
      try {
        if (response.status === 429 || response.status === 503) throw new Busy(retryAfterMs(response.headers.get('retry-after')));
        if (response.status >= 500 || response.status === 408) throw new Retryable(`Download failed (${response.status}).`);
        if (!response.ok) throw new DownloadError(`Download failed (${response.status}).`);
        return await consume(response);
      } finally {
        void response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (signal.aborted) throw new Aborted();
      if (ctrl.signal.aborted || error instanceof TypeError) throw new Retryable('The connection dropped while downloading.');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  });
}

/** Total size via a one-byte ranged probe, so we can refuse before writing. */
async function probeSize(url: string, signal: AbortSignal): Promise<{ size: number; type: string; validator: string }> {
  return originalRequest(url, signal, { Range: 'bytes=0-0' }, async (res) => {
    const range = /^bytes 0-0\/(\d+)$/.exec(res.headers.get('content-range') || '');
    const size = Number(range?.[1]);
    if (res.status !== 206 || !Number.isSafeInteger(size) || size <= 0) {
      throw new DownloadError('This episode could not be prepared for download.');
    }
    return { size, type: res.headers.get('content-type') || 'video/mp4',
      validator: res.headers.get('etag') || res.headers.get('last-modified') || '' };
  });
}

/** A message meant for the user, shown as-is in the toast and on the row. */
class DownloadError extends Error {}

/**
 * Refuse before writing a byte if it cannot fit, naming both numbers — an
 * out-of-space failure 400MB in is a far worse experience than a refusal.
 */
async function ensureSpace(bytes: number, approximate: boolean): Promise<void> {
  if (!bytes) return;
  try {
    const est = await navigator.storage?.estimate?.();
    const quota = est?.quota || 0;
    const used = est?.usage || 0;
    if (quota && bytes > quota - used - STORAGE_HEADROOM) {
      throw new DownloadError(
        `Not enough space: this episode ${approximate ? 'needs about' : 'is'} ${formatBytes(bytes)} and only ` +
          `${formatBytes(Math.max(0, quota - used - STORAGE_HEADROOM))} is free.`,
      );
    }
  } catch (e) {
    if (e instanceof DownloadError) throw e;
  }
}

/**
 * Ask the browser to keep this origin's storage under pressure. Best effort:
 * a refusal is not an error, the copy is just evictable like any site data.
 */
function requestPersistentStorage(): void {
  try {
    if (navigator.storage?.persist) {
      void navigator.storage.persisted().then((persisted) => {
        if (!persisted) void navigator.storage.persist();
      }).catch(() => undefined);
    }
  } catch {
    // Best effort.
  }
}

type DownloadOptions = {
  animeId: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  title: string;
  cover: string;
  episodeThumbnail?: string;
  category?: 'sub' | 'dub';
};

export function downloadAnimeEpisode(opts: DownloadOptions): Promise<void> {
  const key = episodeKey(opts.animeId, opts.episodeId);
  const running = activeJobs.get(key);
  if (running) {
    // A delete that is still winding down must not swallow a fresh download.
    if (canceledEpisodeJobs.has(key)) {
      return running.catch(() => undefined).then(() => downloadAnimeEpisode(opts));
    }
    return running;
  }
  pausedEpisodeJobs.delete(key);
  canceledEpisodeJobs.delete(key);
  const job: Promise<void> = runDownload(opts, key).finally(() => {
    if (activeJobs.get(key) === job) {
      activeJobs.delete(key);
      jobAborts.delete(key);
      canceledEpisodeJobs.delete(key);
    }
  });
  activeJobs.set(key, job);
  return job;
}

async function runDownload(opts: DownloadOptions, key: string): Promise<void> {
  await ensureLoaded();
  if (canceledEpisodeJobs.has(key)) return;
  const existing = mem.episodes[key];

  const cache = await openLibrary();
  if (!cache) throw new Error('Offline downloads are not available in this browser.');
  if (existing?.status === 'ready' && await cachedPlaybackUri(cache, existing)) return;

  const { isSakuraOriginal, resolveSakuraOriginalStreamUrl } = await import('@/lib/sakura-originals');
  if (canceledEpisodeJobs.has(key)) return;

  /**
   * Route on the ID, not the URL.
   *
   * The native store decides by regex on the URL ending in .mp4/.mov, which
   * matches the proxied Originals URL only by luck — one `?v=` cache-buster and
   * it would silently take the HLS path. The id is what actually determines the
   * source. The detail page makes the same split to decide whether hls.js is
   * needed, but this is the one that counts: the Downloads screen's Retry and
   * Resume call straight into this function.
   */
  if (isSakuraOriginal(String(opts.animeId))) {
    await downloadOriginal(opts, key, cache, resolveSakuraOriginalStreamUrl);
    return;
  }
  await downloadHlsEpisode(opts, key, cache, existing);
}

// ─── Sakura Originals: one progressive file ─────────────────────────────────

async function downloadOriginal(
  opts: DownloadOptions,
  key: string,
  cache: Cache,
  resolveSakuraOriginalStreamUrl: (episodeId: string) => Promise<string | null>,
): Promise<void> {
  const ctrl = new AbortController();
  jobAborts.set(key, ctrl);
  let record: OfflineEpisode = {
    ...opts, category: opts.category || 'sub', status: 'downloading', progress: 0,
    bytesDownloaded: 0, totalSegments: 0, completedSegments: 0,
    format: 'mp4', updatedAt: Date.now(),
  };
  const update = async (changes: Partial<OfflineEpisode>, required = false) => {
    record = { ...record, ...changes, updatedAt: Date.now() };
    await patch(record, required);
  };
  const checkStopped = () => {
    if (canceledEpisodeJobs.has(key) || pausedEpisodeJobs.has(key) || ctrl.signal.aborted) throw new Aborted();
  };
  try {
    await patch(record, true);
    checkStopped();
    const src = await resolveSakuraOriginalStreamUrl(opts.episodeId);
    checkStopped();
    if (!src) throw new DownloadError('Could not find a video file for this episode.');
    const probe = await probeSize(src, ctrl.signal);
    checkStopped();
    const identity = `${src}:${probe.size}:${probe.validator}`;
    const partial = partialChunks.get(key);
    const parts = partial?.identity === identity ? [...partial.parts] : [];
    const totalChunks = probe.size <= SINGLE_GET_MAX ? 1 : Math.ceil(probe.size / CHUNK_BYTES);
    await ensureSpace(Math.max(0, probe.size - parts.reduce((n, part) => n + part.size, 0)), false);
    requestPersistentStorage();
    await update({ totalSegments: totalChunks, completedSegments: parts.length,
      progress: parts.length / totalChunks, bytesDownloaded: parts.reduce((n, part) => n + part.size, 0) });

    for (let i = parts.length; i < totalChunks; i += CHUNK_CONCURRENCY) {
      checkStopped();
      const batch = [];
      for (let k = 0; k < CHUNK_CONCURRENCY && i + k < totalChunks; k++) {
        const idx = i + k;
        const ranged = totalChunks > 1;
        const start = idx * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES - 1, probe.size - 1);
        const headers: Record<string, string> = ranged ? { Range: `bytes=${start}-${end}` } : {};
        if (ranged && probe.validator) headers['If-Range'] = probe.validator;
        batch.push(originalRequest(src, ctrl.signal, headers, async (res) => {
          if (ranged) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
            if (res.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== probe.size) {
              throw new DownloadError('The video server returned an invalid byte range. Try again later.');
            }
          } else if (res.status !== 200) throw new DownloadError('The video server returned an incomplete file.');
          const validator = res.headers.get('etag') || res.headers.get('last-modified') || '';
          if (probe.validator && validator && validator !== probe.validator) throw new DownloadError('This episode changed on the server. Try the download again.');
          if (/text\/|html|json/i.test(res.headers.get('content-type') || '')) throw new DownloadError('The video server returned invalid video data.');
          const blob = await res.blob();
          if (blob.size !== (ranged ? end - start + 1 : probe.size)) throw new Retryable('The download finished with an incorrect size. Try again.');
          return blob;
        }));
      }
      // Wait for every request to settle before cleanup; a rejected sibling
      // must never keep writing after this job has been removed or retried.
      const results = await Promise.allSettled(batch);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        parts.push(result.value);
      }
      checkStopped();
      partialChunks.set(key, { identity, parts: [...parts] });
      await update({ completedSegments: parts.length, progress: parts.length / totalChunks,
        bytesDownloaded: parts.reduce((n, part) => n + part.size, 0) });
    }
    checkStopped();
    const blob = new Blob(parts, { type: probe.type });
    if (blob.size !== probe.size) throw new DownloadError('The download finished with an incorrect size. Try again.');
    const [offlineCover, offlineThumbnail] = await Promise.all([
      storeImage(cache, opts.cover, offlineCoverUrl(COVER_SOURCE, opts.animeId), ctrl.signal),
      storeImage(cache, opts.episodeThumbnail, offlineEpisodeFileUrl(opts.animeId, opts.episodeId, THUMB_NAME), ctrl.signal),
    ]);
    checkStopped();
    await cache.put(offlineEpisodeUrl(opts.animeId, opts.episodeId), new Response(blob, {
      headers: { 'Content-Type': probe.type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' },
    }));
    checkStopped();
    await update({ status: 'ready', progress: 1, bytesDownloaded: blob.size, completedSegments: totalChunks,
      localPlaylistUri: offlineEpisodeUrl(opts.animeId, opts.episodeId), offlineCover, offlineThumbnail, error: undefined }, true);
    partialChunks.delete(key);
  } catch (error) {
    if (canceledEpisodeJobs.has(key)) {
      partialChunks.delete(key);
      await deleteEpisodeFiles(cache, [opts]);
      await dropCoverIfUnused(cache, opts.animeId);
      return;
    }
    if (pausedEpisodeJobs.has(key)) {
      await update({ status: 'paused' });
      return;
    }
    // A pause immediately followed by Resume can abort this job before the
    // resume call joins it. Finish the stop, then start its continuation.
    if (isAbort(error, ctrl.signal)) {
      await downloadOriginal(opts, key, cache, resolveSakuraOriginalStreamUrl);
      return;
    }
    const message = friendlyError(error);
    await update({ status: 'error', error: message });
    throw new DownloadError(message);
  }
}

// ─── Everything else: HLS through the relay ─────────────────────────────────

/** Stopped by pause or delete; never reported as a failure. */
class Aborted extends Error {}
/** Network error, timeout or transient 5xx: try the same URL again. */
class Retryable extends Error {}
/** The body was not the media it claimed to be (hls-local-playlist checkMediaBytes). */
class BadMedia extends Retryable {}
/** 429/503: wait (Retry-After) and try again. */
class Busy extends Error {
  constructor(readonly waitMs: number) {
    super('The stream is busy right now. Try again in a few minutes.');
  }
}
/** 401/403: the signed URL expired. Resolve fresh ones and continue. */
class Expired extends Error {}
/** The playlist after a re-resolve is a different encode; what is stored cannot be continued. */
class Restart extends Error {}

/**
 * Relay rejections that a retry cannot change: its allowlist refusing the
 * provider's current CDN host (supabase/functions/anime-stream/handler.ts
 * allowedUrl), or a playlist feature it does not relay. Everything else it
 * answers 502 with is an upstream hiccup worth retrying.
 */
const RELAY_REFUSAL = /not allowed|outside this episode|unsupported media url|invalid media redirect|unsupported playlist|interstitial|playlist attribute|playlist urls must be quoted|playlist encryption/i;

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return e instanceof Aborted || !!signal?.aborted || (e instanceof DOMException && e.name === 'AbortError');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Aborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(value: string | null): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_WAIT_MS, seconds * 1000);
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.min(MAX_WAIT_MS, Math.max(0, at - Date.now()));
  }
  return DEFAULT_WAIT_MS;
}

let relaySlots = RELAY_CONCURRENCY;
const relayWaiters: Array<() => void> = [];
async function withRelaySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (relaySlots > 0) relaySlots--;
  else await new Promise<void>((resolve) => relayWaiters.push(resolve));
  try {
    return await fn();
  } finally {
    const next = relayWaiters.shift();
    if (next) next();
    else relaySlots++;
  }
}

type RelayBody = { bytes: Uint8Array<ArrayBuffer>; contentType: string | null };

/**
 * One GET against the relay, with the body read under the same deadline, and
 * the failure classified for the retry policy above.
 */
async function relayGet(url: string, signal: AbortSignal): Promise<RelayBody> {
  return withRelaySlot(async () => {
    if (signal.aborted) throw new Aborted();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch {
        if (signal.aborted) throw new Aborted();
        throw new Retryable('network');
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        const message = typeof body?.error === 'string' ? body.error : '';
        if (res.status === 401 || res.status === 403) throw new Expired(message);
        if (res.status === 429 || res.status === 503) throw new Busy(retryAfterMs(res.headers.get('retry-after')));
        if (RELAY_REFUSAL.test(message)) throw new DownloadError(SOURCE_UNAVAILABLE);
        if (res.status >= 500 || res.status === 408) throw new Retryable(`HTTP ${res.status}`);
        throw new DownloadError(SOURCE_UNAVAILABLE);
      }
      if (res.status !== 200) throw new Retryable('The relay returned only part of the video resource.');
      try {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const length = res.headers.get('content-length');
        if (length && !res.headers.get('content-encoding') && Number(length) !== bytes.byteLength) throw new Retryable('body');
        return { bytes, contentType: res.headers.get('content-type') };
      } catch {
        // The relay streams segments without Content-Length; a connection that
        // drops mid-body surfaces here, not as a short success.
        if (signal.aborted) throw new Aborted();
        throw new Retryable('body');
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  });
}

/**
 * Retries for one request: backoff on Retryable, Retry-After on Busy. Expired
 * is NOT retried here — the URL itself is dead and only a fresh resolve helps.
 */
async function withRetries<T>(signal: AbortSignal, attemptOnce: (lastAttempt: boolean) => Promise<T>): Promise<T> {
  let attempt = 0;
  let waits = 0;
  for (;;) {
    try {
      return await attemptOnce(attempt === MAX_ATTEMPTS - 1);
    } catch (e) {
      if (isAbort(e, signal)) throw new Aborted();
      if (e instanceof Busy && waits < MAX_WAITS) {
        waits++;
        await sleep(e.waitMs, signal);
        continue;
      }
      if (e instanceof Retryable && ++attempt < MAX_ATTEMPTS) {
        await sleep(1_000 * 2 ** (attempt - 1), signal);
        continue;
      }
      throw e;
    }
  }
}

async function relayText(url: string, signal: AbortSignal): Promise<string> {
  const { bytes } = await withRetries(signal, () => relayGet(url, signal));
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  if (!text.startsWith('#EXTM3U')) throw new DownloadError('Could not read the video playlist. Try again later.');
  return text;
}

type StreamTarget = { malId: string; episode: number };

/** Same id forms fetchEpisodeSources (lib/anime.ts) sends to the relay. */
function streamTarget(animeId: string, episodeId: string): StreamTarget | null {
  const mal = /^mal-([1-9]\d*)-(\d+)$/.exec(episodeId);
  const hi = /^hi-\d+-(\d+)$/.exec(episodeId);
  const malId = mal?.[1] ?? (hi && /^[1-9]\d*$/.test(animeId) ? animeId : undefined);
  const episode = Number(mal?.[2] ?? hi?.[1]);
  return malId && Number.isSafeInteger(episode) && episode > 0 ? { malId, episode } : null;
}

function offlineMessage(): string | null {
  return typeof navigator !== 'undefined' && navigator.onLine === false
    ? "You're offline. Connect to the internet to download, then tap the episode again."
    : null;
}

/**
 * Resolve exactly as the web player does (fetchBrowserAnimeStream, the signed
 * relay), not through fetchEpisodeSources: that falls back to Consumet/raw CDN
 * URLs the browser cannot fetch.
 *
 * The asked-for language first, and the other one only when the provider says
 * the first does not exist. A failed or timed-out resolve is not that: falling
 * through would quietly download a dub for someone who asked for subtitles.
 */
async function resolveStream(
  target: StreamTarget,
  preferred: 'sub' | 'dub',
  force = false,
): Promise<{ source: StreamingSource; category: 'sub' | 'dub' }> {
  const order: Array<'sub' | 'dub'> = preferred === 'dub' ? ['dub', 'sub'] : ['sub', 'dub'];
  for (const category of order) {
    const source = await fetchBrowserAnimeStream({ malId: target.malId, episode: target.episode, category, ...(force ? { force: true } : {}) });
    if (source?.unavailableCategory) continue;
    if (source?.url) return { source, category };
    throw new DownloadError(offlineMessage() ?? "Couldn't reach this episode's stream. Check your connection and try again.");
  }
  throw new DownloadError("This episode isn't available to download right now.");
}

type Prepared = {
  source: StreamingSource;
  category: 'sub' | 'dub';
  variant: HlsVariant | null;
  durationSec: number;
  plan: LocalPlaylistPlan;
  fingerprint: string;
};

async function prepareHls(
  opts: DownloadOptions,
  target: StreamTarget,
  preferred: 'sub' | 'dub',
  signal: AbortSignal,
  force = false,
): Promise<Prepared> {
  const { source, category } = await resolveStream(target, preferred, force);
  if (signal.aborted) throw new Aborted();
  const masterText = await relayText(source.url, signal);
  let mediaUrl = source.url;
  let mediaText = masterText;
  let variant: HlsVariant | null = null;
  if (isMasterPlaylist(masterText)) {
    variant = chooseVariant(parseMasterVariants(masterText, source.url));
    if (!variant) throw new DownloadError('Could not read the video playlist. Try again later.');
    if (hasSeparateAudio(masterText, variant)) {
      throw new DownloadError("This episode keeps its audio in a separate track, which browser downloads don't support yet.");
    }
    mediaUrl = variant.url;
    mediaText = await relayText(mediaUrl, signal);
    if (isMasterPlaylist(mediaText)) throw new DownloadError('Could not read the video playlist. Try again later.');
  }
  const summary = summarizeMediaPlaylist(mediaText);
  if (!summary.endList) throw new DownloadError('This episode is still being streamed live. Download it after the stream has finished.');
  if (!summary.segmentCount) throw new DownloadError('No video segments in this stream.');
  const plan = planLocalPlaylist(mediaText, mediaUrl, (name) => offlineEpisodeFileUrl(opts.animeId, opts.episodeId, name));
  return {
    source,
    category,
    variant,
    durationSec: summary.durationSec,
    plan,
    fingerprint: JSON.stringify([category, variant?.width, variant?.height, variant?.bandwidth,
      variant?.codecs, mediaPlaylistFingerprint(mediaText, mediaUrl)]),
  };
}

/** Names already in the cache for this episode, with their stored sizes. */
async function storedFiles(cache: Cache, animeId: string, episodeId: string): Promise<Map<string, number>> {
  const prefix = `${offlineEpisodeUrl(animeId, episodeId)}/`;
  const found = new Map<string, number>();
  let keys: readonly Request[] = [];
  try {
    keys = await cache.keys();
  } catch {
    return found;
  }
  const mine = keys.filter((req) => {
    try {
      return new URL(req.url).pathname.startsWith(prefix);
    } catch {
      return false;
    }
  });
  await Promise.all(mine.map(async (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname.slice(prefix.length));
    const hit = await cache.match(req).catch(() => undefined);
    if (hit) found.set(name, Number(hit.headers.get('Content-Length')) || 0);
  }));
  return found;
}

/** Captions the player will show, English first, as same-origin files. */
async function storeCaptions(
  cache: Cache,
  opts: DownloadOptions,
  source: StreamingSource,
  signal: AbortSignal,
): Promise<{ subtitles: NonNullable<OfflineEpisode['subtitles']>; names: string[] }> {
  const tracks = [...(source.subtitles ?? [])]
    .sort((a, b) => Number(/^en(?:-|$)/i.test(b.lang)) - Number(/^en(?:-|$)/i.test(a.lang)))
    .slice(0, MAX_CAPTIONS);
  const subtitles: NonNullable<OfflineEpisode['subtitles']> = [];
  const names: string[] = [];
  for (const track of tracks) {
    if (signal.aborted) throw new Aborted();
    const name = `sub${names.length}.vtt`;
    try {
      const { bytes } = await withRetries(signal, () => relayGet(track.url, signal));
      const text = new TextDecoder().decode(bytes);
      if (!/^\uFEFF?WEBVTT/.test(text)) continue;
      const uri = offlineEpisodeFileUrl(opts.animeId, opts.episodeId, name);
      await cache.put(uri, new Response(bytes, {
        headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': String(bytes.byteLength) },
      }));
      subtitles.push({ lang: track.lang, label: track.label, uri });
      names.push(name);
    } catch (e) {
      if (isAbort(e, signal)) throw new Aborted();
      // A missing caption track is not worth failing a 300MB download over.
    }
  }
  return { subtitles, names };
}

/**
 * Best-effort copy of a piece of artwork, so the detail page and Downloads
 * have a picture with no network. MyAnimeList's and AniList's CDNs both send
 * Access-Control-Allow-Origin, so this is a plain CORS fetch; anything that
 * fails is skipped and the page falls back to the remote URL.
 */
async function storeImage(cache: Cache, remote: string | undefined, local: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!remote || !/^(?:https?:)?\//i.test(remote)) return undefined;
  try {
    if (await cache.match(local)) return local;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctrl.abort();
    const timer = setTimeout(() => ctrl.abort(), ARTWORK_TIMEOUT_MS);
    try {
      const res = await fetch(remote, { signal: ctrl.signal });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) return undefined;
      const blob = await res.blob();
      if (ctrl.signal.aborted) return undefined;
      await cache.put(local, new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size) } }));
      return local;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  } catch {
    return undefined;
  }
}

function contentTypeFor(resource: LocalResource, relayType: string | null): string {
  if (resource.kind === 'key') return 'application/octet-stream';
  return relayType || (resource.kind === 'seg' ? 'video/mp2t' : 'video/mp4');
}

function friendlyError(e: unknown): string {
  if (e instanceof DownloadError) return e.message;
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return 'Your device ran out of space for downloads.';
  if (e instanceof Busy) return e.message;
  if (e instanceof Expired) return 'The stream link kept expiring. Tap the episode to try again.';
  if (e instanceof Restart) return 'This episode changed on the server while downloading. Tap it to start again.';
  if (e instanceof BadMedia) return "This episode's video data didn't check out. Try again later.";
  if (e instanceof Retryable) {
    return offlineMessage() ?? 'The connection dropped while downloading. Tap the episode to resume.';
  }
  return e instanceof Error && e.message ? e.message : 'Download failed';
}

async function downloadHlsEpisode(
  opts: DownloadOptions,
  key: string,
  cache: Cache,
  existing: OfflineEpisode | undefined,
): Promise<void> {
  // Saving an MP4 from these cached segments does not require MediaSource.
  // Browsers without hls.js playback can still keep the exported device file.
  const target = streamTarget(opts.animeId, opts.episodeId);
  if (!target) throw new DownloadError("This episode can't be downloaded in the browser.");

  // The language already on disk wins on resume; mixing would fail the
  // fingerprint and throw the stored segments away.
  const preferred = existing?.category ?? opts.category ?? 'sub';
  let record: OfflineEpisode = {
    ...existing,
    animeId: opts.animeId,
    episodeId: opts.episodeId,
    episodeNumber: opts.episodeNumber,
    episodeTitle: opts.episodeTitle,
    title: opts.title,
    cover: opts.cover,
    episodeThumbnail: opts.episodeThumbnail,
    category: preferred,
    status: 'downloading',
    progress: existing?.progress ?? 0,
    bytesDownloaded: existing?.bytesDownloaded ?? 0,
    totalSegments: existing?.totalSegments ?? 0,
    completedSegments: existing?.completedSegments ?? 0,
    format: 'hls',
    error: undefined,
    updatedAt: Date.now(),
  };
  await patch(record, true);

  if (pausedEpisodeJobs.has(key)) {
    await patch({ ...record, status: 'paused' });
    return;
  }

  let stored = 0;
  const finishPaused = async () => {
    record = { ...record, status: 'paused', updatedAt: Date.now() };
    await patch(record);
  };

  try {
    let restarts = 0;
    let rejoins = 0;
    for (;;) {
      try {
        const result = await runHlsJob(opts, key, cache, target, preferred, record, (next) => {
          record = next;
          stored = next.completedSegments;
        });
        if (result === 'canceled') {
          // Again, after the workers stopped: the delete ran while some of
          // their writes were still in flight.
          await deleteEpisodeFiles(cache, [{ animeId: opts.animeId, episodeId: opts.episodeId }]);
          await dropCoverIfUnused(cache, opts.animeId);
          return;
        }
        if (result === 'paused') {
          await finishPaused();
          return;
        }
        return;
      } catch (e) {
        // Aborted by a pause that was lifted before the job wound down (the
        // Resume tap joined this job instead of starting another): carry on.
        if (isAbort(e) && !pausedEpisodeJobs.has(key) && !canceledEpisodeJobs.has(key) && rejoins++ < 8) continue;
        if (e instanceof Restart && restarts++ < 1) {
          await deleteEpisodeFiles(cache, [{ animeId: opts.animeId, episodeId: opts.episodeId }]);
          record = { ...record, fingerprint: undefined, files: undefined, completedSegments: 0, progress: 0, bytesDownloaded: 0 };
          stored = 0;
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if (canceledEpisodeJobs.has(key)) {
      await deleteEpisodeFiles(cache, [{ animeId: opts.animeId, episodeId: opts.episodeId }]);
      await dropCoverIfUnused(cache, opts.animeId);
      return;
    }
    if (isAbort(e) && pausedEpisodeJobs.has(key)) {
      await finishPaused();
      return;
    }
    const message = friendlyError(e);
    if (!existing && stored === 0) {
      // Nothing was kept, so there is nothing to resume: drop the row (and any
      // captions or artwork already stored) and let the toast explain, rather
      // than leave a "failed" episode in Downloads.
      delete mem.episodes[key];
      await persist();
      notify();
      await deleteEpisodeFiles(cache, [{ animeId: opts.animeId, episodeId: opts.episodeId }]);
      await dropCoverIfUnused(cache, opts.animeId);
    } else {
      // Keep what is stored; tapping the episode (or Retry) resumes from it.
      await patch({ ...record, status: 'error', error: message, updatedAt: Date.now() });
    }
    throw new DownloadError(message);
  } finally {
    jobAborts.delete(key);
  }
}

async function runHlsJob(
  opts: DownloadOptions,
  key: string,
  cache: Cache,
  target: StreamTarget,
  preferred: 'sub' | 'dub',
  initial: OfflineEpisode,
  onRecord: (record: OfflineEpisode) => void,
): Promise<'done' | 'paused' | 'canceled'> {
  let record = initial;
  const setRecord = (next: OfflineEpisode, persistNow = false) => {
    record = next;
    onRecord(next);
    if (canceledEpisodeJobs.has(key)) return;
    mem.episodes[key] = next;
    notify();
    if (persistNow) void persist();
    else schedulePersist();
  };
  const stopped = () => canceledEpisodeJobs.has(key) ? 'canceled' as const
    : pausedEpisodeJobs.has(key) ? 'paused' as const : null;

  let ctrl = new AbortController();
  jobAborts.set(key, ctrl);

  let prepared = await prepareHls(opts, target, preferred, ctrl.signal);
  if (stopped()) return stopped()!;

  if (record.fingerprint && record.fingerprint !== prepared.fingerprint) {
    // A different encode or rendition than the stored segments came from:
    // they cannot be stitched together, so start this episode over.
    await deleteEpisodeFiles(cache, [{ animeId: opts.animeId, episodeId: opts.episodeId }]);
  }
  const downloads = prepared.plan.downloads.map((d) => ({ ...d }));
  const total = downloads.length;
  const onDisk = await storedFiles(cache, opts.animeId, opts.episodeId);
  const done = new Set<number>();
  let bytes = 0;
  downloads.forEach((d, i) => {
    if (onDisk.has(d.name)) {
      done.add(i);
      bytes += onDisk.get(d.name) || 0;
    }
  });

  const estimate = estimateRenditionBytes(prepared.variant, prepared.durationSec);
  await ensureSpace(Math.round(estimate * (1 - done.size / total)), true);
  requestPersistentStorage();

  const artwork = await Promise.allSettled([
    storeCaptions(cache, opts, prepared.source, ctrl.signal),
    storeImage(cache, opts.cover, offlineCoverUrl(COVER_SOURCE, opts.animeId), ctrl.signal),
    storeImage(cache, opts.episodeThumbnail, offlineEpisodeFileUrl(opts.animeId, opts.episodeId, THUMB_NAME), ctrl.signal),
  ]);
  const [captionResult, coverResult, thumbnailResult] = artwork;
  if (captionResult.status === 'rejected') throw captionResult.reason;
  const captions = captionResult.value;
  const offlineCover = coverResult.status === 'fulfilled' ? coverResult.value : undefined;
  const offlineThumbnail = thumbnailResult.status === 'fulfilled' ? thumbnailResult.value : undefined;
  if (stopped()) return stopped()!;

  setRecord({
    ...record,
    category: prepared.category,
    format: 'hls',
    quality: variantLabel(prepared.variant),
    fingerprint: prepared.fingerprint,
    intro: prepared.source.intro,
    outro: prepared.source.outro,
    subtitles: captions.subtitles,
    offlineCover,
    offlineThumbnail,
    files: [
      ...downloads.map((d) => d.name),
      ...captions.names,
      ...(offlineThumbnail ? [THUMB_NAME] : []),
      PLAYLIST_NAME,
    ],
    totalSegments: total,
    completedSegments: done.size,
    progress: done.size / total,
    bytesDownloaded: bytes,
    status: 'downloading',
    error: undefined,
    updatedAt: Date.now(),
  }, true);

  // ── Signed URLs expire (two hours) or die with a reload; resolve again ──
  let generation = 0;
  let resolves = 0;
  let refreshing: Promise<void> | null = null;
  const refresh = (signal: AbortSignal) => {
    refreshing ??= (async () => {
      if (++resolves > MAX_RESOLVES) throw new Expired();
      const next = await prepareHls(opts, target, prepared.category, signal, true);
      // Continue by index only if it is the same encode, resource for
      // resource; otherwise index 120 would be a different segment.
      if (next.fingerprint !== prepared.fingerprint || next.plan.downloads.length !== total) throw new Restart();
      next.plan.downloads.forEach((d, i) => { downloads[i].url = d.url; });
      prepared = next;
      generation++;
    })().finally(() => { refreshing = null; });
    return refreshing;
  };

  const fetchResource = async (i: number, signal: AbortSignal) => {
    for (;;) {
      const seenGeneration = generation;
      const resource = downloads[i];
      try {
        const got = await withRetries(signal, async (lastAttempt) => {
          const body = await relayGet(resource.url, signal);
          const verdict = checkMediaBytes(body.bytes, resource.kind, body.contentType);
          if (verdict === 'invalid') throw new BadMedia('invalid media');
          // A body cut short mid-packet: fetch again. If every attempt comes
          // back the same length, that is the provider's file, not a drop.
          if (verdict === 'misaligned' && !lastAttempt) throw new Retryable('truncated');
          return body;
        });
        if (signal.aborted) throw new Aborted();
        await cache.put(
          offlineEpisodeFileUrl(opts.animeId, opts.episodeId, resource.name),
          new Response(got.bytes, {
            headers: {
              'Content-Type': contentTypeFor(resource, got.contentType),
              'Content-Length': String(got.bytes.byteLength),
            },
          }),
        );
        done.add(i);
        bytes += got.bytes.byteLength;
        setRecord({
          ...record,
          completedSegments: done.size,
          progress: done.size / total,
          bytesDownloaded: bytes,
          status: pausedEpisodeJobs.has(key) ? 'paused' : 'downloading',
          updatedAt: Date.now(),
        });
        return;
      } catch (e) {
        if (e instanceof Expired) {
          // Another worker may already have refreshed while this request was
          // in flight; then the new URL is waiting and no resolve is needed.
          if (seenGeneration === generation) await refresh(signal);
          continue;
        }
        throw e;
      }
    }
  };

  for (;;) {
    let fatal: unknown = null;
    const queue = downloads.map((_, i) => i).filter((i) => !done.has(i));
    let cursor = 0;
    const signal = ctrl.signal;
    const worker = async () => {
      while (!fatal && !stopped() && !signal.aborted) {
        const i = queue[cursor++];
        if (i === undefined) return;
        try {
          await fetchResource(i, signal);
        } catch (e) {
          if (isAbort(e, signal)) return;
          fatal ??= e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RELAY_CONCURRENCY, queue.length) }, worker));

    if (canceledEpisodeJobs.has(key)) return 'canceled';
    if (fatal) throw fatal;
    if (done.size === total) break;
    if (pausedEpisodeJobs.has(key)) return 'paused';
    // Resumed while the workers were winding down from a pause: go again.
    ctrl = new AbortController();
    jobAborts.set(key, ctrl);
  }

  // The playlist goes in LAST. Its presence is what getOfflinePlaybackUri
  // treats as "this copy is complete", so it must never exist for a partial one.
  const playlistUrl = offlineEpisodeFileUrl(opts.animeId, opts.episodeId, PLAYLIST_NAME);
  await cache.put(playlistUrl, new Response(`${prepared.plan.outLines.join('\n')}\n`, {
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
  }));
  if (canceledEpisodeJobs.has(key)) return 'canceled';
  pausedEpisodeJobs.delete(key);
  record = {
    ...record,
    status: 'ready',
    progress: 1,
    completedSegments: total,
    bytesDownloaded: bytes,
    localPlaylistUri: playlistUrl,
    error: undefined,
    updatedAt: Date.now(),
  };
  onRecord(record);
  await patch(record, true);
  return 'done';
}
