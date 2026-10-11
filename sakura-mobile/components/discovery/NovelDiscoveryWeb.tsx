import type { Ref } from 'react';
import type { AllNovelItem } from '@/lib/allnovel';
import type { ContinueReadingItem, NovelProgress } from '@/lib/reader-progress';

export interface NovelDiscoveryWebProps {
  novels: AllNovelItem[];
  featured: AllNovelItem;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  hasMore: boolean;
  search: string;
  activeGenre: string;
  genres: { label: string; value: string }[];
  recentSearches: string[];
  continueReading: ContinueReadingItem[];
  progress: Record<string, NovelProgress>;
  error: string;
  onSearch: (value: string) => void;
  onGenre: (value: string) => void;
  onRecentRemove: (value: string) => void;
  onClearRecent: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onRetry: () => void;
  scrollRef: Ref<{ scrollToTop: () => void }>;
}

// Metro resolves the browser implementation only for web. Native keeps its screen.
export default function NovelDiscoveryWeb(_props: NovelDiscoveryWebProps) {
  return null;
}
