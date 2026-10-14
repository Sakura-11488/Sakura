import type { AnimeEpisode, AnimeInfo } from './anime';
import type { OfflineEpisode } from './anime-offline';

/**
 * Episode ids from the MAL catalog (mal-<mal id>-<n>) or the streaming
 * provider (hi-<provider id>-<n>). Both name an episode by its number within
 * one title, so the same episode can carry either id over time.
 */
export const CATALOG_EPISODE_ID = /^(?:mal|hi)-\d+-\d+$/;

/** Whether a saved id (and its episode number) names this episode, under either catalog id. */
export function sameCatalogEpisode(
  episode: Pick<AnimeEpisode, 'id' | 'number'>,
  episodeId: string | undefined,
  episodeNumber: number | undefined,
): boolean {
  if (!episodeId) return false;
  return episode.id === episodeId || (CATALOG_EPISODE_ID.test(episode.id) && CATALOG_EPISODE_ID.test(episodeId)
    && episodeNumber !== undefined && episode.number === episodeNumber);
}

/**
 * Downloads keep the id they were saved under. Airing series used to list
 * provider ids (hi-…) and now list MAL ids (mal-…) from AniList, or the reverse
 * when AniList is unavailable, so a copy saved before the switch no longer
 * matched its row: no "Saved" badge, no offline playback from the title page,
 * and the download button offered to fetch it again. An episode whose copy was
 * saved under the other id takes that id, so every lookup by id finds it.
 * (Watch progress already matches either id by episode number.)
 *
 * `offline` holds this title's rows keyed by episode id. Returns the same
 * object when nothing needs renaming, so memoised consumers do not re-render.
 */
export function withDownloadIds<T extends Pick<AnimeInfo, 'episodes'>>(
  info: T | null,
  offline: Record<string, Pick<OfflineEpisode, 'episodeId' | 'episodeNumber' | 'status'>>,
): T | null {
  if (!info?.episodes.length) return info;
  const byNumber = new Map<number, Pick<OfflineEpisode, 'episodeId' | 'episodeNumber' | 'status'>>();
  for (const row of Object.values(offline)) {
    if (!CATALOG_EPISODE_ID.test(row.episodeId) || !Number.isSafeInteger(row.episodeNumber)) continue;
    const current = byNumber.get(row.episodeNumber);
    // A finished copy beats a partial one saved under the other id.
    if (!current || (row.status === 'ready' && current.status !== 'ready')) byNumber.set(row.episodeNumber, row);
  }
  if (!byNumber.size) return info;
  let changed = false;
  const episodes = info.episodes.map((episode) => {
    if (offline[episode.id] || !CATALOG_EPISODE_ID.test(episode.id)) return episode;
    const row = byNumber.get(episode.number);
    if (!row || row.episodeId === episode.id) return episode;
    changed = true;
    return { ...episode, id: row.episodeId };
  });
  return changed ? { ...info, episodes } : info;
}
