import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchAnimeAiringStatus } from '@/lib/anime-discovery';
import {
  findNewEpisodes,
  getWatchlist,
  highestWatchedEpisode,
  subscribeWatchlist,
  type NewEpisodeItem,
  type WatchlistEntry,
} from '@/lib/anime-watchlist';
import { getAllWatchHistory, hasAnimeViewingHistory } from '@/lib/watch-progress';

export type AnimeListsState = {
  entries: WatchlistEntry[];
  newEpisodes: NewEpisodeItem[];
};

/**
 * The viewer's anime list and the "New episodes for you" shelf, shared by the
 * web and native Anime tabs.
 *
 * Candidates for new episodes are titles with real viewing history (or listed
 * as Watching), minus anything Completed or Dropped. Their airing state comes
 * from one AniList request for up to 50 titles, cached for 15 minutes, so
 * revisiting the tab costs nothing. `withNewEpisodes` is false for a caller
 * that only shows the list, which then makes no network request at all.
 */
export default function useAnimeLists(withNewEpisodes: boolean): AnimeListsState {
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<NewEpisodeItem[]>([]);
  const revision = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const run = ++revision.current;
    const [list, history] = await Promise.all([getWatchlist(), withNewEpisodes ? getAllWatchHistory() : Promise.resolve([])]);
    if (run !== revision.current || signal?.aborted) return;
    setEntries(list);
    if (!withNewEpisodes) return;
    const statuses = new Map(list.map((entry) => [entry.animeId, entry.status]));
    const candidates = history
      .filter((item) => hasAnimeViewingHistory(item) && statuses.get(item.animeId) !== 'completed' && statuses.get(item.animeId) !== 'dropped')
      .sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt))
      .slice(0, 50)
      .map((item) => ({
        animeId: item.animeId,
        title: item.title,
        cover: item.cover,
        highestWatched: highestWatchedEpisode(item),
        lastPlayedAt: item.lastPlayedAt ?? item.updatedAt,
      }))
      .filter((candidate) => candidate.highestWatched > 0);
    if (!candidates.length) { setNewEpisodes([]); return; }
    try {
      const airing = await fetchAnimeAiringStatus(candidates.map((candidate) => candidate.animeId), { signal });
      if (run === revision.current && !signal?.aborted) setNewEpisodes(findNewEpisodes(candidates, airing));
    } catch {
      // The shelf is a bonus: when AniList is busy it simply does not appear.
    }
  }, [withNewEpisodes]);

  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]));

  useEffect(() => subscribeWatchlist(() => { void refresh(); }), [refresh]);

  return { entries, newEpisodes };
}
