import type { ReactNode } from 'react';
import type { MangaChapter, MangaDetail } from '@/lib/manga';
import type { MangaProgress } from '@/lib/reader-progress';
import type { OfflineMangaChapter } from '@/lib/manga-offline';
export interface MangaDetailWebProps {
  manga: MangaDetail | null; loading: boolean; error: string; chaptersError: string;
  chapters: MangaChapter[]; sort: 'oldest' | 'newest'; onSort: () => void;
  saved: boolean; canSave: boolean; onSave: () => Promise<void>; onShare: () => void;
  onBack: () => void; onRetry: () => void; onOpen: (chapter: MangaChapter, resume?: boolean) => void;
  playChapter: MangaChapter | null; resume: boolean; progress: MangaProgress | null;
  offline: Record<string, OfflineMangaChapter>; canDownload: boolean; onDownload: (chapter: MangaChapter) => Promise<void>;
  gated: Set<string>; discussion: ReactNode; feedback: ReactNode;
}
export default function MangaDetailWeb(_props: MangaDetailWebProps) { return null; }
