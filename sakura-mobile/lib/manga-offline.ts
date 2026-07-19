import * as FileSystem from 'expo-file-system/legacy';
import { toPageUrl } from '@/lib/manga';

const ATSU_BASE = 'https://atsu.moe';
const ROOT = `${FileSystem.documentDirectory}sakura_manga_offline/`;
const MANIFEST = `${ROOT}manifest.json`;

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
}

type Manifest = { chapters: Record<string, OfflineMangaChapter> };

const mem: Manifest = { chapters: {} };
let loaded = false;
const listeners = new Set<() => void>();
const batchListeners = new Set<() => void>();
const activeJobs = new Set<string>();
const pausedChapterJobs = new Set<string>();

type MangaBatchJob = {
  mangaId: string;
  paused: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
};

const batchJobs = new Map<string, MangaBatchJob>();

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

export function pauseMangaChapterDownload(mangaId: string, chapterId: string) {
  pausedChapterJobs.add(chapterKey(mangaId, chapterId));
}

export function resumeMangaChapterDownload(mangaId: string, chapterId: string) {
  pausedChapterJobs.delete(chapterKey(mangaId, chapterId));
}

export function isMangaChapterPaused(mangaId: string, chapterId: string): boolean {
  return pausedChapterJobs.has(chapterKey(mangaId, chapterId));
}

async function fileHasContent(path: string, minBytes = 100): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists && 'size' in info && typeof info.size === 'number' && info.size >= minBytes;
  } catch {
    return false;
  }
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeOfflineManga(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function chapterKey(mangaId: string, chapterId: string) {
  return `${mangaId}::${chapterId}`;
}

function dirFor(mangaId: string, chapterId: string) {
  return `${ROOT}${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterId)}/`;
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

async function patch(record: OfflineMangaChapter) {
  mem.chapters[chapterKey(record.mangaId, record.chapterId)] = record;
  await persist();
}

export async function fetchChapterPageUrls(mangaId: string, chapterId: string): Promise<string[]> {
  const res = await fetch(
    `${ATSU_BASE}/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
    { headers: { Accept: 'application/json', Referer: ATSU_BASE } },
  );
  if (!res.ok) throw new Error(`Could not load chapter (HTTP ${res.status})`);
  const json = await res.json();
  const raw: unknown[] = json.readChapter?.pages || [];
  return raw
    .map((p) => {
      const row = p as { image?: string };
      const rawImg = row?.image ?? p;
      const url = typeof rawImg === 'string' ? toPageUrl(rawImg) : '';
      return url;
    })
    .filter(Boolean);
}

export async function getOfflineMangaChapter(
  mangaId: string,
  chapterId: string,
): Promise<OfflineMangaChapter | null> {
  await ensureLoaded();
  return mem.chapters[chapterKey(mangaId, chapterId)] || null;
}

/** Single manifest scan — avoids N lookups when rendering long chapter lists. */
export async function getOfflineMapForManga(
  mangaId: string,
): Promise<Record<string, OfflineMangaChapter>> {
  await ensureLoaded();
  const map: Record<string, OfflineMangaChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.mangaId === mangaId) map[row.chapterId] = row;
  }
  return map;
}

export async function listOfflineMangaChapters(): Promise<OfflineMangaChapter[]> {
  await ensureLoaded();
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

const MODULE_LOAD_TIME = Date.now();
let reconciledInterrupted = false;

/**
 * On launch, any chapter still `downloading` is a leftover from a killed session
 * (batch jobs live only in memory). Flip those to `paused` so they show as
 * resumable. Runs once per process; only touches rows last updated before this
 * session so an in-flight download is never paused out from under it.
 */
export async function reconcileInterruptedMangaChapters(): Promise<void> {
  if (reconciledInterrupted) return;
  reconciledInterrupted = true;
  try {
    await ensureLoaded();
    let changed = false;
    for (const row of Object.values(mem.chapters)) {
      if (row.status === 'downloading' && row.updatedAt < MODULE_LOAD_TIME) {
        mem.chapters[chapterKey(row.mangaId, row.chapterId)] = {
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

export async function getOfflineMangaPageUris(
  mangaId: string,
  chapterId: string,
): Promise<string[] | null> {
  const row = await getOfflineMangaChapter(mangaId, chapterId);
  if (row?.status !== 'ready') return null;
  const dir = dirFor(mangaId, chapterId);
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

export async function deleteOfflineMangaChapter(mangaId: string, chapterId: string) {
  await ensureLoaded();
  try {
    await FileSystem.deleteAsync(dirFor(mangaId, chapterId), { idempotent: true });
  } catch {
    // ignore
  }
  delete mem.chapters[chapterKey(mangaId, chapterId)];
  await persist();
}

export async function clearAllOfflineManga() {
  await ensureLoaded();
  try {
    await FileSystem.deleteAsync(ROOT, { idempotent: true });
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
  } catch {
    // ignore
  }
  mem.chapters = {};
  await persist();
}

export async function getOfflineMangaStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.chapters)) {
    if (row.status !== 'ready') continue;
    try {
      const files = await FileSystem.readDirectoryAsync(dirFor(row.mangaId, row.chapterId));
      for (const f of files) {
        const info = await FileSystem.getInfoAsync(dirFor(row.mangaId, row.chapterId) + f);
        if (info.exists && 'size' in info && typeof info.size === 'number') total += info.size;
      }
    } catch {
      // ignore
    }
  }
  return total;
}

export async function downloadMangaChapter(opts: {
  mangaId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
}): Promise<{ paused?: boolean }> {
  const key = chapterKey(opts.mangaId, opts.chapterId);
  if (activeJobs.has(key)) return {};
  await ensureLoaded();
  const existing = mem.chapters[key];
  if (existing?.status === 'ready') return {};

  activeJobs.add(key);
  pausedChapterJobs.delete(key);

  let record: OfflineMangaChapter = {
    ...opts,
    status: 'downloading',
    progress: existing?.status === 'paused' ? existing.progress : 0,
    pageCount: existing?.pageCount ?? 0,
    completedPages: existing?.status === 'paused' ? existing.completedPages : 0,
    updatedAt: Date.now(),
  };
  await patch(record);

  try {
    const urls = await fetchChapterPageUrls(opts.mangaId, opts.chapterId);
    if (urls.length === 0) throw new Error('No pages found for this chapter.');

    const dir = dirFor(opts.mangaId, opts.chapterId);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    record = { ...record, pageCount: urls.length, completedPages: record.completedPages, progress: record.completedPages / urls.length };
    await patch(record);

    const startPage = existing?.status === 'paused' ? existing.completedPages : 0;

    for (let i = startPage; i < urls.length; i++) {
      if (pausedChapterJobs.has(key)) {
        record = {
          ...record,
          status: 'paused',
          completedPages: i,
          progress: i / urls.length,
          updatedAt: Date.now(),
        };
        await patch(record);
        return { paused: true };
      }

      const ext = urls[i].includes('.png') ? 'png' : urls[i].includes('.webp') ? 'webp' : 'jpg';
      const dest = `${dir}page-${String(i).padStart(4, '0')}.${ext}`;
      if (!(await fileHasContent(dest))) {
        const result = await FileSystem.downloadAsync(urls[i], dest, {
          headers: { Referer: ATSU_BASE, Accept: 'image/*' },
        });
        if (result.status < 200 || result.status >= 300) {
          throw new Error(`Failed to download page ${i + 1}`);
        }
      }

      record = {
        ...record,
        completedPages: i + 1,
        progress: (i + 1) / urls.length,
        updatedAt: Date.now(),
      };
      await patch(record);

      if (pausedChapterJobs.has(key)) {
        record = {
          ...record,
          status: 'paused',
          completedPages: i + 1,
          progress: (i + 1) / urls.length,
          updatedAt: Date.now(),
        };
        await patch(record);
        return { paused: true };
      }
    }

    record = {
      ...record,
      status: 'ready',
      progress: 1,
      error: undefined,
      updatedAt: Date.now(),
    };
    await patch(record);
    return {};
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Download failed';
    record = { ...record, status: 'error', error: message, updatedAt: Date.now() };
    await patch(record);
    try {
      await FileSystem.deleteAsync(dirFor(opts.mangaId, opts.chapterId), { idempotent: true });
    } catch {
      // ignore
    }
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}

export async function downloadAllMangaChapters(opts: {
  mangaId: string;
  title: string;
  cover: string;
  chapters: Array<{ id: string; number: number; title: string }>;
  onChapterStart?: (chapterNumber: number) => void;
}): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const list = opts.chapters;
  const existing = batchJobs.get(opts.mangaId);
  const startIndex = existing?.paused ? existing.done : 0;
  let ok = existing?.paused ? existing.ok : 0;
  let failed = existing?.paused ? existing.failed : 0;

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
          endedPaused = true;
          return { ok, failed, paused: true };
        }
        ok += 1;
      } catch {
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
    if (!endedPaused) {
      batchJobs.delete(opts.mangaId);
      notifyBatch();
    }
  }
}
