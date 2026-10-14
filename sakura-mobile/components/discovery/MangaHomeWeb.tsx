import type { ReactNode, Ref } from 'react';
import type { ContentItem } from '@/components/ui/ContentCard';
import type { CarouselItem } from '@/components/ui/FeaturedCarousel';

export interface MangaHomeWebProps {
  category: string;
  categories: string[];
  onCategory: (category: string) => void;
  featured: CarouselItem[];
  trending: ContentItem[];
  popular: ContentItem[];
  more: ContentItem[];
  picks: ContentItem[];
  /** Genre shelves: `genre` (an atsu genre id) for the Manga tab, `query` (a title search) for scraped sources. */
  genres: { title: string; query: string; genre?: string; items: ContentItem[] }[];
  /** Titles that just got a chapter, each `badge` saying how long ago (Manga tab only). */
  updates?: ContentItem[];
  /** Open the full list of updates. */
  onUpdates?: () => void;
  /** Nothing has arrived yet. */
  loading: boolean;
  /**
   * Per list, so each part of the page shows as soon as its own data arrives:
   * trending feeds the featured slot and hot list, popular the shelves.
   * Both fall back to `loading`.
   */
  trendingLoading?: boolean;
  popularLoading?: boolean;
  onRefresh: () => void;
  onBrowse: (title: string, options: { q?: string; kind?: string; genre?: string }) => void;
  community: ReactNode;
  continueReading: ReactNode;
  continueWatching: ReactNode;
  streak: ReactNode;
  scrollRef: Ref<{ scrollToTop: () => void }>;
}

// DOM implementation is selected only by Metro's web resolver.
export default function MangaHomeWeb(_props: MangaHomeWebProps) { return null; }
