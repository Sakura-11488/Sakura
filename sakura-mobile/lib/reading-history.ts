import {
  getAllMangaProgressEntries,
  getAllNovelProgressEntries,
  clearAllReadingProgress,
} from '@/lib/reader-progress';
import { getAllWatchHistory, clearAllWatchProgress } from '@/lib/watch-progress';

export type HistoryKind = 'anime' | 'manga' | 'novel';

export interface HistoryItem {
  kind: HistoryKind;
  id: string;
  title: string;
  cover?: string;
  subtitle: string;
  progress: number;
  updatedAt: number;
  animeId?: string;
  episodeId?: string;
  mangaId?: string;
  chapterId?: string;
  page?: number;
  novelPath?: string;
  novelOffsetY?: number;
}

function novelTitleFromPath(path: string) {
  const slug = path.split('/').filter(Boolean).pop() || path;
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatHistoryTime(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  if (diff < 60_000) return 'Just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function progressLabel(progress: number, completedLabel = 'Completed'): string {
  if (progress >= 0.98) return completedLabel;
  if (progress <= 0) return 'Up next';
  return `${Math.round(progress * 100)}%`;
}

export async function getReadingHistory(limit = 100): Promise<HistoryItem[]> {
  const [animeRows, mangaRows, novelRows] = await Promise.all([
    getAllWatchHistory(),
    getAllMangaProgressEntries(),
    getAllNovelProgressEntries(),
  ]);

  const items: HistoryItem[] = [];

  for (const row of animeRows) {
    if (!row?.animeId) continue;
    const pct = progressLabel(row.progress);
    const epPart =
      row.progress === 0
        ? `Ep ${row.episodeNumber} · Up next`
        : `Ep ${row.episodeNumber}${row.episodeTitle ? ` · ${row.episodeTitle}` : ''}`;
    items.push({
      kind: 'anime',
      id: `anime-${row.animeId}`,
      title: row.title || 'Anime',
      cover: row.episodeThumbnail || row.cover,
      subtitle: `${epPart} · ${pct}`,
      progress: row.progress,
      updatedAt: row.updatedAt,
      animeId: row.animeId,
      episodeId: row.episodeId,
    });
  }

  for (const row of mangaRows) {
    if (!row?.mangaId) continue;
    items.push({
      kind: 'manga',
      id: `manga-${row.mangaId}`,
      title: row.title || 'Manga',
      cover: row.cover,
      subtitle: `${row.chapterLabel} · p.${row.page}/${row.totalPages} · ${progressLabel(row.progress)}`,
      progress: row.progress,
      updatedAt: row.updatedAt,
      mangaId: row.mangaId,
      chapterId: row.chapterId,
      page: row.page,
    });
  }

  for (const row of novelRows) {
    if (!row?.path) continue;
    items.push({
      kind: 'novel',
      id: `novel-${encodeURIComponent(row.path)}`,
      title: row.title || novelTitleFromPath(row.path),
      cover: row.cover,
      subtitle: `${row.chapterLabel || 'Chapter'} · ${progressLabel(row.progress)}`,
      progress: row.progress,
      updatedAt: row.updatedAt,
      novelPath: row.path,
      novelOffsetY: row.offsetY,
    });
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function clearReadingHistory(): Promise<void> {
  await Promise.all([clearAllReadingProgress(), clearAllWatchProgress()]);
}
