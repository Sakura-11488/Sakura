import type { ReactNode, Ref } from 'react';
import type { AnimeResult } from '@/lib/anime';
import type { OriginalEntry } from '@/lib/sakura-originals';

export interface AnimeDiscoveryWebProps {
  originals: OriginalEntry[];
  activeOriginalIndex: number;
  onOriginalSelect: (index: number) => void;
  onOriginalPress: (original: OriginalEntry) => void;
  airing: AnimeResult[];
  popular: AnimeResult[];
  airingLoading: boolean;
  popularLoading: boolean;
  catalogError: boolean;
  search: string;
  onSearch: (value: string) => void;
  searchResults: AnimeResult[];
  searchLoading: boolean;
  searchError: boolean;
  selectedGenre: number | null;
  onGenreSelect: (id: number | null) => void;
  genreResults: AnimeResult[];
  genreLoading: boolean;
  genreError: boolean;
  onAnimePress: (anime: AnimeResult) => void;
  onLibrary: () => void;
  onSchedule: () => void;
  onRefresh: () => void;
  onRetrySearch: () => void;
  history: ReactNode;
  personal: ReactNode;
  creator: ReactNode;
  scrollRef: Ref<{ scrollToTop: () => void }>;
}

// Metro resolves the browser implementation only for web. Native keeps its screen.
export default function AnimeDiscoveryWeb(_props: AnimeDiscoveryWebProps) {
  return null;
}
