import { downloadAnimeEpisode } from '@/lib/anime-offline';
import type { AnimeDeviceSaveSnapshot } from './anime-device-save-types';

// Browser file export is separate from the native app's download store.
export const CAN_SAVE_ANIME_VIDEO = false;
export const downloadAnimeEpisodeWithDeviceCopy = downloadAnimeEpisode;
export function requestAnimeVideoSave(_animeId: string, _episodeId: string): void {}
export function subscribeAnimeDeviceSave(_listener: () => void): () => void { return () => {}; }
export function getAnimeDeviceSaveSnapshot(): AnimeDeviceSaveSnapshot | null { return null; }
export function dismissAnimeDeviceSave(): void {}
export function retryAnimeDeviceSave(): void {}
export async function shareAnimeDeviceVideo(): Promise<void> {}
export function startAnimeDeviceDownload(): void {}
