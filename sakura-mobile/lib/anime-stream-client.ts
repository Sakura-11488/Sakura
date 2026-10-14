import type { StreamingSource } from './anime';

export interface AnimeStreamRequest {
  malId: string;
  episode: number;
  category: 'sub' | 'dub';
  force?: boolean;
}

export const usesBrowserAnimeStream = false;

/** Native keeps its existing provider/native-header playback path. */
export async function fetchBrowserAnimeStream(_request: AnimeStreamRequest): Promise<StreamingSource | null> {
  return null;
}

/** Native resolves its stream at play time through the provider; nothing to warm. */
export function prewarmBrowserAnimeStream(_request: Omit<AnimeStreamRequest, 'force'>): void {}
