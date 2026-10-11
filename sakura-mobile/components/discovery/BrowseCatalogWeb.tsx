import type { ContentItem } from '@/components/ui/ContentCard';
export interface BrowseCatalogWebProps { title: string; source: string; items: ContentItem[]; loading: boolean; loadingMore: boolean; hasMore: boolean; error: string; onBack: () => void; onRetry: () => void; onLoadMore: () => void; }
export default function BrowseCatalogWeb(_props: BrowseCatalogWebProps) { return null; }
