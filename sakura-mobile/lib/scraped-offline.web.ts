import { createOfflineJobCoordinator } from '@/lib/offline-job-coordinator';
import { SCRAPED_SOURCES, type ScrapedSource } from '@/lib/scraped-sources';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import {
  IMAGE_MANIFEST_URL,
  OFFLINE_PREFIX,
  offlinePageUrl,
  openOfflineLibrary,
} from '@/lib/offline-cache-keys';
import { deleteOfflineTitle, listOfflineTitles } from '@/lib/offline-titles';
import {
  DEFAULT_PAGE_ATTEMPTS,
  DEFAULT_PAGE_TIMEOUT_MS,
  deleteCacheEntriesUnder,
  ESTIMATED_PAGE_BYTES,
  OfflineDownloadError,
  createNotifier,
  createOfflineManifest,
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

export { getOfflineStorageEstimate, requestPersistentStorage } from '@/lib/offline-image-store.web';

/**
 * Offline library for the droplet-scraped image sources, on web.
 *
 * This is the `.web.ts` counterpart of lib/scraped-offline.ts and exports the
 * same surface (plus the two web-only storage helpers re-exported above). That
 * is the entire design: because the shape matches, lib/chapter-pages.ts,
 * app/downloads.tsx and the shared ChapterRow work with zero changes, and the
 * reader has no idea whether a page came from the network or from disk.
 *
 * IMPORTANT: this file must never import '@/lib/scraped-offline'. On web that
 * specifier resolves to THIS file, and a module importing its own base name is
 * how every Consumet call on web was silently killed once before. Everything
 * here is self-contained.
 *
 * Storage:
 *  - Page bytes live in Cache Storage under same-origin synthetic URLs
 *    (/app/__offline/...), which web/public/sw.js serves. Cache Storage rather
 *    than OPFS specifically so the reader keeps rendering
 *    `<Image source={{ uri }}>` — OPFS would force blob: URL minting and
 *    revocation bookkeeping into the reader.
 *  - The manifest lives in the same cache as one JSON Response, mirroring the
 *    native manifest.json rather than introducing IndexedDB for one object.
 *    Its format and keys are unchanged, so downloads made by earlier builds
 *    keep working.
 *
 * The page loop itself (retries, resume, validation, the throttled manifest)
 * lives in lib/offline-image-store.web.ts, shared with the atsu store.
 *
 * Unlike native, this store can be evicted by the browser. Callers must not
 * present a downloaded chapter as a permanent guarantee — see
 * `getOfflineStorageEstimate` and the copy on the Downloads screen.
 */

export type { ScrapedSource };
export type OfflineScrapedStatus = 'downloading' | 'paused' | 'ready' | 'error';

export interface OfflineScrapedChapter {
  source: ScrapedSource;
  /** Mirrors OfflineMangaChapter so the shared ChapterRow works. */
  mangaId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
  status: OfflineScrapedStatus;
  progress: number;
  pageCount: number;
  completedPages: number;
  error?: string;
  updatedAt: number;
  /** Bytes actually stored. Web-only; native computes this by stat-ing files. */
  bytes?: number;
}

export interface ScrapedBatchJob {
  source: ScrapedSource;
  contentId: string;
  paused: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
}

// Concurrency: the droplet's whole direct-fetch budget is 6 across all
// clients, on a 1-worker nginx that also fronts psyopanime, mangadex, manhwa
// and media on a 1GB box. Three pages in flight (the engine's
// PAGE_CONCURRENCY) is a real speedup without being a denial of service for
// everyone else reading at the same time — and Download-all stays sequential
// per chapter for the same reason.

/**
 * Internet Archive's IIIF server can take tens of seconds to render a page
 * from its source scan, and some pages never answer at all. Comics on web are
 * all Internet Archive titles, so they get a longer deadline than the
 * droplet-proxied sources — and one fewer attempt, because each attempt also
 * tries the smaller rendition (smallerIiifUrl): a page that never answers then
 * costs about three minutes rather than four and a half before the chapter
 * reports it, while the other two workers keep going.
 */
const COMICS_PAGE_TIMEOUT_MS = 45_000;
const COMICS_PAGE_ATTEMPTS = 2;

function pageTimeoutFor(source: ScrapedSource): number {
  return source === 'comics' ? COMICS_PAGE_TIMEOUT_MS : DEFAULT_PAGE_TIMEOUT_MS;
}

function pageAttemptsFor(source: ScrapedSource): number {
  return source === 'comics' ? COMICS_PAGE_ATTEMPTS : DEFAULT_PAGE_ATTEMPTS;
}

/**
 * The same IIIF page at a smaller rendition, or null. A page that hangs at its
 * full size is a different request at another size — rendered and cached
 * separately by the IIIF server — so it is worth one more try before failing
 * the chapter. 800px wide still reads comfortably on a phone.
 */
function smallerIiifUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'iiif.archive.org') return null;
    const m = /^(.*\/full\/)([^/]+)(\/[^/]+\/default\.[a-z]+)$/i.exec(u.pathname);
    if (!m || m[2] === '800,') return null;
    u.pathname = `${m[1]}800,${m[3]}`;
    return u.toString();
  } catch {
    return null;
  }
}

function pageCandidates(url: string): string[] {
  // Adapters already return proxied URLs on web; getWebMediaProxyUrl is
  // idempotent and leaves non-droplet hosts (Internet Archive) alone.
  const primary = getWebMediaProxyUrl(url);
  const smaller = smallerIiifUrl(primary);
  return smaller ? [primary, smaller] : [primary];
}

function chapterKey(source: ScrapedSource, contentId: string, chapterId: string) {
  return `${source}:${contentId}:${chapterId}`;
}

function batchKey(source: ScrapedSource, contentId: string) {
  return `${source}:${contentId}`;
}

const pageUrl = offlinePageUrl;

const MODULE_LOADED_AT = Date.now();

const manifest = createOfflineManifest<OfflineScrapedChapter>({
  url: IMAGE_MANIFEST_URL,
  openCache: openOfflineLibrary,
  // Nothing can be running when the manifest first loads, so a row still
  // marked downloading was left by a closed tab: make it resumable now, not
  // only once the Downloads screen gets round to reconciling it.
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
const batchJobs = new Map<string, ScrapedBatchJob>();

export function subscribeScrapedOffline(fn: () => void): () => void {
  notifier.listeners.add(fn);
  return () => {
    notifier.listeners.delete(fn);
  };
}

function notifyBatch() {
  batchListeners.forEach((fn) => fn());
}

export function subscribeScrapedBatch(fn: () => void): () => void {
  batchListeners.add(fn);
  return () => {
    batchListeners.delete(fn);
  };
}

export function getScrapedBatchState(source: ScrapedSource, contentId: string): ScrapedBatchJob | null {
  return batchJobs.get(batchKey(source, contentId)) ?? null;
}

export function pauseScrapedBatchDownload(source: ScrapedSource, contentId: string): void {
  const job = batchJobs.get(batchKey(source, contentId));
  if (!job || job.paused) return;
  job.paused = true;
  notifyBatch();
}

export function resumeScrapedBatchDownload(source: ScrapedSource, contentId: string): void {
  const job = batchJobs.get(batchKey(source, contentId));
  if (!job?.paused) return;
  job.paused = false;
  notifyBatch();
}

/**
 * Pause is a flag the running job polls between pages. A row left
 * "downloading" by a closed tab has no job to poll it, so flip that row here
 * and tell the listeners — otherwise the screen says "paused" while the row
 * keeps spinning.
 */
export function pauseScrapedChapterDownload(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
) {
  const key = chapterKey(source, contentId, chapterId);
  pausedChapterJobs.add(key);
  const row = mem.chapters[key];
  if (row?.status === 'downloading' && !activeJobs.has(key)) {
    mem.chapters[key] = { ...row, status: 'paused', updatedAt: Date.now() };
    void manifest.persistNow().catch(() => undefined);
  }
  notify();
}

export function resumeScrapedChapterDownload(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
) {
  pausedChapterJobs.delete(chapterKey(source, contentId, chapterId));
}

const verifiedRows = new WeakMap<OfflineScrapedChapter, number>();

async function validateReadyChapter(row: OfflineScrapedChapter, force = false): Promise<boolean> {
  if (row.status !== 'ready') return false;
  if (!force && Date.now() - (verifiedRows.get(row) ?? 0) < 30_000) return true;
  const cache = await openOfflineLibrary();
  const count = Number.isSafeInteger(row.pageCount) && row.pageCount > 0 ? row.pageCount : 0;
  const urls = Array.from({ length: count }, (_, i) => pageUrl(row.source, row.mangaId, row.chapterId, i));
  const stored = cache ? await inspectStoredPages(cache, urls) : { done: 0, bytes: 0 };
  if (count > 0 && stored.done === count) { verifiedRows.set(row, Date.now()); return true; }
  const key = chapterKey(row.source, row.mangaId, row.chapterId);
  if (mem.chapters[key] === row) {
    mem.chapters[key] = { ...row, status: 'error', completedPages: stored.done,
      progress: count ? stored.done / count : 0, bytes: stored.bytes,
      error: 'Some downloaded pages are missing. Retry to repair this chapter.', updatedAt: Date.now() };
    await manifest.persistNow().catch(() => undefined);
    notify();
  }
  return false;
}

export async function getScrapedOfflineChapter(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
): Promise<OfflineScrapedChapter | null> {
  await ensureLoaded();
  const row = mem.chapters[chapterKey(source, contentId, chapterId)];
  if (row?.status === 'ready') await validateReadyChapter(row);
  return mem.chapters[chapterKey(source, contentId, chapterId)] || null;
}

export async function getScrapedOfflineMap(
  source: ScrapedSource,
  contentId: string,
): Promise<Record<string, OfflineScrapedChapter>> {
  await ensureLoaded();
  const out: Record<string, OfflineScrapedChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.source === source && row.mangaId === contentId) {
      if (row.status === 'ready') await validateReadyChapter(row);
      const current = mem.chapters[chapterKey(row.source, row.mangaId, row.chapterId)];
      if (current) out[row.chapterId] = current;
    }
  }
  return out;
}

export async function listScrapedOfflineChapters(): Promise<OfflineScrapedChapter[]> {
  await ensureLoaded();
  for (const row of Object.values(mem.chapters)) {
    if (row.status === 'ready') await validateReadyChapter(row);
  }
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A tab closed mid-download leaves a row claiming to be downloading forever.
 * Loading the manifest now handles that; this remains for the shared call
 * sites and for rows this session lost track of. Only rows older than module
 * load are touched, so a job started by this session is never stolen from
 * itself.
 */
export async function reconcileInterruptedScrapedChapters(): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const [key, row] of Object.entries(mem.chapters)) {
    if (row.status === 'downloading' && row.updatedAt < MODULE_LOADED_AT && !activeJobs.has(key)) {
      mem.chapters[key] = { ...row, status: 'paused', updatedAt: Date.now() };
      changed = true;
    }
  }
  if (changed) {
    await manifest.persistNow();
    notify();
  }
}

export async function getScrapedOfflinePageUris(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
): Promise<string[] | null> {
  const row = await getScrapedOfflineChapter(source, contentId, chapterId);
  if (row?.status !== 'ready') return null;
  // Only the service worker can answer these URLs. In a tab it does not
  // control, the host answers with index.html and every page renders blank;
  // such a tab came from the network, so the network copy is the right one.
  if (!offlineUrlsServable()) return null;
  const cache = await openOfflineLibrary();
  if (!cache) return null;
  const uris: string[] = [];
  for (let i = 0; i < row.pageCount; i++) uris.push(pageUrl(source, contentId, chapterId, i));
  if (!uris.length) return null;

  if (!await validateReadyChapter(row, true)) return null;
  return uris;
}

async function deletePages(
  cache: Cache,
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await cache.delete(pageUrl(source, contentId, chapterId, i));
  }
}

export function deleteScrapedOfflineChapter(source: ScrapedSource, contentId: string, chapterId: string): Promise<void> {
  return chapterJobs.remove(chapterKey(source, contentId, chapterId), async () => {
    await ensureLoaded();
    const key = chapterKey(source, contentId, chapterId);
    // Stop an in-flight job before removing its rows, or the worker keeps writing
    // pages back in after the delete.
    if (activeJobs.has(key)) canceledChapterJobs.add(key);
    pausedChapterJobs.delete(key);
    const row = mem.chapters[key];
    const cache = await openOfflineLibrary();
    if (cache && row) {
      await deletePages(cache, source, contentId, chapterId, Math.max(row.pageCount, row.completedPages));
    }
    delete mem.chapters[key];
    await manifest.persistNow();
    // The series snapshot (lib/offline-titles) goes with its last download.
    const stillHasRows = Object.values(mem.chapters).some(
      (r) => r.source === source && r.mangaId === contentId,
    );
    if (!stillHasRows) await deleteOfflineTitle(source, contentId).catch(() => undefined);
    notify();
  });
}

export function clearAllScrapedOffline(): Promise<void> {
  batchGeneration++;
  return chapterJobs.clear(async () => {
    await ensureLoaded();
    batchJobs.clear();
    pausedChapterJobs.clear();
    const cache = await openOfflineLibrary();
    if (!cache) throw new OfflineDownloadError('unavailable', 'Offline downloads are not available in this browser.');
    for (const source of Object.keys(SCRAPED_SOURCES)) await deleteCacheEntriesUnder(cache, `${OFFLINE_PREFIX}${source}/`);
    mem.chapters = {};
    await manifest.persistNow();
    const titles = await listOfflineTitles();
    await Promise.all(titles.filter((title) => title.source !== 'atsu')
      .map((title) => deleteOfflineTitle(title.source, title.contentId)));
    notify();
    notifyBatch();
  });
}

export async function getScrapedOfflineStorageBytes(): Promise<number> {
  await ensureLoaded();
  // Every row, not only ready ones: a paused or failed chapter keeps the pages
  // it has on purpose, and they occupy the same space.
  let total = 0;
  for (const row of Object.values(mem.chapters)) total += row.bytes || 0;
  return total;
}

/** A page list, with one retry: the comics route 503s transiently under load. */
async function fetchPageList(source: ScrapedSource, contentId: string, chapterId: string): Promise<string[]> {
  const def = SCRAPED_SOURCES[source];
  if (!def) throw new OfflineDownloadError('failed', `Unknown source "${source}".`);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      if (isBrowserOffline()) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    try {
      const urls = (await def.pages(contentId, chapterId))?.filter(Boolean) ?? [];
      if (urls.length) return urls;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
  }
  if (isBrowserOffline()) {
    throw new OfflineDownloadError('offline', "You're offline. Reconnect, then try again.");
  }
  if (lastError) {
    const detail = lastError instanceof Error && lastError.message ? ` (${lastError.message})` : '';
    throw new OfflineDownloadError(
      'failed',
      `This chapter's pages could not be loaded${detail}. Try again in a moment.`,
    );
  }
  throw new OfflineDownloadError('failed', 'No pages found for this chapter.');
}

export function downloadScrapedChapter(opts: Parameters<typeof runDownloadScrapedChapter>[0]): Promise<{ paused?: boolean }> {
  return chapterJobs.run(chapterKey(opts.source, opts.contentId, opts.chapterId), () => runDownloadScrapedChapter(opts));
}

async function runDownloadScrapedChapter(opts: {
  source: ScrapedSource;
  contentId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
}): Promise<{ paused?: boolean }> {
  const key = chapterKey(opts.source, opts.contentId, opts.chapterId);
  // Claimed synchronously, before the first await, so a double tap cannot
  // start two workers on the same chapter.
  if (activeJobs.has(key)) return {};
  activeJobs.add(key);
  pausedChapterJobs.delete(key);
  canceledChapterJobs.delete(key);

  let record: OfflineScrapedChapter | null = null;
  // Progress ticks update memory and listeners at once and the manifest on a
  // timer; status changes write through immediately.
  const update = (patch: Partial<OfflineScrapedChapter>, write: 'now' | 'soon') => {
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
    // Ask for durable storage before writing anything. On an installed Android
    // Chrome PWA this is normally granted without a prompt; when it is not, the
    // download still happens but the browser may reclaim it under storage
    // pressure, which is why the Downloads screen says so rather than implying
    // these files are as permanent as the native ones.
    void requestPersistentStorage();
    warmOfflineShell();

    // Deleted while the checks above were awaiting: writing the row now would
    // resurrect it.
    if (canceledChapterJobs.has(key)) return {};
    // A retry or resume keeps the pages it already has (the engine skips
    // them), so start the counters from what the row last knew.
    record = {
      source: opts.source,
      mangaId: opts.contentId,
      chapterId: opts.chapterId,
      chapterNumber: opts.chapterNumber,
      chapterTitle: opts.chapterTitle,
      title: opts.title,
      cover: opts.cover,
      status: 'downloading',
      progress: existing?.progress ?? 0,
      pageCount: existing?.pageCount || 0,
      completedPages: existing?.completedPages ?? 0,
      updatedAt: Date.now(),
      bytes: existing?.bytes ?? 0,
    };
    mem.chapters[key] = record;
    await manifest.persistNow();
    notify();

    const urls = await fetchPageList(opts.source, opts.contentId, opts.chapterId);
    await update({ pageCount: urls.length }, 'now');

    const result = await downloadPagesToCache({
      cache,
      urls,
      keyFor: (i) => pageUrl(opts.source, opts.contentId, opts.chapterId, i),
      candidatesFor: pageCandidates,
      timeoutMs: pageTimeoutFor(opts.source),
      attempts: pageAttemptsFor(opts.source),
      shouldStop: () =>
        canceledChapterJobs.has(key) ? 'canceled' : pausedChapterJobs.has(key) ? 'paused' : null,
      onProgress: (done, bytes) => {
        void update({ completedPages: done, progress: done / urls.length, bytes }, 'soon');
      },
    });

    if (result.outcome === 'canceled') {
      // Deleted mid-download. A worker may have finished a page after the
      // delete swept, so sweep once more; the row itself is already gone.
      await deletePages(cache, opts.source, opts.contentId, opts.chapterId, urls.length);
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
      { status: 'ready', progress: 1, completedPages: urls.length, bytes: result.bytes, error: undefined },
      'now',
    );
    return {};
  } catch (e) {
    if (canceledChapterJobs.has(key)) return {};
    // A failed job leaves its partial pages behind on purpose: they are
    // addressable, the next attempt skips them, and deleting them here would
    // make every transient network blip cost the user the whole chapter again.
    const err = toOfflineDownloadError(e);
    if (record) await update({ status: 'error', error: err.message }, 'now').catch(() => undefined);
    throw err;
  } finally {
    activeJobs.delete(key);
    canceledChapterJobs.delete(key);
  }
}

/**
 * Download every chapter of a title, one chapter at a time.
 *
 * Mirrors downloadAllMangaChapters: sequential, chapters already downloaded
 * count as done, pause/resume through the batch state, `paused: true` when it
 * stops early. Sequential is deliberate — each chapter already keeps three
 * pages in flight, which is the droplet's share for one client.
 *
 * Web-only difference: an error that would fail every remaining chapter the
 * same way (out of space, offline, no storage) pauses the batch and rejects
 * with that error, rather than grinding through hundreds of doomed chapters
 * with a toast at the end. The batch stays paused, so the screen offers
 * Resume; chapters already downloaded by then return at once.
 */
export function downloadAllScrapedChapters(opts: Parameters<typeof runDownloadAllScrapedChapters>[0]): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const key = batchKey(opts.source, opts.contentId);
  const existing = activeBatches.get(key);
  if (existing) return existing;
  const generation = batchGeneration;
  const task = runDownloadAllScrapedChapters(opts, generation);
  activeBatches.set(key, task);
  const release = () => { if (activeBatches.get(key) === task) activeBatches.delete(key); };
  void task.then(release, release);
  return task;
}

async function runDownloadAllScrapedChapters(opts: {
  source: ScrapedSource;
  contentId: string;
  title: string;
  cover: string;
  chapters: Array<{ id: string; number: number; title: string }>;
  onChapterStart?: (chapterNumber: number) => void;
}, generation: number): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const bKey = batchKey(opts.source, opts.contentId);
  const list = opts.chapters;
  const existing = batchJobs.get(bKey);
  const startIndex = existing?.paused ? existing.done : 0;
  let ok = existing?.paused ? existing.ok : 0;
  let failed = existing?.paused ? existing.failed : 0;

  batchJobs.set(bKey, {
    source: opts.source,
    contentId: opts.contentId,
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
      if (batchJobs.get(bKey)?.paused) {
        const job = batchJobs.get(bKey)!;
        job.done = i;
        endedPaused = true;
        notifyBatch();
        return { ok, failed, paused: true };
      }

      const ch = list[i];
      opts.onChapterStart?.(ch.number);

      try {
        const result = await downloadScrapedChapter({
          source: opts.source,
          contentId: opts.contentId,
          chapterId: ch.id,
          chapterNumber: ch.number,
          chapterTitle: ch.title,
          title: opts.title,
          cover: opts.cover,
        });
        if (result.paused) {
          pauseScrapedBatchDownload(opts.source, opts.contentId);
          const job = batchJobs.get(bKey);
          if (job) job.done = i;
          endedPaused = true;
          return { ok, failed, paused: true };
        }
        if (generation !== batchGeneration) return { ok, failed };
        ok += 1;
      } catch (e) {
        if (isFatalDownloadError(e)) {
          const job = batchJobs.get(bKey);
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

      const job = batchJobs.get(bKey);
      if (job) {
        job.done = i + 1;
        job.ok = ok;
        job.failed = failed;
        notifyBatch();
      }

      if (batchJobs.get(bKey)?.paused) {
        endedPaused = true;
        return { ok, failed, paused: true };
      }
    }
    return { ok, failed };
  } finally {
    if (!endedPaused) {
      batchJobs.delete(bKey);
      notifyBatch();
    }
  }
}
