import { createOfflineJobCoordinator } from '@/lib/offline-job-coordinator';
import * as FileSystem from 'expo-file-system/legacy';
import { SCRAPED_SOURCES, type ScrapedSource } from '@/lib/scraped-sources';
import { deleteOfflineTitle, listOfflineTitles } from '@/lib/offline-titles';

// Offline store for the droplet-scraped image sources (comics, 18+/hentai and
// manhwa). Mirrors manga-offline.ts but is keyed by source so a single lib
// backs all of them. The chapter record is intentionally shape-compatible with
// OfflineMangaChapter (same field names) so the manga detail screen can reuse
// its offlineMap/row UI.

// Re-exported so existing importers keep working; the union itself now lives
// with the source registry, which is what guarantees a new source can't be
// added without every consumer being forced to handle it.
export type { ScrapedSource };
export type OfflineScrapedStatus = 'downloading' | 'paused' | 'ready' | 'error';

export interface OfflineScrapedChapter {
  source: ScrapedSource;
  // `mangaId` mirrors OfflineMangaChapter so the shared ChapterRow works; it holds
  // the comic/gallery id.
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
}

/** Progress of a Download-all for one title. Same shape on web. */
export interface ScrapedBatchJob {
  source: ScrapedSource;
  contentId: string;
  paused: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
}

const ROOT = `${FileSystem.documentDirectory}sakura_scraped_offline/`;
const MANIFEST = `${ROOT}manifest.json`;

type Manifest = { chapters: Record<string, OfflineScrapedChapter> };

const mem: Manifest = { chapters: {} };
let loading: Promise<void> | null = null;
let writing = Promise.resolve();
const listeners = new Set<() => void>();
const batchListeners = new Set<() => void>();
const activeJobs = new Set<string>();
const canceledChapterJobs = new Set<string>();
const chapterJobs = createOfflineJobCoordinator<{ paused?: boolean }>({
  canceledResult: () => ({}),
  onCancel: (key) => canceledChapterJobs.add(key),
});
let batchGeneration = 0;
const activeBatches = new Map<string, Promise<{ ok: number; failed: number; paused?: boolean }>>();
const pausedChapterJobs = new Set<string>();
const batchJobs = new Map<string, ScrapedBatchJob>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeScrapedOffline(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyBatch() {
  batchListeners.forEach((fn) => fn());
}

function batchKey(source: ScrapedSource, contentId: string) {
  return `${source}::${contentId}`;
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

function chapterKey(source: ScrapedSource, contentId: string, chapterId: string) {
  return `${source}::${contentId}::${chapterId}`;
}

function dirFor(source: ScrapedSource, contentId: string, chapterId: string) {
  return `${ROOT}${source}/${encodeURIComponent(contentId)}/${encodeURIComponent(chapterId)}/`;
}

function ensureLoaded(): Promise<void> {
  if (!loading) loading = (async () => {
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
    try {
      const info = await FileSystem.getInfoAsync(MANIFEST);
      if (info.exists) {
        const raw = JSON.parse(await FileSystem.readAsStringAsync(MANIFEST));
        if (raw?.chapters && typeof raw.chapters === 'object' && !Array.isArray(raw.chapters)) {
          for (const [key, value] of Object.entries(raw.chapters)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const row = value as Manifest['chapters'][string];
              mem.chapters[key] = row.status === 'downloading' ? { ...row, status: 'paused' } : row;
            }
          }
        }
      }
    } catch {
      // A corrupt manifest must not stop a fresh download.
    }
  })().catch((error) => { loading = null; throw error; });
  return loading;
}

function persist(): Promise<void> {
  const write = writing.then(async () => {
    await FileSystem.writeAsStringAsync(MANIFEST, JSON.stringify(mem));
    notify();
  });
  writing = write.catch(() => undefined);
  return write;
}

async function patch(record: OfflineScrapedChapter) {
  if (canceledChapterJobs.has(chapterKey(record.source, record.mangaId, record.chapterId))) return;
  mem.chapters[chapterKey(record.source, record.mangaId, record.chapterId)] = record;
  await persist();
}

async function fileHasContent(path: string, minBytes = 100): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists && 'size' in info && typeof info.size === 'number' && info.size >= minBytes;
  } catch {
    return false;
  }
}

function fetchPageUrls(source: ScrapedSource, contentId: string, chapterId: string): Promise<string[]> {
  return SCRAPED_SOURCES[source].pages(contentId, chapterId);
}

export function pauseScrapedChapterDownload(source: ScrapedSource, contentId: string, chapterId: string) {
  pausedChapterJobs.add(chapterKey(source, contentId, chapterId));
}

export function resumeScrapedChapterDownload(source: ScrapedSource, contentId: string, chapterId: string) {
  pausedChapterJobs.delete(chapterKey(source, contentId, chapterId));
}

export async function getScrapedOfflineChapter(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
): Promise<OfflineScrapedChapter | null> {
  await ensureLoaded();
  return mem.chapters[chapterKey(source, contentId, chapterId)] || null;
}

/** Single manifest scan keyed by chapterId, for the detail screen's chapter list. */
export async function getScrapedOfflineMap(
  source: ScrapedSource,
  contentId: string,
): Promise<Record<string, OfflineScrapedChapter>> {
  await ensureLoaded();
  const map: Record<string, OfflineScrapedChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.source === source && row.mangaId === contentId) map[row.chapterId] = row;
  }
  return map;
}

export async function listScrapedOfflineChapters(): Promise<OfflineScrapedChapter[]> {
  await ensureLoaded();
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

const MODULE_LOAD_TIME = Date.now();
let reconciledInterrupted = false;

/** On launch, flip any leftover `downloading` row (killed session) to `paused`. */
export async function reconcileInterruptedScrapedChapters(): Promise<void> {
  if (reconciledInterrupted) return;
  reconciledInterrupted = true;
  try {
    await ensureLoaded();
    let changed = false;
    for (const row of Object.values(mem.chapters)) {
      if (row.status === 'downloading' && row.updatedAt < MODULE_LOAD_TIME) {
        mem.chapters[chapterKey(row.source, row.mangaId, row.chapterId)] = {
          ...row,
          status: 'paused',
          updatedAt: Date.now(),
        };
        changed = true;
      }
    }
    if (changed) {
      await persist();
      notify();
    }
  } catch {
    // best-effort
  }
}

export async function getScrapedOfflinePageUris(
  source: ScrapedSource,
  contentId: string,
  chapterId: string,
): Promise<string[] | null> {
  const row = await getScrapedOfflineChapter(source, contentId, chapterId);
  if (row?.status !== 'ready') return null;
  const dir = dirFor(source, contentId, chapterId);
  try {
    const files = await FileSystem.readDirectoryAsync(dir);
    return files
      .filter((f) => f.startsWith('page-') && (f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.webp')))
      .sort()
      .map((f) => dir + f);
  } catch {
    return null;
  }
}

export function deleteScrapedOfflineChapter(source: ScrapedSource, contentId: string, chapterId: string): Promise<void> {
  return chapterJobs.remove(chapterKey(source, contentId, chapterId), async () => {
    await ensureLoaded();
    await FileSystem.deleteAsync(dirFor(source, contentId, chapterId), { idempotent: true });
    delete mem.chapters[chapterKey(source, contentId, chapterId)];
    await persist();
    if (!Object.values(mem.chapters).some((row) => row.source === source && row.mangaId === contentId)) await deleteOfflineTitle(source, contentId);
  });
}

export function clearAllScrapedOffline(): Promise<void> {
  batchGeneration++;
  return chapterJobs.clear(async () => {
    await ensureLoaded();
    batchJobs.clear();
    pausedChapterJobs.clear();
    await FileSystem.deleteAsync(ROOT, { idempotent: true });
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
    mem.chapters = {};
    await persist();
    const titles = await listOfflineTitles();
    await Promise.all(titles.filter((title) => title.source !== 'atsu')
      .map((title) => deleteOfflineTitle(title.source, title.contentId)));
    notifyBatch();
  });
}

export async function getScrapedOfflineStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.chapters)) {
    if (row.status !== 'ready') continue;
    const dir = dirFor(row.source, row.mangaId, row.chapterId);
    try {
      const files = await FileSystem.readDirectoryAsync(dir);
      for (const f of files) {
        const info = await FileSystem.getInfoAsync(dir + f);
        if (info.exists && 'size' in info && typeof info.size === 'number') total += info.size;
      }
    } catch {
      // ignore
    }
  }
  return total;
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
  canceledChapterJobs.delete(key);
  await ensureLoaded();
  if (canceledChapterJobs.has(key)) return {};
  const existing = mem.chapters[key];
  if (existing?.status === 'ready') return {};

  activeJobs.add(key);
  pausedChapterJobs.delete(key);

  let record: OfflineScrapedChapter = {
    source: opts.source,
    mangaId: opts.contentId,
    chapterId: opts.chapterId,
    chapterNumber: opts.chapterNumber,
    chapterTitle: opts.chapterTitle,
    title: opts.title,
    cover: opts.cover,
    status: 'downloading',
    progress: existing?.status === 'paused' ? existing.progress : 0,
    pageCount: existing?.pageCount ?? 0,
    completedPages: existing?.status === 'paused' ? existing.completedPages : 0,
    updatedAt: Date.now(),
  };

  try {
    await patch(record);
    const urls = await fetchPageUrls(opts.source, opts.contentId, opts.chapterId);
    if (urls.length === 0) throw new Error('No pages found for this chapter.');

    const dir = dirFor(opts.source, opts.contentId, opts.chapterId);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    record = { ...record, pageCount: urls.length, progress: record.completedPages / urls.length };
    await patch(record);

    const startPage = 0;

    for (let i = startPage; i < urls.length; i++) {
      if (canceledChapterJobs.has(key)) return {};
      if (pausedChapterJobs.has(key)) {
        record = { ...record, status: 'paused', completedPages: i, progress: i / urls.length, updatedAt: Date.now() };
        await patch(record);
        return { paused: true };
      }

      const ext = urls[i].includes('.png') ? 'png' : urls[i].includes('.webp') ? 'webp' : 'jpg';
      const dest = `${dir}page-${String(i).padStart(4, '0')}.${ext}`;
      if (!(await fileHasContent(dest))) {
        const result = await FileSystem.downloadAsync(urls[i], dest, { headers: { Accept: 'image/*' } });
        if (result.status < 200 || result.status >= 300 || !await fileHasContent(dest)) {
          await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
          throw new Error(`Failed to download page ${i + 1}`);
        }
      }

      record = { ...record, completedPages: i + 1, progress: (i + 1) / urls.length, updatedAt: Date.now() };
      await patch(record);

      if (pausedChapterJobs.has(key)) {
        record = { ...record, status: 'paused', completedPages: i + 1, progress: (i + 1) / urls.length, updatedAt: Date.now() };
        await patch(record);
        return { paused: true };
      }
    }

    record = { ...record, status: 'ready', progress: 1, error: undefined, updatedAt: Date.now() };
    await patch(record);
    return {};
  } catch (e) {
    if (canceledChapterJobs.has(key)) return {};
    const message = e instanceof Error ? e.message : 'Download failed';
    record = { ...record, status: 'error', error: message, updatedAt: Date.now() };
    await patch(record).catch(() => undefined);
    throw e;
  } finally {
    activeJobs.delete(key);
    canceledChapterJobs.delete(key);
  }
}

/**
 * Download every chapter of a title, one chapter at a time. Mirrors
 * downloadAllMangaChapters in lib/manga-offline.ts: sequential, chapters
 * already downloaded return at once and count as done, pause/resume through
 * the batch state, and `paused: true` when it stops early.
 */
export function downloadAllScrapedChapters(opts: Parameters<typeof runDownloadAllScrapedChapters>[0]): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const key = batchKey(opts.source, opts.contentId);
  const existing = activeBatches.get(key);
  if (existing) return existing;
  const task = runDownloadAllScrapedChapters(opts, batchGeneration);
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
          endedPaused = true;
          return { ok, failed, paused: true };
        }
        if (generation !== batchGeneration) return { ok, failed };
        ok += 1;
      } catch {
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
