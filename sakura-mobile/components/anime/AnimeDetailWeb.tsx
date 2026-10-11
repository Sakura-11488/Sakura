import type { ReactNode } from 'react';
import type { AnimeEpisode, AnimeInfo } from '@/lib/anime';
import type { OfflineEpisode } from '@/lib/anime-offline';
import type { AnimeWatchProgress } from '@/lib/watch-progress';

export interface AnimeDetailWebProps {
  anime: AnimeInfo;
  progress: AnimeWatchProgress | null;
  saved: boolean;
  offline: Record<string, OfflineEpisode>;
  downloadable: boolean;
  onBack: () => void;
  onSave: () => void;
  onShare: () => void;
  onPlay: (episode: AnimeEpisode, restart?: boolean) => void;
  onDownload: (episode: AnimeEpisode) => void;
  discussion: ReactNode;
  creator?: ReactNode;
}

export interface AnimeDetailWebPlaceholderProps {
  onBack: () => void;
  error?: string;
  onRetry?: () => void;
}

// The native route retains its existing layout. Metro resolves the DOM-based
// implementation in AnimeDetailWeb.web.tsx only for the browser bundle.
export default function AnimeDetailWeb(_props: AnimeDetailWebProps) {
  return null;
}

export function AnimeDetailWebPlaceholder(_props: AnimeDetailWebPlaceholderProps) {
  return null;
}
