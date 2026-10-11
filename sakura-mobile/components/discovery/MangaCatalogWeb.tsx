import type { UserSearchResult } from '@/lib/creator';

export type CatalogFilter = 'All' | 'Manga' | 'Anime' | 'Novel' | 'Users' | '18+';
export interface CatalogSearchResult {
  key: string;
  title: string;
  cover: string;
  type: 'manga' | 'anime' | 'novel' | 'user' | 'hentai';
  meta: string;
  navTarget?: string;
  user?: UserSearchResult;
}
export interface MangaCatalogWebProps {
  query: string;
  onQueryChange: (query: string) => void;
  filter: CatalogFilter;
  filters: CatalogFilter[];
  onFilterChange: (filter: CatalogFilter) => void;
  results: CatalogSearchResult[];
  loading: boolean;
  failedSources: string[];
  discoverCards: Array<{ id: string; title: string; cover: string }>;
  discoverLoading: boolean;
  discoverError: boolean;
  messagingUser: string | null;
  suggestions: Array<{ label: string; query: string; cover: string }>;
  onResultPress: (item: CatalogSearchResult) => void;
  onDiscoverPress: (id: string) => void;
  onRetry: () => void;
  onRetryDiscover: () => void;
}

// Metro selects the DOM implementation only for web; native keeps its existing screen.
export default function MangaCatalogWeb(_props: MangaCatalogWebProps) { return null; }
