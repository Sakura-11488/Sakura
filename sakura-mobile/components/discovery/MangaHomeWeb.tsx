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
  genres: { title: string; query: string; items: ContentItem[] }[];
  loading: boolean;
  onRefresh: () => void;
  onBrowse: (title: string, options: { q?: string; kind?: string }) => void;
  community: ReactNode;
  continueReading: ReactNode;
  continueWatching: ReactNode;
  streak: ReactNode;
  scrollRef: Ref<{ scrollToTop: () => void }>;
}

// DOM implementation is selected only by Metro's web resolver.
export default function MangaHomeWeb(_props: MangaHomeWebProps) { return null; }
