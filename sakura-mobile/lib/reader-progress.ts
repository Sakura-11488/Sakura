import * as FileSystem from 'expo-file-system/legacy';

export type ReadingKind = 'manga' | 'novel';

export interface ContinueReadingItem {
  kind: ReadingKind;
  id: string;
  title: string;
  cover?: string;
  subtitle: string;
  progress: number;
  updatedAt: number;
  mangaId?: string;
  chapterId?: string;
  page?: number;
  /** Backing source for manga-type items: 'comics' | 'hentai' route to the
   *  scraped reader, undefined/'manga' to the manga backend. */
  source?: string;
  novelPath?: string;
  novelOffsetY?: number;
}

export type NovelProgress = {
  path: string;
  offsetY: number;
  progress: number;
  updatedAt: number;
  title?: string;
  cover?: string;
  chapterLabel?: string;
  /** AllNovel / series path when known (detail screen id). */
  novelSeriesPath?: string;
};

export type MangaProgress = {
  mangaId: string;
  chapterId: string;
  title: string;
  cover?: string;
  chapterLabel: string;
  page: number;
  totalPages: number;
  progress: number;
  updatedAt: number;
  /** 'comics' | 'hentai' for droplet-scraped sources; absent for atsu manga. */
  source?: string;
};

type ProgressStore = {
  novels: Record<string, NovelProgress>;
  manga: Record<string, MangaProgress>;
};

const FILE = `${FileSystem.documentDirectory}sakura_reader_progress.json`;
const mem: ProgressStore = { novels: {}, manga: {} };
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeReadingProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(FILE);
      const parsed = JSON.parse(raw) as Partial<ProgressStore>;
      mem.novels = parsed?.novels || {};
      mem.manga = parsed?.manga || {};
      for (const [key, row] of Object.entries(mem.novels)) {
        if (row && !row.path) {
          try {
            row.path = decodeURIComponent(key);
          } catch {
            row.path = key;
          }
        }
      }
    }
  } catch {
    mem.novels = {};
    mem.manga = {};
  } finally {
    loaded = true;
  }
}

async function persist() {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(mem));
    notify();
  } catch {
    // no-op
  }
}

function keyForPath(path: string) {
  return encodeURIComponent(path.trim());
}

function novelTitleFromPath(path: string) {
  const slug = path.split('/').filter(Boolean).pop() || path;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isActiveReadingProgress(progress: number): boolean {
  return progress >= 0.01 && progress < 0.98;
}

export function novelSeriesPathFromChapterPath(chapterPath: string): string {
  const p = chapterPath.trim();
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : p;
}

export async function findNovelProgressForSeries(seriesPath: string): Promise<NovelProgress | null> {
  if (!seriesPath) return null;
  await ensureLoaded();
  const base = seriesPath.trim().replace(/\/$/, '');
  let best: NovelProgress | null = null;

  for (const row of Object.values(mem.novels)) {
    if (!row?.path || !isActiveReadingProgress(row.progress)) continue;
    const rowSeries = (row.novelSeriesPath || novelSeriesPathFromChapterPath(row.path)).replace(/\/$/, '');
    const matches =
      row.path === base ||
      rowSeries === base ||
      row.path.startsWith(`${base}/`) ||
      base.startsWith(rowSeries);
    if (!matches) continue;
    if (!best || row.updatedAt > best.updatedAt) best = row;
  }
  return best;
}

/** Latest in-progress novel entry per series path (for novel grid). */
export async function getNovelProgressBySeries(): Promise<Record<string, NovelProgress>> {
  await ensureLoaded();
  const index: Record<string, NovelProgress> = {};
  for (const row of Object.values(mem.novels)) {
    if (!row?.path || !isActiveReadingProgress(row.progress)) continue;
    const series = (row.novelSeriesPath || novelSeriesPathFromChapterPath(row.path)).replace(/\/$/, '');
    const prev = index[series];
    if (!prev || row.updatedAt > prev.updatedAt) index[series] = row;
  }
  return index;
}

export async function getNovelReadProgress(path: string): Promise<NovelProgress | null> {
  if (!path) return null;
  await ensureLoaded();
  return mem.novels[keyForPath(path)] || null;
}

export async function setNovelReadProgress(
  path: string,
  payload: {
    offsetY: number;
    progress: number;
    title?: string;
    cover?: string;
    chapterLabel?: string;
    novelSeriesPath?: string;
  },
): Promise<void> {
  if (!path) return;
  await ensureLoaded();
  const prev = mem.novels[keyForPath(path)];
  mem.novels[keyForPath(path)] = {
    path: path.trim(),
    offsetY: Math.max(0, payload.offsetY || 0),
    progress: Math.min(1, Math.max(0, payload.progress || 0)),
    updatedAt: Date.now(),
    title: payload.title ?? prev?.title,
    cover: payload.cover ?? prev?.cover,
    chapterLabel: payload.chapterLabel ?? prev?.chapterLabel,
    novelSeriesPath:
      payload.novelSeriesPath?.trim() ||
      prev?.novelSeriesPath ||
      novelSeriesPathFromChapterPath(path),
  };
  await persist();
}

export async function getMangaReadProgress(mangaId: string): Promise<MangaProgress | null> {
  if (!mangaId) return null;
  await ensureLoaded();
  return mem.manga[mangaId] || null;
}

export async function setMangaReadProgress(entry: {
  mangaId: string;
  chapterId: string;
  title: string;
  cover?: string;
  chapterLabel?: string;
  page: number;
  totalPages: number;
  source?: string;
}): Promise<void> {
  if (!entry.mangaId || !entry.chapterId) return;
  await ensureLoaded();
  const total = Math.max(1, entry.totalPages || 1);
  const page = Math.min(total, Math.max(1, entry.page || 1));
  const progress = Math.min(1, Math.max(0, page / total));
  mem.manga[entry.mangaId] = {
    mangaId: entry.mangaId,
    chapterId: entry.chapterId,
    title: entry.title || 'Manga',
    cover: entry.cover,
    chapterLabel: entry.chapterLabel || `Chapter ${entry.chapterId}`,
    page,
    totalPages: total,
    progress,
    updatedAt: Date.now(),
    source: entry.source ?? mem.manga[entry.mangaId]?.source,
  };
  await persist();
}

export async function getContinueReading(limit = 12): Promise<ContinueReadingItem[]> {
  await ensureLoaded();
  const items: ContinueReadingItem[] = [];

  for (const row of Object.values(mem.manga)) {
    if (!row || row.progress < 0.01 || row.progress >= 0.98) continue;
    items.push({
      kind: 'manga',
      id: `manga-${row.mangaId}`,
      title: row.title,
      cover: row.cover,
      subtitle: `${row.chapterLabel} · p.${row.page}/${row.totalPages}`,
      progress: row.progress,
      updatedAt: row.updatedAt,
      mangaId: row.mangaId,
      chapterId: row.chapterId,
      page: row.page,
      source: row.source,
    });
  }

  for (const row of Object.values(mem.novels)) {
    if (!row?.path || row.progress < 0.01 || row.progress >= 0.98) continue;
    items.push({
      kind: 'novel',
      id: `novel-${keyForPath(row.path)}`,
      title: row.title || novelTitleFromPath(row.path),
      cover: row.cover,
      subtitle: row.chapterLabel || 'Continue chapter',
      progress: row.progress,
      updatedAt: row.updatedAt,
      novelPath: row.path,
      novelOffsetY: row.offsetY,
    });
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function clearAllReadingProgress(): Promise<void> {
  await ensureLoaded();
  mem.novels = {};
  mem.manga = {};
  await persist();
}

/** Snapshot the full reading-progress store (cloud-sync). */
export async function exportReadingProgress(): Promise<ProgressStore> {
  await ensureLoaded();
  return { novels: { ...mem.novels }, manga: { ...mem.manga } };
}

/** Merge a cloud snapshot into local progress, newest-updatedAt wins. */
export async function importReadingProgress(incoming: Partial<ProgressStore>): Promise<void> {
  await ensureLoaded();
  for (const [key, row] of Object.entries(incoming.novels || {})) {
    const local = mem.novels[key];
    if (!local || (row.updatedAt || 0) > (local.updatedAt || 0)) mem.novels[key] = row;
  }
  for (const [key, row] of Object.entries(incoming.manga || {})) {
    const local = mem.manga[key];
    if (!local || (row.updatedAt || 0) > (local.updatedAt || 0)) mem.manga[key] = row;
  }
  await persist();
}

export async function getAllMangaProgressEntries(): Promise<MangaProgress[]> {
  await ensureLoaded();
  return Object.values(mem.manga).filter(Boolean);
}

export async function getAllNovelProgressEntries(): Promise<NovelProgress[]> {
  await ensureLoaded();
  return Object.values(mem.novels).filter((row) => Boolean(row?.path));
}
