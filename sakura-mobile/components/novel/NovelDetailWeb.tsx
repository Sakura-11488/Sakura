import type { AllNovelDetail, AllNovelChapter } from '@/lib/allnovel';
import type { NovelProgress } from '@/lib/reader-progress';
import type { OfflineNovelChapter } from '@/lib/novel-offline';
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
  onDownloadAll: () => void;
}
export default function NovelDetailWeb(_props: NovelDetailWebProps) { return null; }
