import { createOfflineJobCoordinator } from '@/lib/offline-job-coordinator';
import { fetchMangaChapterPages } from '@/lib/manga';
import {
  atsuPageCdnUrl,
  getWebMangaPageFallbackUrl,
  getWebMangaPageProxyUrl,
} from '@/lib/content-proxy-client';
import {
  MANGA_MANIFEST_URL,
  OFFLINE_PREFIX,
  offlineMangaPageUrl,
  openOfflineLibrary,
} from '@/lib/offline-cache-keys';
import { deleteOfflineTitle, listOfflineTitles } from '@/lib/offline-titles';
import {
  DEFAULT_PAGE_TIMEOUT_MS,
  ESTIMATED_PAGE_BYTES,
  OfflineDownloadError,
  createNotifier,
  createOfflineManifest,
  deleteCacheEntriesUnder,
  downloadPagesToCache,
  ensureStorageRoom,
  isBrowserOffline,
  isFatalDownloadError,
  inspectStoredPages,
  offlineUrlsServable,
  requestPersistentStorage,
  toOfflineDownloadError,
  warmOfflineShell,
} from '@/lib/offline-image-store.web';

/**
 * Offline library for atsu (the default manga source), on web.
 *
 * The `.web.ts` counterpart of lib/manga-offline.ts, exporting the same
 * surface with the same names and types. Before it existed, web bundled the
 * native module: its manifest went to a localStorage shim, it fetched
 * atsu.moe/api straight from the browser (no CORS header, so "Failed to
 * fetch"), and its FileSystem.downloadAsync is a shim that always throws — so
 * the atsu Download buttons were hidden on web altogether. Because the shape
 * matches, lib/chapter-pages.ts, app/downloads.tsx, the settings screen and
 * the manga page pick this store up with no call-site changes.
 *
 * IMPORTANT: never import '@/lib/manga-offline' here. On web that specifier
 * resolves to THIS file.
 *
 * Storage follows lib/scraped-offline.web.ts: page bytes in Cache Storage
 * (LIBRARY_CACHE) under same-origin /app/__offline/atsu/… URLs that
 * web/public/sw.js serves, so the reader keeps rendering `<Image source={{ uri
 * }}>`; the manifest is one JSON Response at MANGA_MANIFEST_URL. Rows written
 * by an earlier build's localStorage shim ('sakura-web-fs-v1') are not read:
 * no download ever completed there.
 *
 * Getting the bytes: the page list comes from fetchMangaChapterPages, whose
 * atsu call goes through the Supabase content proxy on web; each page is then
 * fetched from the same-origin /api/manga-page/ proxy, falling back to the
 * droplet's image route (see getWebMangaPageFallbackUrl). Unlike native, this
 * store can be evicted by the browser; the Downloads screen says so.
 */

export type OfflineMangaStatus = 'downloading' | 'paused' | 'ready' | 'error';

export interface OfflineMangaChapter {
  mangaId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
  status: OfflineMangaStatus;
  progress: number;
  pageCount: number;
  completedPages: number;
  error?: string;
  updatedAt: number;
  /** Bytes actually stored. Web-only; native computes this by stat-ing files. */
  bytes?: number;
}

/** Same shape as the native (unexported) MangaBatchJob. */
type MangaBatchJob = {
  mangaId: string;
  paused: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
};

const ATSU_PAGES_PATH = `${OFFLINE_PREFIX}atsu/`;

function chapterKey(mangaId: string, chapterId: string) {
  return `${mangaId}::${chapterId}`;
}

const MODULE_LOAD_TIME = Date.now();

const manifest = createOfflineManifest<OfflineMangaChapter>({
  url: MANGA_MANIFEST_URL,
  openCache: openOfflineLibrary,
  // Nothing can be running yet when the manifest first loads, so any row still
  // marked downloading was left by a closed tab. Make it resumable here rather
  // than only when the Downloads screen happens to reconcile, or the manga
  // page shows a spinner that never moves and its tap says "paused" while the
  // row does not change.
  onLoad: (rows) => {
    let changed = false;
    for (const [key, row] of Object.entries(rows)) {
      if (row.status === 'downloading') {
        rows[key] = { ...row, status: 'paused', updatedAt: Date.now() };
        changed = true;
      }
    }
    return changed;
  },
});
const mem = manifest.state;
const ensureLoaded = manifest.ensureLoaded;

const notifier = createNotifier();
const listeners = notifier.listeners;
const notify = notifier.notify;
const batchListeners = new Set<() => void>();
const activeJobs = new Set<string>();
const pausedChapterJobs = new Set<string>();
const canceledChapterJobs = new Set<string>();
const chapterJobs = createOfflineJobCoordinator<{ paused?: boolean }>({
  canceledResult: () => ({}),
  onCancel: (key) => canceledChapterJobs.add(key),
});
let batchGeneration = 0;
const activeBatches = new Map<string, Promise<{ ok: number; failed: number; paused?: boolean }>>();
const batchJobs = new Map<string, MangaBatchJob>();
/** Batches told to stop for good (Clear all), as opposed to pause. */
const canceledBatches = new Set<string>();

function notifyBatch() {
  batchListeners.forEach((fn) => fn());
}

export function subscribeMangaBatch(fn: () => void) {
  batchListeners.add(fn);
  return () => batchListeners.delete(fn);
}

export function getMangaBatchState(mangaId: string): MangaBatchJob | null {
  return batchJobs.get(mangaId) ?? null;
}

export function pauseMangaBatchDownload(mangaId: string) {
  const job = batchJobs.get(mangaId);
  if (!job || job.paused) return;
  job.paused = true;
  notifyBatch();
}

export function resumeMangaBatchDownload(mangaId: string) {
  const job = batchJobs.get(mangaId);
  if (!job?.paused) return;
  job.paused = false;
  notifyBatch();
}

/**
 * Pause is a flag the running job polls between pages. When no job is running
 * in this tab — a row left "downloading" by a closed tab that has not been
 * reconciled yet — there is nothing to poll it, so flip the row here; that is
 * the case where the manga page used to say "Download paused" while the row
 * kept spinning.
 */
export function pauseMangaChapterDownload(mangaId: string, chapterId: string) {
  const key = chapterKey(mangaId, chapterId);
  pausedChapterJobs.add(key);
  const row = mem.chapters[key];
  if (row?.status === 'downloading' && !activeJobs.has(key)) {
    mem.chapters[key] = { ...row, status: 'paused', updatedAt: Date.now() };
    void manifest.persistNow().catch(() => undefined);
  }
  notify();
}

export function resumeMangaChapterDownload(mangaId: string, chapterId: string) {
  pausedChapterJobs.delete(chapterKey(mangaId, chapterId));
}

export function isMangaChapterPaused(mangaId: string, chapterId: string): boolean {
  return pausedChapterJobs.has(chapterKey(mangaId, chapterId));
}

export function subscribeOfflineManga(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Same contract as native: the chapter's page URLs, or a rejection. On web
 * they are same-origin /api/manga-page/ URLs (see fetchMangaChapterPages).
 */
export async function fetchChapterPageUrls(mangaId: string, chapterId: string): Promise<string[]> {
  let urls = await fetchMangaChapterPages(mangaId, chapterId);
  if (!urls.length && !isBrowserOffline()) {
    // fetchMangaChapterPages folds every failure into []; one quick retry
    // rides out a cold Supabase edge function, the common transient here.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    urls = await fetchMangaChapterPages(mangaId, chapterId);
  }
  if (!urls.length) {
    throw isBrowserOffline()
      ? new OfflineDownloadError('offline', "You're offline. Reconnect, then try again.")
      : new OfflineDownloadError('failed', 'Could not load this chapter. Try again in a moment.');
  }
  return urls;
}

const verifiedRows = new WeakMap<OfflineMangaChapter, number>();

async function validateReadyChapter(row: OfflineMangaChapter, force = false): Promise<boolean> {
  if (row.status !== 'ready') return false;
  if (!force && Date.now() - (verifiedRows.get(row) ?? 0) < 30_000) return true;
  const cache = await openOfflineLibrary();
  const count = Number.isSafeInteger(row.pageCount) && row.pageCount > 0 ? row.pageCount : 0;
  const urls = Array.from({ length: count }, (_, i) => offlineMangaPageUrl(row.mangaId, row.chapterId, i));
  const stored = cache ? await inspectStoredPages(cache, urls) : { done: 0, bytes: 0 };
  if (count > 0 && stored.done === count) { verifiedRows.set(row, Date.now()); return true; }
  const key = chapterKey(row.mangaId, row.chapterId);
  if (mem.chapters[key] === row) {
    mem.chapters[key] = { ...row, status: 'error', completedPages: stored.done,
      progress: count ? stored.done / count : 0, bytes: stored.bytes,
      error: 'Some downloaded pages are missing. Retry to repair this chapter.', updatedAt: Date.now() };
    await manifest.persistNow().catch(() => undefined);
    notify();
  }
  return false;
}

export async function getOfflineMangaChapter(
  mangaId: string,
  chapterId: string,
): Promise<OfflineMangaChapter | null> {
  await ensureLoaded();
  const row = mem.chapters[chapterKey(mangaId, chapterId)];
  if (row?.status === 'ready') await validateReadyChapter(row);
  return mem.chapters[chapterKey(mangaId, chapterId)] || null;
}

/** Single manifest scan — avoids N lookups when rendering long chapter lists. */
export async function getOfflineMapForManga(
  mangaId: string,
): Promise<Record<string, OfflineMangaChapter>> {
  await ensureLoaded();
  const map: Record<string, OfflineMangaChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.mangaId === mangaId) {
      if (row.status === 'ready') await validateReadyChapter(row);
      const current = mem.chapters[chapterKey(row.mangaId, row.chapterId)];
      if (current) map[row.chapterId] = current;
    }
  }
  return map;
}

export async function listOfflineMangaChapters(): Promise<OfflineMangaChapter[]> {
  await ensureLoaded();
  for (const row of Object.values(mem.chapters)) {
    if (row.status === 'ready') await validateReadyChapter(row);
  }
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Kept for the shared call sites. Loading the manifest already does this; what
 * remains is any row this session started and then lost track of.
 */
export async function reconcileInterruptedMangaChapters(): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const [key, row] of Object.entries(mem.chapters)) {
    if (row.status === 'downloading' && row.updatedAt < MODULE_LOAD_TIME && !activeJobs.has(key)) {
      mem.chapters[key] = { ...row, status: 'paused', updatedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) {
    await manifest.persistNow();
    notify();
  }
}

export async function getOfflineMangaPageUris(
  mangaId: string,
  chapterId: string,
): Promise<string[] | null> {
  const row = await getOfflineMangaChapter(mangaId, chapterId);
  if (row?.status !== 'ready' || !row.pageCount) return null;
  // Only the service worker can answer these URLs; see offlineUrlsServable.
  if (!offlineUrlsServable()) return null;
  const cache = await openOfflineLibrary();
  if (!cache) return null;
  const uris: string[] = [];
  for (let i = 0; i < row.pageCount; i++) uris.push(offlineMangaPageUrl(mangaId, chapterId, i));
  if (!await validateReadyChapter(row, true)) return null;
  return uris;
}

async function deletePages(cache: Cache, mangaId: string, chapterId: string, count: number) {
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await cache.delete(offlineMangaPageUrl(mangaId, chapterId, i));
  }
}

/** The series snapshot goes with its last download (lib/offline-titles). */
async function forgetTitleIfUnused(mangaId: string) {
  if (Object.values(mem.chapters).some((row) => row.mangaId === mangaId)) return;
  await deleteOfflineTitle('atsu', mangaId).catch(() => undefined);
}

export function deleteOfflineMangaChapter(mangaId: string, chapterId: string): Promise<void> {
  return chapterJobs.remove(chapterKey(mangaId, chapterId), async () => {
    await ensureLoaded();
    const key = chapterKey(mangaId, chapterId);
    // Stop an in-flight job before removing its pages, or its workers keep
    // writing pages back in after the delete.
    if (activeJobs.has(key)) canceledChapterJobs.add(key);
    pausedChapterJobs.delete(key);
    const row = mem.chapters[key];
    const cache = await openOfflineLibrary();
    if (cache && row) await deletePages(cache, mangaId, chapterId, Math.max(row.pageCount, row.completedPages));
    delete mem.chapters[key];
    await manifest.persistNow();
    await forgetTitleIfUnused(mangaId);
    notify();
  });
}

export function clearAllOfflineManga(): Promise<void> {
  batchGeneration++;
  return chapterJobs.clear(async () => {
    await ensureLoaded();
    for (const key of activeJobs) canceledChapterJobs.add(key);
    // A running batch sees the flag at its next chapter and stops; a paused one
    // is dropped outright, or a later Download all would resume it from a stale
    // position.
    for (const mangaId of batchJobs.keys()) canceledBatches.add(mangaId);
    batchJobs.clear();
    pausedChapterJobs.clear();
    const cache = await openOfflineLibrary();
    // By prefix rather than by manifest row, so pages orphaned by an older build
    // or an interrupted delete go too.
    if (cache) await deleteCacheEntriesUnder(cache, ATSU_PAGES_PATH);
    mem.chapters = {};
    await manifest.persistNow();
    const titles = await listOfflineTitles().catch(() => []);
    await Promise.all(
      titles
        .filter((t) => t.source === 'atsu')
        .map((t) => deleteOfflineTitle('atsu', t.contentId).catch(() => undefined)),
    );
    notify();
    notifyBatch();
  });
}

export async function getOfflineMangaStorageBytes(): Promise<number> {
  await ensureLoaded();
  // Every row, not only ready ones: a paused or failed chapter keeps the pages
  // it has on purpose, and they occupy the same space.
  let total = 0;
  for (const row of Object.values(mem.chapters)) total += row.bytes || 0;
  return total;
}

/**
 * Where to fetch one page: the same-origin page proxy, then the droplet route.
 * Anything that is not an atsu page URL (never expected on web — the MangaDex
 * fallback is native-only) is tried as-is and fails on its own terms.
 */
function pageCandidates(url: string): string[] {
  const cdn = atsuPageCdnUrl(url);
  if (!cdn) return [url];
  return [getWebMangaPageProxyUrl(cdn), getWebMangaPageFallbackUrl(cdn)];
}

export function downloadMangaChapter(opts: Parameters<typeof runDownloadMangaChapter>[0]): Promise<{ paused?: boolean }> {
  return chapterJobs.run(chapterKey(opts.mangaId, opts.chapterId), () => runDownloadMangaChapter(opts));
}

async function runDownloadMangaChapter(opts: {
  mangaId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
}): Promise<{ paused?: boolean }> {
  const key = chapterKey(opts.mangaId, opts.chapterId);
  // Claimed synchronously, before the first await, so a double tap cannot
  // start two workers on the same chapter.
  if (activeJobs.has(key)) return {};
  activeJobs.add(key);
  pausedChapterJobs.delete(key);
  canceledChapterJobs.delete(key);

  let record: OfflineMangaChapter | null = null;
  // Progress ticks update memory and listeners at once and the manifest on a
  // timer; status changes write through immediately.
  const update = (patch: Partial<OfflineMangaChapter>, write: 'now' | 'soon') => {
    if (!record || canceledChapterJobs.has(key)) return Promise.resolve();
    record = { ...record, ...patch, updatedAt: Date.now() };
    mem.chapters[key] = record;
    if (write === 'now') {
      notify();
      return manifest.persistNow();
    }
    notifier.notifySoon();
    manifest.persistSoon();
    return Promise.resolve();
  };

  try {
    await ensureLoaded();
    const existing = mem.chapters[key];
    if (existing?.status === 'ready' && await validateReadyChapter(existing, true)) return {};

    const cache = await openOfflineLibrary();
    if (!cache) {
      throw new OfflineDownloadError('unavailable', 'Offline downloads are not available in this browser.');
    }
    await ensureStorageRoom(Math.max(existing?.pageCount || 0, 20) * ESTIMATED_PAGE_BYTES);
    // Durable storage before writing anything. When it is not granted the
    // download still happens, but the browser may reclaim it under pressure,
    // which the Downloads screen says rather than implying it is permanent.
    void requestPersistentStorage();
    warmOfflineShell();

    // Deleted while the checks above were awaiting: writing the row now would
    // resurrect it.
    if (canceledChapterJobs.has(key)) return {};
    const resuming = existing?.status === 'paused';
    record = {
      mangaId: opts.mangaId,
      chapterId: opts.chapterId,
      chapterNumber: opts.chapterNumber,
      chapterTitle: opts.chapterTitle,
      title: opts.title,
      cover: opts.cover,
      status: 'downloading',
      progress: resuming ? existing.progress : 0,
      pageCount: existing?.pageCount ?? 0,
      completedPages: resuming ? existing.completedPages : 0,
      bytes: existing?.bytes ?? 0,
      updatedAt: Date.now(),
    };
    mem.chapters[key] = record;
    await manifest.persistNow();
    notify();

    const urls = await fetchChapterPageUrls(opts.mangaId, opts.chapterId);
    await update({ pageCount: urls.length }, 'now');

    const result = await downloadPagesToCache({
      cache,
      urls,
      keyFor: (i) => offlineMangaPageUrl(opts.mangaId, opts.chapterId, i),
      candidatesFor: pageCandidates,
      timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
      shouldStop: () =>
        canceledChapterJobs.has(key) ? 'canceled' : pausedChapterJobs.has(key) ? 'paused' : null,
      onProgress: (done, bytes) => {
        void update({ completedPages: done, progress: done / urls.length, bytes }, 'soon');
      },
    });

    if (result.outcome === 'canceled') {
      // Deleted mid-download. A worker may have finished a page after the
      // delete swept, so sweep once more; the row itself is already gone.
      await deletePages(cache, opts.mangaId, opts.chapterId, urls.length);
      return {};
    }
    if (result.outcome === 'paused') {
      await update(
        { status: 'paused', completedPages: result.done, progress: result.done / urls.length, bytes: result.bytes },
        'now',
      );
      return { paused: true };
    }
    await update(
      {
        status: 'ready',
        progress: 1,
        completedPages: urls.length,
        bytes: result.bytes,
        error: undefined,
      },
      'now',
    );
    return {};
  } catch (e) {
    if (canceledChapterJobs.has(key)) return {};
    const err = toOfflineDownloadError(e);
    // Partial pages stay on purpose: the next attempt skips them.
    if (record) await update({ status: 'error', error: err.message }, 'now').catch(() => undefined);
    throw err;
  } finally {
    activeJobs.delete(key);
    canceledChapterJobs.delete(key);
  }
}

/**
 * Same semantics as native: sequential chapters, ones already downloaded count
 * as done, pause/resume through the batch state. One web-only difference: an
 * error that would fail every remaining chapter the same way (out of space,
 * offline, no storage) pauses the batch and rejects with that error, instead
 * of grinding through a few hundred doomed chapters. The batch stays paused,
 * so the screen offers Resume; chapters already downloaded by then return at
 * once, so resuming costs nothing for them.
 */
export function downloadAllMangaChapters(opts: Parameters<typeof runDownloadAllMangaChapters>[0]): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const key = opts.mangaId;
  const existing = activeBatches.get(key);
  if (existing) return existing;
  const generation = batchGeneration;
  const task = runDownloadAllMangaChapters(opts, generation);
  activeBatches.set(key, task);
  const release = () => { if (activeBatches.get(key) === task) activeBatches.delete(key); };
  void task.then(release, release);
  return task;
}

async function runDownloadAllMangaChapters(opts: {
  mangaId: string;
  title: string;
  cover: string;
  chapters: Array<{ id: string; number: number; title: string }>;
  onChapterStart?: (chapterNumber: number) => void;
}, generation: number): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const list = opts.chapters;
  const existing = batchJobs.get(opts.mangaId);
  const startIndex = existing?.paused ? existing.done : 0;
  let ok = existing?.paused ? existing.ok : 0;
  let failed = existing?.paused ? existing.failed : 0;
  canceledBatches.delete(opts.mangaId);

  batchJobs.set(opts.mangaId, {
    mangaId: opts.mangaId,
    paused: false,
    done: startIndex,
    total: list.length,
    ok,
    failed,
  });
  notifyBatch();

  let endedPaused = false;
  try {
    for (let i = startIndex; i < list.length; i++) {
      if (generation !== batchGeneration) return { ok, failed };
      if (canceledBatches.has(opts.mangaId)) return { ok, failed };
      if (batchJobs.get(opts.mangaId)?.paused) {
        const job = batchJobs.get(opts.mangaId)!;
        job.done = i;
        endedPaused = true;
        notifyBatch();
        return { ok, failed, paused: true };
      }

      const ch = list[i];
      opts.onChapterStart?.(ch.number);

      try {
        const result = await downloadMangaChapter({
          mangaId: opts.mangaId,
          chapterId: ch.id,
          chapterNumber: ch.number,
          chapterTitle: ch.title,
          title: opts.title,
          cover: opts.cover,
        });
        if (result.paused) {
          pauseMangaBatchDownload(opts.mangaId);
          const job = batchJobs.get(opts.mangaId);
          if (job) job.done = i;
          endedPaused = true;
          return { ok, failed, paused: true };
        }
        if (generation !== batchGeneration) return { ok, failed };
        ok += 1;
      } catch (e) {
        if (isFatalDownloadError(e) && !canceledBatches.has(opts.mangaId)) {
          const job = batchJobs.get(opts.mangaId);
          if (job) {
            job.paused = true;
            job.done = i;
            job.ok = ok;
            job.failed = failed;
          }
          endedPaused = true;
          notifyBatch();
          throw toOfflineDownloadError(e);
        }
        failed += 1;
      }

      const job = batchJobs.get(opts.mangaId);
      if (job) {
        job.done = i + 1;
        job.ok = ok;
        job.failed = failed;
        notifyBatch();
      }

      if (batchJobs.get(opts.mangaId)?.paused) {
        endedPaused = true;
        return { ok, failed, paused: true };
      }
    }
    return { ok, failed };
  } finally {
    if (!endedPaused || canceledBatches.has(opts.mangaId)) {
      batchJobs.delete(opts.mangaId);
      canceledBatches.delete(opts.mangaId);
      notifyBatch();
    }
  }
}
