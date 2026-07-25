import * as FileSystem from 'expo-file-system/legacy';
import { SCRAPED_SOURCES, type ScrapedSource } from '@/lib/scraped-sources';

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

const ROOT = `${FileSystem.documentDirectory}sakura_scraped_offline/`;
const MANIFEST = `${ROOT}manifest.json`;

type Manifest = { chapters: Record<string, OfflineScrapedChapter> };

const mem: Manifest = { chapters: {} };
let loaded = false;
const listeners = new Set<() => void>();
const activeJobs = new Set<string>();
const pausedChapterJobs = new Set<string>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeScrapedOffline(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function chapterKey(source: ScrapedSource, contentId: string, chapterId: string) {
  return `${source}::${contentId}::${chapterId}`;
}

function dirFor(source: ScrapedSource, contentId: string, chapterId: string) {
  return `${ROOT}${source}/${encodeURIComponent(contentId)}/${encodeURIComponent(chapterId)}/`;
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
    const info = await FileSystem.getInfoAsync(MANIFEST);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(MANIFEST);
      mem.chapters = (JSON.parse(raw) as Manifest)?.chapters || {};
    }
  } catch {
    mem.chapters = {};
  } finally {
    loaded = true;
  }
}

async function persist() {
  try {
    await FileSystem.writeAsStringAsync(MANIFEST, JSON.stringify(mem));
    notify();
  } catch {
    // ignore
  }
}

async function patch(record: OfflineScrapedChapter) {
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

export async function deleteScrapedOfflineChapter(source: ScrapedSource, contentId: string, chapterId: string) {
  await ensureLoaded();
  try {
    await FileSystem.deleteAsync(dirFor(source, contentId, chapterId), { idempotent: true });
  } catch {
    // ignore
  }
  delete mem.chapters[chapterKey(source, contentId, chapterId)];
  await persist();
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
  await patch(record);

  try {
    const urls = await fetchPageUrls(opts.source, opts.contentId, opts.chapterId);
    if (urls.length === 0) throw new Error('No pages found for this chapter.');

    const dir = dirFor(opts.source, opts.contentId, opts.chapterId);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    record = { ...record, pageCount: urls.length, progress: record.completedPages / urls.length };
    await patch(record);

    const startPage = existing?.status === 'paused' ? existing.completedPages : 0;

    for (let i = startPage; i < urls.length; i++) {
      if (pausedChapterJobs.has(key)) {
        record = { ...record, status: 'paused', completedPages: i, progress: i / urls.length, updatedAt: Date.now() };
        await patch(record);
        return { paused: true };
      }

      const ext = urls[i].includes('.png') ? 'png' : urls[i].includes('.webp') ? 'webp' : 'jpg';
      const dest = `${dir}page-${String(i).padStart(4, '0')}.${ext}`;
      if (!(await fileHasContent(dest))) {
        const result = await FileSystem.downloadAsync(urls[i], dest, { headers: { Accept: 'image/*' } });
        if (result.status < 200 || result.status >= 300) {
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
    const message = e instanceof Error ? e.message : 'Download failed';
    record = { ...record, status: 'error', error: message, updatedAt: Date.now() };
    await patch(record);
    try {
      await FileSystem.deleteAsync(dirFor(opts.source, opts.contentId, opts.chapterId), { idempotent: true });
    } catch {
      // ignore
    }
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}
