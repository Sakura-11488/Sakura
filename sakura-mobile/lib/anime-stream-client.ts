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
