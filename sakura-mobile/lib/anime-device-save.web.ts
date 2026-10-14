import {
  downloadAnimeEpisode,
  getOfflineEpisode,
  subscribeOfflineEpisodes,
  type OfflineEpisode,
} from '@/lib/anime-offline';
import { offlineEpisodeUrl, openOfflineLibrary } from '@/lib/offline-cache-keys';
import { sanitizeDownloadName } from '@/lib/web-download';
import type { AnimeDeviceSaveSnapshot } from './anime-device-save-types';

export const CAN_SAVE_ANIME_VIDEO = true;

type Task = {
  key: string;
  animeId: string;
  episodeId: string;
  controller: AbortController;
  file?: File;
  urls: string[];
};

const listeners = new Set<() => void>();
const queue: Task[] = [];
let active: Task | null = null;
let snapshot: AnimeDeviceSaveSnapshot | null = null;
let watchingStore = false;

export function subscribeAnimeDeviceSave(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAnimeDeviceSaveSnapshot(): AnimeDeviceSaveSnapshot | null {
  return snapshot;
}

function publish(change: Partial<AnimeDeviceSaveSnapshot> = {}) {
  if (snapshot) snapshot = { ...snapshot, ...change, queued: queue.length };
  listeners.forEach(listener => listener());
}

function assertCurrent(task: Task) {
  task.controller.signal.throwIfAborted();
  if (active !== task) throw new DOMException('Video preparation was canceled.', 'AbortError');
}

function watchDeletions() {
  if (watchingStore) return;
  watchingStore = true;
  subscribeOfflineEpisodes(() => {
    const task = active;
    if (!task || snapshot?.status !== 'preparing') return;
    void getOfflineEpisode(task.animeId, task.episodeId).then(row => {
      if (active !== task || snapshot?.status !== 'preparing') return;
      if (!row || row.status !== 'ready') {
        task.controller.abort();
        publish({ status: 'error', error: 'This offline episode was removed or changed. Download it again to save a video.' });
      }
    });
  });
}

/** One conversion at a time: a queue never holds multiple episode-sized Blobs. */
export function requestAnimeVideoSave(animeId: string, episodeId: string): void {
  watchDeletions();
  const key = `${animeId}::${episodeId}`;
  if (active?.key === key) {
    if (snapshot?.status === 'error') retryAnimeDeviceSave();
    return;
  }
  if (queue.some(task => task.key === key)) return;
  const task = { key, animeId, episodeId, controller: new AbortController(), urls: [] };
  if (active) {
    queue.push(task);
    publish();
  } else {
    start(task);
  }
}

/** Used by every web episode Download/Resume/Retry entry point. */
export async function downloadAnimeEpisodeWithDeviceCopy(
  options: Parameters<typeof downloadAnimeEpisode>[0],
): Promise<void> {
  await downloadAnimeEpisode(options);
  const row = await getOfflineEpisode(options.animeId, options.episodeId);
  // Pause and cancellation also resolve the store's promise; neither is a
  // finished episode and neither should produce a partial device file.
  if (row?.status === 'ready') requestAnimeVideoSave(row.animeId, row.episodeId);
}

function start(task: Task) {
  active = task;
  snapshot = {
    key: task.key, title: 'Downloaded episode', filename: '', status: 'preparing',
    progress: 0, canShare: false, downloadStarted: false, queued: queue.length,
  };
  publish();
  void prepare(task);
}

function filenameFor(row: OfflineEpisode): string {
  const title = sanitizeDownloadName(row.title);
  const episode = Number.isFinite(row.episodeNumber) ? String(row.episodeNumber) : sanitizeDownloadName(row.episodeId);
  const quality = row.quality ? ` - ${sanitizeDownloadName(row.quality)}` : '';
  return `${title} - Episode ${episode} - ${row.category === 'dub' ? 'Dub' : 'Sub'}${quality}`;
}

async function prepare(task: Task) {
  // Blob parts leave the JavaScript heap after each segment. Never collect an
  // episode as Uint8Array[], join its buffers, or refetch already saved bytes.
  const parts: Blob[] = [];
  try {
    const row = await getOfflineEpisode(task.animeId, task.episodeId);
    assertCurrent(task);
    if (!row || row.status !== 'ready') throw new Error('Finish downloading this episode in Sakura before saving a video.');
    const baseName = filenameFor(row);
    publish({ title: `${row.title} · Episode ${row.episodeNumber}`, filename: `${baseName}.mp4` });
    const cache = await openOfflineLibrary();
    assertCurrent(task);
    if (!cache) throw new Error('Your browser could not open its saved episodes.');
    // The MP4 writer (mux.js) loads only when someone saves a video, not with
    // every screen that shows the save banner.
    const { writeAnimeVideo } = await import('./anime-video-export.web');
    const result = await writeAnimeVideo(cache, row, async bytes => {
      assertCurrent(task);
      parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    }, {
      signal: task.controller.signal,
      onProgress: progress => { if (active === task && !task.controller.signal.aborted) publish({ progress }); },
    });
    assertCurrent(task);
    const filename = `${baseName}.${result.extension}`;
    task.file = new File(parts, filename, { type: result.mimeType });
    parts.length = 0;
    if (!task.file.size || task.file.size !== result.bytes) throw new Error('The saved video is incomplete. Try preparing it again.');
    const url = URL.createObjectURL(task.file);
    task.urls.push(url);
    const subtitle = await prepareSubtitle(task, cache, row, baseName);
    assertCurrent(task);
    let canShare = false;
    try { canShare = !!navigator.share && !!navigator.canShare?.({ files: [task.file] }); } catch { /* File sharing is optional. */ }
    publish({ status: 'ready', progress: 1, url, filename, canShare, subtitle, error: undefined });
    // Downloading a file does not require the Web Share API. A visible link
    // remains available if a browser blocks an automatic download or asks
    // the user to choose its destination. We cannot claim the file was saved.
    startAnimeDeviceDownload();
  } catch (error) {
    parts.length = 0;
    if (active !== task || task.controller.signal.aborted) return;
    task.file = undefined;
    publish({ status: 'error', error: error instanceof Error ? error.message : 'Could not prepare the video. Your Sakura copy is still available.' });
  }
}

async function prepareSubtitle(task: Task, cache: Cache, row: OfflineEpisode, basename: string) {
  const track = row.subtitles?.find(item => /^(en|eng|english)(?:\b|[-_])/i.test(item.lang) || /english/i.test(item.label))
    || row.subtitles?.[0];
  if (!track) return undefined;
  try {
    const uri = new URL(track.uri, location.origin);
    const prefix = `${offlineEpisodeUrl(row.animeId, row.episodeId)}/`;
    if (uri.origin !== location.origin || !uri.pathname.startsWith(prefix)) return undefined;
    const cached = await cache.match(uri.href);
    if (!cached) return undefined;
    const blob = await cached.blob();
    assertCurrent(task);
    if (!blob.size) return undefined;
    const url = URL.createObjectURL(new Blob([blob], { type: 'text/vtt' }));
    task.urls.push(url);
    return { url, filename: `${basename}.${sanitizeDownloadName(track.lang || 'subtitles')}.vtt`, label: track.label || track.lang };
  } catch (error) {
    if (task.controller.signal.aborted) throw error;
    // Missing optional captions must not discard an otherwise complete video.
    return undefined;
  }
}

export function startAnimeDeviceDownload(): void {
  if (!active?.file || snapshot?.status !== 'ready' || !snapshot.url) return;
  try {
    const anchor = document.createElement('a');
    anchor.href = snapshot.url;
    anchor.download = snapshot.filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    publish({ downloadStarted: true, error: undefined });
  } catch {
    publish({ downloadStarted: false, error: 'Use Download MP4 below to save the video.' });
  }
}

/** Must be called directly from a click: sharing requires fresh user activation. */
export async function shareAnimeDeviceVideo(): Promise<void> {
  const task = active;
  if (!task?.file || snapshot?.status !== 'ready') return;
  try {
    if (!navigator.share || !navigator.canShare?.({ files: [task.file] })) {
      publish({ error: 'File sharing is unavailable here. Use Download MP4 instead.' });
      return;
    }
    // No await before navigator.share. Conversion and File creation already
    // happened before the user could press this button.
    await navigator.share({ files: [task.file], title: snapshot.title });
    if (active === task) publish({ error: undefined });
  } catch (error) {
    if (active !== task) return;
    if (error instanceof Error && error.name === 'AbortError') return;
    publish({ error: 'Sharing did not open. Use Download MP4 to save the video instead.' });
  }
}

function release(task: Task) {
  task.controller.abort();
  task.file = undefined;
  // The browser may still be opening its download stream or share sheet.
  // Keep object URLs briefly after dismissal, rather than revoking mid-save.
  const urls = task.urls.splice(0);
  setTimeout(() => urls.forEach(url => URL.revokeObjectURL(url)), 60_000);
}

export function dismissAnimeDeviceSave(): void {
  if (active) release(active);
  active = null;
  snapshot = null;
  const next = queue.shift();
  if (next) start(next);
  else publish();
}

export function retryAnimeDeviceSave(): void {
  const task = active;
  if (!task || snapshot?.status !== 'error') return;
  release(task);
  start({ ...task, controller: new AbortController(), file: undefined, urls: [] });
}
