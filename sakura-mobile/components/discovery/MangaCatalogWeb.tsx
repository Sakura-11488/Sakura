import type { SearchFilter, SearchResult, SearchSummary, SectionView } from '@/lib/search-core';

export type CatalogFilter = SearchFilter;
export type CatalogSearchResult = SearchResult;
export type CatalogSection = SectionView;

export interface MangaCatalogWebProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Enter in the search box: run now (skipping the debounce) and remember the query. */
  onSubmit: () => void;
  filter: CatalogFilter;
  filters: CatalogFilter[];
  onFilterChange: (filter: CatalogFilter) => void;
  /** Sections for the active chip, in display order (All = one rail per source). */
  sections: CatalogSection[];
  summary: SearchSummary;
  discoverCards: Array<{ id: string; title: string; cover: string }>;
  discoverLoading: boolean;
  discoverError: boolean;
  messagingUser: string | null;
  suggestions: Array<{ label: string; query: string; cover: string }>;
  recentSearches: string[];
  onRecentPress: (query: string) => void;
  onRemoveRecent: (query: string) => void;
  onClearRecent: () => void;
  /** A result or "See all" was opened from this query: worth remembering. */
  onRemember: () => void;
  onResultPress: (item: CatalogSearchResult) => void;
  onDiscoverPress: (id: string) => void;
  onRetry: () => void;
  onRetryDiscover: () => void;
}

// Metro selects the DOM implementation only for web; native keeps its existing screen.
export default function MangaCatalogWeb(_props: MangaCatalogWebProps) { return null; }
