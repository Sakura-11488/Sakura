import type { AllNovelDetail, AllNovelChapter } from '@/lib/allnovel';
import type { NovelProgress } from '@/lib/reader-progress';
import type { OfflineNovelChapter } from '@/lib/novel-offline';
import type { ChapterReadState } from '@/lib/novel-navigation';
export interface NovelDetailWebProps {
  detail: AllNovelDetail | null;
  loading: boolean;
  error: string;
  saved: boolean;
  original: boolean;
  progress: NovelProgress | null;
  offline: Record<string, OfflineNovelChapter>;
  batchDownloading: boolean;
  batchPaused: boolean;
  batchProgress: { done: number; total: number } | null;
  toast: string;
  onBack: () => void;
  onRetry: () => void;
  onSave: () => void;
  onShare: () => void;
  onOpen: (chapter: AllNovelChapter, resume?: boolean) => void;
  onDownload: (chapter: AllNovelChapter) => void;
  /** The detail header has rendered and the chapter list is still loading. */
  chaptersLoading: boolean;
  chaptersError: boolean;
  /** Finished and partly read chapters, for read marks. */
  readState: ChapterReadState | null;
  /** First chapter "Download next N" would fetch. */
  downloadFromLabel: string;
  onDownloadNext: (count: number) => void;
  /** Pause a running batch, or resume a paused one. */
  onToggleBatch: () => void;
}
export default function NovelDetailWeb(_props: NovelDetailWebProps) { return null; }
