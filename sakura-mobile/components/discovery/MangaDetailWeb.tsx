import type { ReactNode } from 'react';
import type { MangaChapter, MangaDetail } from '@/lib/manga';
import type { MangaProgress } from '@/lib/reader-progress';
import type { OfflineMangaChapter } from '@/lib/manga-offline';
export interface MangaDetailWebLink { label: string; onPress: () => void }
export interface MangaDetailWebProps {
  /** May be a preview (title and cover only) while `detailPending`. */
  manga: MangaDetail | null;
  /** Nothing to show yet, not even a title: the whole page is a skeleton. */
  loading: boolean; error: string; chaptersError: string;
  /** The title's own details (synopsis, tags, status) are still loading; `manga` is the card's preview. */
  detailPending?: boolean;
  /** The chapter list is still loading; the rest of the page is shown. */
  chaptersPending?: boolean;
  /** A cover already on screen elsewhere (the card that was tapped), shown under the hero's own until it loads. */
  placeholderCover?: string;
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

  // ── Read state (lib/chapter-read-state, lib/chapter-progress) ──
  /** Chapters in the series, before the filter (`chapters` is filtered). */
  totalChapters?: number;
  filter?: 'all' | 'unread' | 'downloaded';
  onFilter?: (filter: 'all' | 'unread' | 'downloaded') => void;
  unreadCount?: number;
  downloadedCount?: number;
  /** Read marks are kept for this title (never for 18+). */
  readEnabled?: boolean;
  /** Read chapters, including the progress chapter once finished. */
  readIds?: ReadonlySet<string>;
  onMarkRead?: (chapter: MangaChapter, read: boolean) => void;
  onMarkPrevious?: (chapter: MangaChapter) => void;
  /** The chapter Continue / Up next points at: highlighted, and the target of Jump to current. */
  currentChapterId?: string | null;
  resumeKind?: 'start' | 'continue' | 'next' | 'caught-up';
  /** The primary button's words, decided with the native layout's rules. */
  playLabel?: string;
  /** "Latest: Chapter 280 · 3d ago · 2 unread". */
  latestSummary?: string;
  /** 'Manga', 'Manhwa', 'Comics', '18+': names the shelf in the top bar. */
  sourceLabel?: string;
  /** "Story: … · Art: …". */
  credits?: string;
  /** Show the Related and More-like-this rails (atsu titles, online). */
  showRelated?: boolean;
  /** Genres that open a Browse shelf when clicked. */
  browsableGenre?: (name: string) => boolean;
  onBrowseGenre?: (name: string) => void;
}
export default function MangaDetailWeb(_props: MangaDetailWebProps) { return null; }
