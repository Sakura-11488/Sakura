import type { ContentItem } from '@/components/ui/ContentCard';
export interface BrowseCatalogFilters {
  genres: readonly { id: string; name: string }[];
  sorts: readonly { id: string; label: string }[];
  statuses: readonly string[];
  /** Empty strings mean "any" (and, for sort, the default order). */
  value: { genre: string; status: string; sort: string };
  onChange: (next: Partial<{ genre: string; status: any; sort: any }>) => void;
}
export interface BrowseCatalogWebProps {
  title: string; source: string; items: ContentItem[]; loading: boolean; loadingMore: boolean; hasMore: boolean; error: string;
  onBack: () => void; onRetry: () => void; onLoadMore: () => void;
  /** Total matches the source reports, when it does (atsu genre browsing). */
  found?: number | null;
  /** Genre / status / order controls, for the atsu catalogue only. */
  filters?: BrowseCatalogFilters;
  /** Show each card's `badge` (e.g. "2h ago") under its title instead of its type. */
  badgeSubtitle?: boolean;
  /** The small line above the title; defaults to the source's name. */
  eyebrow?: string;
}
export default function BrowseCatalogWeb(_props: BrowseCatalogWebProps) { return null; }
