import type { ReactNode } from 'react';
import type { MangaChapter, MangaDetail } from '@/lib/manga';
import type { MangaProgress } from '@/lib/reader-progress';
import type { OfflineMangaChapter } from '@/lib/manga-offline';
export interface MangaDetailWebLink { label: string; onPress: () => void }
export interface MangaDetailWebProps {
  manga: MangaDetail | null; loading: boolean; error: string; chaptersError: string;
  /** In display order: ascending for 'oldest', descending for 'newest'. */
  chapters: MangaChapter[]; sort: 'oldest' | 'newest'; onSort: () => void;
  saved: boolean; canSave: boolean; onSave: () => Promise<void>; onShare: () => void;
  onBack: () => void; onRetry: () => void; onOpen: (chapter: MangaChapter, resume?: boolean) => void;
  playChapter: MangaChapter | null; resume: boolean; progress: MangaProgress | null;
  offline: Record<string, OfflineMangaChapter>; canDownload: boolean; onDownload: (chapter: MangaChapter) => Promise<void>;
  gated: Set<string>; discussion: ReactNode; feedback: ReactNode;
  /** Per-row download access on top of canDownload: a pass-locked chapter needs a valid pass. */
  canDownloadChapter?: (chapterId: string) => boolean;
  /** No network: only downloaded chapters open; the rest stay listed, dimmed, saying why. */
  downloadsOnly?: boolean;
  /** In-flow banner above the series: offline, or showing the downloaded copy because the source failed. */
  notice?: { text: string; actionLabel?: string; onAction?: () => void };
  /**
   * Download all / Pause / Resume for the whole series, with the batch's
   * progress. Absent when the control should not show at all.
   */
  batch?: { state: 'idle' | 'running' | 'paused'; progress: { done: number; total: number } | null; onPress: () => void };
  /** Other ways out of the series error, e.g. "Open your downloads" when offline. */
  errorLinks?: MangaDetailWebLink[];
  /** The same for the chapter list's error, e.g. "Browse comics" when that source is down. */
  chaptersErrorLinks?: MangaDetailWebLink[];
}
export default function MangaDetailWeb(_props: MangaDetailWebProps) { return null; }
