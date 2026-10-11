import type { ReactNode } from 'react';
import type { LibraryItem } from '@/lib/storage';

export interface LibraryWebProps {
  items: LibraryItem[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (item: LibraryItem) => void;
  onBrowse: () => void;
  onSchedule: () => void;
  continueSection?: ReactNode;
}
// Native keeps the existing Library screen; Metro selects LibraryWeb.web on web.
export default function LibraryWeb(_props: LibraryWebProps) { return null; }
