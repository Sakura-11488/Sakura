/** Browser export only. Native downloads are already managed by the native store. */
import type { OfflineEpisode } from './anime-offline';
export interface AnimeVideoExportOptions { signal?: AbortSignal; onProgress?: (value: number) => void }
export interface AnimeVideoExportResult { mimeType: string; extension: 'mp4' | 'mov'; bytes: number }
export async function writeAnimeVideo(
  _cache: Cache,
  _episode: Pick<OfflineEpisode, 'status' | 'localPlaylistUri' | 'format'>,
  _write: (chunk: Uint8Array) => Promise<void>,
  _options: AnimeVideoExportOptions = {},
): Promise<AnimeVideoExportResult> {
  throw new Error('Browser video export is unavailable on this platform.');
}
