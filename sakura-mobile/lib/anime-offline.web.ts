import {
  ANIME_MANIFEST_URL,
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
 * SCOPE: Sakura Originals only. Everything else Sakura plays is a third-party
 * HLS stream whose CDN gates on a `Referer` header, and `Referer` is a
 * forbidden request header name, so fetch silently drops it — there is no way
 * for a browser to obtain those bytes at all. Originals are plain progressive
 * MP4/MOV files served same-origin through /api/media-proxy/ with
 * Access-Control-Allow-Origin and Range support, so they are ordinary fetches.
 *
 * Because Originals are progressive files rather than playlists, none of the
 * native HLS machinery applies: no playlist rewriting, no #EXT-X-KEY handling,
 * no per-segment bookkeeping. One episode is one Cache Storage entry, and
 * web/public/sw.js serves byte ranges out of it so the player can seek.
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
  /** Kept for shape-compatibility with the native store; holds the synthetic URL. */
  localPlaylistUri?: string;
  error?: string;
  updatedAt: number;
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

type Manifest = { episodes: Record<string, OfflineEpisode> };

const mem: Manifest = { episodes: {} };
let loaded = false;
const listeners = new Set<() => void>();
const activeJobs = new Set<string>();
const pausedEpisodeJobs = new Set<string>();
const canceledEpisodeJobs = new Set<string>();

/**
 * Completed chunks of a paused job, so Resume does not start from zero.
 *
 * Deliberately in memory only. Persisting partial chunks would mean one cache
 * entry per chunk plus stitching logic in the service worker; that is a real
 * optimisation but not a v1 requirement. A reload therefore loses the progress
 * of a paused download and it restarts — reconcileInterruptedEpisodes marks
 * such rows 'paused' so the user sees a resumable row rather than a spinner
 * that never advances.
 */
const partialChunks = new Map<string, Blob[]>();

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

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
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
}

async function persist(): Promise<void> {
  const cache = await openLibrary();
  if (!cache) return;
  try {
    await cache.put(
      MANIFEST_URL,
      new Response(JSON.stringify(mem), { headers: { 'content-type': 'application/json' } }),
    );
  } catch {
    // Quota or private mode; the in-memory manifest still drives this session.
  }
}

async function patch(record: OfflineEpisode): Promise<void> {
  mem.episodes[episodeKey(record.animeId, record.episodeId)] = record;
  await persist();
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
  const cache = await openLibrary();
  if (!cache) return null;
  // Confirm the bytes are still there: Cache Storage is evictable and a
  // manifest row is not proof. Returning null lets the player fall back to
  // streaming rather than showing a broken video.
  const url = offlineEpisodeUrl(animeId, episodeId);
  const hit = await cache.match(url).catch(() => undefined);
  return hit ? url : null;
}

export async function deleteOfflineEpisode(animeId: string, episodeId: string) {
  await ensureLoaded();
  const key = episodeKey(animeId, episodeId);
  // Stop an in-flight job first, or its worker writes the episode back in
  // after the delete.
  canceledEpisodeJobs.add(key);
  partialChunks.delete(key);
  const cache = await openLibrary();
  if (cache) await cache.delete(offlineEpisodeUrl(animeId, episodeId)).catch(() => undefined);
  delete mem.episodes[key];
  await persist();
  notify();
}

export async function clearAllOfflineEpisodes() {
  await ensureLoaded();
  const cache = await openLibrary();
  if (cache) {
    for (const row of Object.values(mem.episodes)) {
      // eslint-disable-next-line no-await-in-loop
      await cache.delete(offlineEpisodeUrl(row.animeId, row.episodeId)).catch(() => undefined);
    }
  }
  mem.episodes = {};
  partialChunks.clear();
  await persist();
  notify();
}

export async function getOfflineStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.episodes)) {
    if (row.status !== 'ready') continue;
    total += row.bytesDownloaded || 0;
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
  pausedEpisodeJobs.add(episodeKey(animeId, episodeId));
}

export function resumeAnimeEpisodeDownload(animeId: string, episodeId: string) {
  pausedEpisodeJobs.delete(episodeKey(animeId, episodeId));
}

export function isAnimeEpisodePaused(animeId: string, episodeId: string): boolean {
  return pausedEpisodeJobs.has(episodeKey(animeId, episodeId));
}

/** Total size via a one-byte ranged probe, so we can refuse before writing. */
async function probeSize(url: string): Promise<{ size: number; type: string } | null> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (res.status !== 206) return null;
    const cr = res.headers.get('content-range') || '';
    const total = Number(cr.split('/')[1]);
    if (!Number.isFinite(total) || total <= 0) return null;
    return { size: total, type: res.headers.get('content-type') || 'video/mp4' };
  } catch {
    return null;
  }
}

export async function downloadAnimeEpisode(opts: {
  animeId: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  title: string;
  cover: string;
  episodeThumbnail?: string;
  category?: 'sub' | 'dub';
}): Promise<void> {
  const key = episodeKey(opts.animeId, opts.episodeId);
  if (activeJobs.has(key)) return;
  await ensureLoaded();
  if (mem.episodes[key]?.status === 'ready') return;

  const cache = await openLibrary();
  if (!cache) throw new Error('Offline downloads are not available in this browser.');

  const { isSakuraOriginal, resolveSakuraOriginalStreamUrl } = await import('@/lib/sakura-originals');

  /**
   * Guard on the ID, not the URL.
   *
   * The native store decides by regex on the URL ending in .mp4/.mov, which
   * matches the proxied Originals URL only by luck — one `?v=` cache-buster and
   * it would silently take the HLS path. The id is what actually determines the
   * source. This also has to live here rather than only in the UI, because the
   * Downloads screen's retry path calls straight into this function.
   */
  if (!isSakuraOriginal(String(opts.animeId))) {
    throw new Error(
      'This series streams from a source that blocks browser downloads. Downloads work in the Sakura app.',
    );
  }

  const src = await resolveSakuraOriginalStreamUrl(opts.episodeId);
  if (!src) throw new Error('Could not find a video file for this episode.');

  const probe = await probeSize(src);
  if (!probe) throw new Error('This episode could not be prepared for download.');

  // Refuse before writing a byte if it cannot fit, naming both numbers — an
  // out-of-space failure 400MB in is a far worse experience than a refusal.
  try {
    const est = await navigator.storage?.estimate?.();
    const quota = est?.quota || 0;
    const used = est?.usage || 0;
    const headroom = 200 * 1024 * 1024;
    if (quota && probe.size > quota - used - headroom) {
      throw new Error(
        `Not enough space: this episode is ${formatBytes(probe.size)} and only ` +
          `${formatBytes(Math.max(0, quota - used - headroom))} is free.`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Not enough space')) throw e;
  }
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      void navigator.storage.persist();
    }
  } catch {
    // Best effort.
  }

  activeJobs.add(key);
  pausedEpisodeJobs.delete(key);
  canceledEpisodeJobs.delete(key);

  const totalChunks = Math.max(1, Math.ceil(probe.size / CHUNK_BYTES));
  const existingParts = partialChunks.get(key) || [];
  let record: OfflineEpisode = {
    animeId: opts.animeId,
    episodeId: opts.episodeId,
    episodeNumber: opts.episodeNumber,
    episodeTitle: opts.episodeTitle,
    title: opts.title,
    cover: opts.cover,
    episodeThumbnail: opts.episodeThumbnail,
    category: opts.category || 'sub',
    status: 'downloading',
    progress: existingParts.length / totalChunks,
    bytesDownloaded: existingParts.reduce((n, b) => n + b.size, 0),
    totalSegments: totalChunks,
    completedSegments: existingParts.length,
    updatedAt: Date.now(),
  };
  await patch(record);

  const update = async (p: Partial<OfflineEpisode>) => {
    record = { ...record, ...p, updatedAt: Date.now() };
    mem.episodes[key] = record;
    await persist();
    notify();
  };

  // Blobs, not ArrayBuffers: Chrome's blob store spills to disk, whereas
  // holding 80 x 8MiB buffers would put a 600MB episode on the JS heap.
  const parts: Blob[] = [...existingParts];

  try {
    if (probe.size <= SINGLE_GET_MAX && !parts.length) {
      // One plain GET. Also the only request shape Vercel's CDN will cache —
      // it excludes anything carrying a Range header, and anything over 10MB.
      const res = await fetch(src);
      if (!res.ok) throw new Error(`Download failed (${res.status}).`);
      parts.push(await res.blob());
      await update({ completedSegments: 1, progress: 1, bytesDownloaded: parts[0].size });
    } else {
      for (let i = parts.length; i < totalChunks; i += CHUNK_CONCURRENCY) {
        if (canceledEpisodeJobs.has(key)) {
          canceledEpisodeJobs.delete(key);
          partialChunks.delete(key);
          return;
        }
        if (pausedEpisodeJobs.has(key)) {
          partialChunks.set(key, parts);
          await update({ status: 'paused' });
          return;
        }

        const batch = [];
        for (let k = 0; k < CHUNK_CONCURRENCY && i + k < totalChunks; k++) {
          const idx = i + k;
          const start = idx * CHUNK_BYTES;
          const end = Math.min(start + CHUNK_BYTES - 1, probe.size - 1);
          batch.push(
            fetch(src, { headers: { Range: `bytes=${start}-${end}` } }).then(async (r) => {
              if (r.status !== 206 && r.status !== 200) {
                throw new Error(`Download failed (${r.status}).`);
              }
              return r.blob();
            }),
          );
        }
        const got = await Promise.all(batch);
        for (const b of got) parts.push(b);

        await update({
          completedSegments: parts.length,
          progress: parts.length / totalChunks,
          bytesDownloaded: parts.reduce((n, b) => n + b.size, 0),
        });
      }
    }

    const blob = new Blob(parts, { type: probe.type });
    // A short file means a truncated download; storing it would give the user a
    // video that plays partway and then stops, which is worse than an error.
    if (blob.size < probe.size) {
      throw new Error('The download finished short. Try again.');
    }

    await cache.put(
      offlineEpisodeUrl(opts.animeId, opts.episodeId),
      new Response(blob, {
        headers: {
          'Content-Type': probe.type,
          'Content-Length': String(blob.size),
          'Accept-Ranges': 'bytes',
        },
      }),
    );
    partialChunks.delete(key);

    await update({
      status: 'ready',
      progress: 1,
      bytesDownloaded: blob.size,
      completedSegments: totalChunks,
      localPlaylistUri: offlineEpisodeUrl(opts.animeId, opts.episodeId),
      error: undefined,
    });
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === 'QuotaExceededError'
        ? 'Your device ran out of space for downloads.'
        : e instanceof Error
          ? e.message
          : 'Download failed';
    partialChunks.delete(key);
    await update({ status: 'error', error: message });
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}
