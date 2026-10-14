import type { ReactNode } from 'react';
import type { LibraryItem, ReadingStatus } from '@/lib/storage';
import type { LibraryUpdateSummary } from '@/lib/library-updates';

export interface LibraryWebProps {
  items: LibraryItem[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (item: LibraryItem) => void;
  onBrowse: () => void;
  onSchedule: () => void;
  continueSection?: ReactNode;
  /** New-chapter and unread counts per saved series, by libraryUpdateKey (lib/library-updates). */
  updates?: Record<string, LibraryUpdateSummary>;
  /** When each saved title was last read, by libraryProgressKey. */
  lastRead?: Record<string, number>;
  /** A check for new chapters is running. */
  checking?: boolean;
  /** Choose a reading status (manga, novels); null returns it to automatic. */
  onSetStatus?: (item: LibraryItem, status: ReadingStatus | null) => void;
}
// Native keeps the existing Library screen; Metro selects LibraryWeb.web on web.
export default function LibraryWeb(_props: LibraryWebProps) { return null; }
