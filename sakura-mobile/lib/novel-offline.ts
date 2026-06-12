import * as FileSystem from 'expo-file-system/legacy';
import { parseChapterContent } from '@/lib/allnovel';

const ROOT = `${FileSystem.documentDirectory}sakura_novel_offline/`;
const MANIFEST = `${ROOT}manifest.json`;

export type OfflineNovelStatus = 'downloading' | 'ready' | 'error';

export interface OfflineNovelChapter {
  novelPath: string;
  chapterPath: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
  status: OfflineNovelStatus;
  progress: number;
  error?: string;
  updatedAt: number;
}

type Manifest = { chapters: Record<string, OfflineNovelChapter> };

const mem: Manifest = { chapters: {} };
let loaded = false;
const listeners = new Set<() => void>();
const batchListeners = new Set<() => void>();
const activeJobs = new Set<string>();

type NovelBatchJob = {
  novelPath: string;
  paused: boolean;
  done: number;
  total: number;
  ok: number;
  failed: number;
};

const batchJobs = new Map<string, NovelBatchJob>();

function notifyBatch() {
  batchListeners.forEach((fn) => fn());
}

export function subscribeNovelBatch(fn: () => void) {
  batchListeners.add(fn);
  return () => batchListeners.delete(fn);
}

export function getNovelBatchState(novelPath: string): NovelBatchJob | null {
  return batchJobs.get(novelPath) ?? null;
}

export function pauseNovelBatchDownload(novelPath: string) {
  const job = batchJobs.get(novelPath);
  if (!job || job.paused) return;
  job.paused = true;
  notifyBatch();
}

export function resumeNovelBatchDownload(novelPath: string) {
  const job = batchJobs.get(novelPath);
  if (!job?.paused) return;
  job.paused = false;
  notifyBatch();
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeOfflineNovel(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function chapterKey(novelPath: string, chapterPath: string) {
  return `${encodeURIComponent(novelPath)}::${encodeURIComponent(chapterPath)}`;
}

function fileFor(novelPath: string, chapterPath: string) {
  return `${ROOT}${encodeURIComponent(novelPath)}/${encodeURIComponent(chapterPath)}.txt`;
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

async function patch(record: OfflineNovelChapter) {
  mem.chapters[chapterKey(record.novelPath, record.chapterPath)] = record;
  await persist();
}

export async function getOfflineNovelChapter(
  novelPath: string,
  chapterPath: string,
): Promise<OfflineNovelChapter | null> {
  await ensureLoaded();
  return mem.chapters[chapterKey(novelPath, chapterPath)] || null;
}

/** Single manifest scan — avoids N lookups when rendering long chapter lists. */
export async function getOfflineMapForNovel(
  novelPath: string,
): Promise<Record<string, OfflineNovelChapter>> {
  await ensureLoaded();
  const map: Record<string, OfflineNovelChapter> = {};
  for (const row of Object.values(mem.chapters)) {
    if (row.novelPath === novelPath) map[row.chapterPath] = row;
  }
  return map;
}

export async function getOfflineNovelChapterContent(
  novelPath: string,
  chapterPath: string,
): Promise<string | null> {
  const row = await getOfflineNovelChapter(novelPath, chapterPath);
  if (row?.status !== 'ready') return null;
  const path = fileFor(novelPath, chapterPath);
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    return await FileSystem.readAsStringAsync(path);
  } catch {
    return null;
  }
}

export async function listOfflineNovelChapters(): Promise<OfflineNovelChapter[]> {
  await ensureLoaded();
  return Object.values(mem.chapters).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteOfflineNovelChapter(novelPath: string, chapterPath: string) {
  await ensureLoaded();
  try {
    await FileSystem.deleteAsync(fileFor(novelPath, chapterPath), { idempotent: true });
  } catch {
    // ignore
  }
  delete mem.chapters[chapterKey(novelPath, chapterPath)];
  await persist();
}

export async function clearAllOfflineNovel() {
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

export async function getOfflineNovelStorageBytes(): Promise<number> {
  await ensureLoaded();
  let total = 0;
  for (const row of Object.values(mem.chapters)) {
    if (row.status !== 'ready') continue;
    try {
      const info = await FileSystem.getInfoAsync(fileFor(row.novelPath, row.chapterPath));
      if (info.exists && 'size' in info && typeof info.size === 'number') total += info.size;
    } catch {
      // ignore
    }
  }
  return total;
}

export async function downloadNovelChapter(opts: {
  novelPath: string;
  chapterPath: string;
  chapterNumber: number;
  chapterTitle: string;
  title: string;
  cover: string;
}): Promise<void> {
  const key = chapterKey(opts.novelPath, opts.chapterPath);
  if (activeJobs.has(key)) return;
  await ensureLoaded();
  if (mem.chapters[key]?.status === 'ready') return;

  activeJobs.add(key);
  let record: OfflineNovelChapter = {
    ...opts,
    status: 'downloading',
    progress: 0,
    updatedAt: Date.now(),
  };
  await patch(record);

  try {
    const content = await parseChapterContent(opts.chapterPath);
    if (!content?.trim()) throw new Error('Chapter has no content.');

    const dir = `${ROOT}${encodeURIComponent(opts.novelPath)}/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.writeAsStringAsync(fileFor(opts.novelPath, opts.chapterPath), content);

    record = {
      ...record,
      status: 'ready',
      progress: 1,
      error: undefined,
      updatedAt: Date.now(),
    };
    await patch(record);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Download failed';
    record = { ...record, status: 'error', error: message, updatedAt: Date.now() };
    await patch(record);
    try {
      await FileSystem.deleteAsync(fileFor(opts.novelPath, opts.chapterPath), { idempotent: true });
    } catch {
      // ignore
    }
    throw e;
  } finally {
    activeJobs.delete(key);
  }
}

export async function downloadAllNovelChapters(opts: {
  novelPath: string;
  title: string;
  cover: string;
  chapters: Array<{ path: string; chapterNumber: number; name: string }>;
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ ok: number; failed: number; paused?: boolean }> {
  const list = opts.chapters.slice(0, opts.limit ?? opts.chapters.length);
  const existing = batchJobs.get(opts.novelPath);
  const startIndex = existing?.paused ? existing.done : 0;
  let ok = existing?.paused ? existing.ok : 0;
  let failed = existing?.paused ? existing.failed : 0;

  batchJobs.set(opts.novelPath, {
    novelPath: opts.novelPath,
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
      if (batchJobs.get(opts.novelPath)?.paused) {
        const job = batchJobs.get(opts.novelPath)!;
        job.done = i;
        endedPaused = true;
        notifyBatch();
        return { ok, failed, paused: true };
      }

      const ch = list[i];
      opts.onProgress?.(i, list.length);

      try {
        await downloadNovelChapter({
          novelPath: opts.novelPath,
          chapterPath: ch.path,
          chapterNumber: ch.chapterNumber,
          chapterTitle: ch.name,
          title: opts.title,
          cover: opts.cover,
        });
        ok += 1;
      } catch {
        failed += 1;
      }

      const job = batchJobs.get(opts.novelPath);
      if (job) {
        job.done = i + 1;
        job.ok = ok;
        job.failed = failed;
        notifyBatch();
      }

      if (batchJobs.get(opts.novelPath)?.paused) {
        endedPaused = true;
        return { ok, failed, paused: true };
      }

      await new Promise((r) => setTimeout(r, 350));
    }
    return { ok, failed };
  } finally {
    if (!endedPaused) {
      batchJobs.delete(opts.novelPath);
      notifyBatch();
    }
  }
}
