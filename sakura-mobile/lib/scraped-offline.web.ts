import { SCRAPED_SOURCES, type ScrapedSource } from '@/lib/scraped-sources';
import { getWebMediaProxyUrl } from '@/lib/content-proxy-client';
import {
  IMAGE_MANIFEST_URL,
  offlinePageUrl,
  openOfflineLibrary,
} from '@/lib/offline-cache-keys';

/**
 * Offline library for the droplet-scraped image sources, on web.
 *
 * This is the `.web.ts` counterpart of lib/scraped-offline.ts and exports
 * BYTE-FOR-BYTE the same surface. That is the entire design: because the shape
 * matches, lib/chapter-pages.ts, app/downloads.tsx and the shared ChapterRow
 * work with zero changes, and the reader has no idea whether a page came from
 * the network or from disk.
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
 *
 * Unlike native, this store can be evicted by the browser. Callers must not
 * present a downloaded chapter as a permanent guarantee — see
 * `getOfflineStorageEstimate` and the copy in the manga screen.
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

// Cache name and URL scheme live in lib/offline-cache-keys.ts so the exporter
// reads exactly what this writes. A drift between them is invisible: the
// write succeeds, the read misses, and the user is told they have nothing.
const MANIFEST_URL = IMAGE_MANIFEST_URL;

/**
 * The droplet's whole direct-fetch budget is 6 across all clients, on a
 * 1-worker nginx that also fronts psyopanime, mangadex, manhwa and media on a
 * 1GB box. Three is a real speedup without being a denial of service for
 * everyone else reading at the same time.
 */
const CONCURRENCY = 3;
const PAGE_TIMEOUT_MS = 20_000;

type Manifest = { chapters: Record<string, OfflineScrapedChapter> };

const mem: Manifest = { chapters: {} };
let loaded = false;
const listeners = new Set<() => void>();
const activeJobs = new Set<string>();
const pausedChapterJobs = new Set<string>();
const canceledChapterJobs = new Set<string>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeScrapedOffline(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function chapterKey(source: ScrapedSource, contentId: string, chapterId: string) {
  return `${source}:${contentId}:${chapterId}`;
}

const pageUrl = offlinePageUrl;
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
      if (parsed && typeof parsed === 'object' && parsed.chapters) {
        Object.assign(mem.chapters, parsed.chapters);
      }
    }
  } catch {
    // A corrupt manifest must not take the app down; the pages are still
    // addressable and a re-download will rewrite it.
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
    // Quota or a private-mode restriction. The in-memory manifest still drives
    // this session; the next successful write reconciles it.
  }
}

export function pauseScrapedChapterDownload(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
) {
  pausedChapterJobs.add(chapterKey(source, contentId, chapterId));
}

export function resumeScrapedChapterDownload(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
) {
  pausedChapterJobs.delete(chapterKey(source, contentId, chapterId));
}

export async function getScrapedOfflineChapter(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
): Promise<OfflineScrapedChapter | undefined> {
  await ensureLoaded();
  return mem.chapters[chapterKey(source, contentId, chapterId)];
}

export async function getScrapedOfflineMap(
  source: ScrapedSource,
  contentId: string,
): Promise<Record<string, OfflineScrapedChapter>> {
  await ensureLoaded();
  const out: Record<string, OfflineScrapedChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.source === source && row.mangaId === contentId) out[row.chapterId] = row;
  }
  return out;
}

export async function listScrapedOfflineChapters(): Promise<OfflineScrapedChapter[]> {
  await ensureLoaded();
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A tab closed mid-download leaves a row claiming to be downloading forever.
 * Only rows older than module load are touched, so a job started by this
 * session is never stolen from itself.
 */
const MODULE_LOADED_AT = Date.now();

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
    await persist();
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
  const cache = await openLibrary();
  if (!cache) return null;
  const uris: string[] = [];
  for (let i = 0; i < row.pageCount; i++) uris.push(pageUrl(source, contentId, chapterId, i));
  if (!uris.length) return null;

  /**
   * Spot-check rather than trusting the manifest, but only the ends.
   *
   * Cache Storage is evicted per-origin and wholesale, so if the first page is
   * gone the whole chapter is gone; the last page catches the other real
   * failure, a write truncated partway. Checking all of them would put N
   * sequential awaits on the reader's critical path — 200 round-trips before a
   * webtoon chapter can render — to defend against a state the storage model
   * does not actually produce.
   *
   * Anything that slips through still degrades safely: the service worker 404s
   * a missing page, so the reader falls back to the network for it rather than
   * showing a broken image.
   */
  const [first, last] = await Promise.all([
    cache.match(uris[0]),
    cache.match(uris[uris.length - 1]),
  ]);
  if (!first || !last) return null;
  return uris;
}

export async function deleteScrapedOfflineChapter(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
) {
  await ensureLoaded();
  const key = chapterKey(source, contentId, chapterId);
  // Stop an in-flight job before removing its rows, or the worker keeps writing
  // pages back in after the delete.
  canceledChapterJobs.add(key);
  const row = mem.chapters[key];
  const cache = await openLibrary();
  if (cache && row) {
    for (let i = 0; i < row.pageCount; i++) {
      // eslint-disable-next-line no-await-in-loop
      await cache.delete(pageUrl(source, contentId, chapterId, i)).catch(() => undefined);
    }
  }
  delete mem.chapters[key];
  await persist();
  notify();
}

export async function getScrapedOfflineStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.chapters)) {
    if (row.status !== 'ready') continue;
    total += row.bytes || 0;
  }
  return total;
}

/**
 * How much room the browser will give us, and whether it can be taken back.
 *
 * Web-only. There is no native equivalent because native storage is not
 * evictable — which is exactly the difference the UI has to communicate.
 */
export async function getOfflineStorageEstimate(): Promise<{
  usedBytes: number;
  quotaBytes: number;
  persisted: boolean;
}> {
  let usedBytes = 0;
  let quotaBytes = 0;
  let persisted = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usedBytes = est.usage || 0;
      quotaBytes = est.quota || 0;
    }
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
    }
  } catch {
    // Reported as zeros; callers treat that as "unknown", not "full".
  }
  return { usedBytes, quotaBytes, persisted };
}

/**
 * Ask the browser to make this origin's storage durable.
 *
 * On Android Chrome an installed PWA is normally granted this without a prompt.
 * It is best-effort and a `false` result is not an error — it means downloads
 * are still kept, but the browser may reclaim them under storage pressure, and
 * the UI says so rather than pretending otherwise.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function fetchPageBytes(
  url: string,
  signalAborted: () => boolean,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    if (signalAborted()) return null;
    const res = await fetch(getWebMediaProxyUrl(url), { signal: ctrl.signal });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadScrapedChapter(opts: {
  source: ScrapedSource;
  contentId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
}): Promise<{ paused?: boolean }> {
  const key = chapterKey(opts.source, opts.contentId, opts.chapterId);
  if (activeJobs.has(key)) return {};
  await ensureLoaded();
  const existing = mem.chapters[key];
  if (existing?.status === 'ready') return {};

  const cache = await openLibrary();
  if (!cache) throw new Error('Offline downloads are not available in this browser.');

  // Ask for durable storage before writing anything. On an installed Android
  // Chrome PWA this is normally granted without a prompt; when it is not, the
  // download still happens but the browser may reclaim it under storage
  // pressure, which is why the Downloads screen says so rather than implying
  // these files are as permanent as the native ones.
  void requestPersistentStorage();

  activeJobs.add(key);
  pausedChapterJobs.delete(key);
  canceledChapterJobs.delete(key);

  let record: OfflineScrapedChapter = {
    source: opts.source,
    mangaId: opts.contentId,
    chapterId: opts.chapterId,
    chapterNumber: opts.chapterNumber,
    chapterTitle: opts.chapterTitle,
    title: opts.title,
    cover: opts.cover,
    status: 'downloading',
    progress: 0,
    pageCount: existing?.pageCount || 0,
    completedPages: 0,
    updatedAt: Date.now(),
    bytes: 0,
  };
  mem.chapters[key] = record;
  await persist();
  notify();

  const update = async (patch: Partial<OfflineScrapedChapter>) => {
    record = { ...record, ...patch, updatedAt: Date.now() };
    mem.chapters[key] = record;
    await persist();
    notify();
  };

  try {
    const def = SCRAPED_SOURCES[opts.source];
    if (!def) throw new Error(`Unknown source "${opts.source}".`);
    const urls = await def.pages(opts.contentId, opts.chapterId);
    if (!urls?.length) throw new Error('No pages found for this chapter.');

    await update({ pageCount: urls.length });

    let bytes = 0;
    let done = 0;
    // Batched so page order is preserved for free and at most CONCURRENCY
    // responses are live at once.
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      if (canceledChapterJobs.has(key)) {
        canceledChapterJobs.delete(key);
        return {};
      }
      if (pausedChapterJobs.has(key)) {
        await update({ status: 'paused' });
        return { paused: true };
      }

      const slice = urls.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        slice.map(async (u, k) => {
          const res = await fetchPageBytes(u, () => canceledChapterJobs.has(key));
          return { index: i + k, res };
        }),
      );

      for (const { index, res } of settled) {
        if (!res) throw new Error('A page could not be downloaded. Check your connection and retry.');
        const blob = await res.blob();
        if (!blob.size) throw new Error('A page came back empty.');
        bytes += blob.size;
        await cache.put(
          pageUrl(opts.source, opts.contentId, opts.chapterId, index),
          new Response(blob, {
            headers: { 'content-type': blob.type || 'image/jpeg' },
          }),
        );
        done++;
      }

      await update({
        completedPages: done,
        progress: done / urls.length,
        bytes,
      });
    }

    await update({ status: 'ready', progress: 1, completedPages: done, bytes });
    return {};
  } catch (e) {
    // A failed job leaves its partial pages behind on purpose: they are
    // addressable, a retry overwrites them, and deleting them here would make
    // every transient network blip cost the user the whole chapter again.
    const message =
      e instanceof DOMException && e.name === 'QuotaExceededError'
        ? 'Your device is out of space for downloads.'
        : e instanceof Error
          ? e.message
          : 'Download failed';
    await update({ status: 'error', error: message });
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}
