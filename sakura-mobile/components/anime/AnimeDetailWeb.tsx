import type { ReactNode } from 'react';
import type { AnimeEpisode, AnimeInfo } from '@/lib/anime';
import type { OfflineEpisode } from '@/lib/anime-offline';
import type { AnimeWatchProgress } from '@/lib/watch-progress';
import type { WatchlistStatus } from '@/lib/anime-watchlist';

export interface AnimeDetailWebProps {
  anime: AnimeInfo;
  progress: AnimeWatchProgress | null;
  saved: boolean;
  offline: Record<string, OfflineEpisode>;
  /** This title's episodes can be kept for offline viewing. */
  downloadable: boolean;
  /**
   * The offline copy is an HLS playlist (every title but Sakura Originals). It
   * only plays where hls.js runs on MediaSource, so the button is also hidden
   * in browsers without it (Safari before iOS 17.1).
   */
  downloadsNeedHls?: boolean;
  /** A banner above the title, e.g. "showing downloads only" when offline. */
  notice?: { text: string; actionLabel?: string; onAction?: () => void };
  onBack: () => void;
  onSave: () => void;
  onShare: () => void;
  onPlay: (episode: AnimeEpisode, restart?: boolean) => void;
  onDownload: (episode: AnimeEpisode) => void;
  onMarkWatched?: (episode: AnimeEpisode, watched: boolean) => void;
  discussion: ReactNode;
  creator?: ReactNode;
  /** The hero comes from a preview or metadata; the episode list is still loading. */
  episodesLoading?: boolean;
  /** Watching / Plan to watch / … for this title, or null when it is not listed. */
  listStatus?: WatchlistStatus | null;
  onListStatus?: (status: WatchlistStatus | null) => void;
  /** Start resolving an episode's stream ahead of a likely play. */
  onPrewarm?: (episode: AnimeEpisode) => void;
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
