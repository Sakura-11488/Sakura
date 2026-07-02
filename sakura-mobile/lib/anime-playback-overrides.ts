/** Apothecary Diaries S2 — MAL id */
export const APOTHECARY_DIARIES_S2_MAL = '58514';

export type SubtitleMode = 'auto' | 'off';

export type EpisodePlaybackHint = {
  /** Bypass cached slug/source mapping and re-resolve from provider */
  forceFreshSource?: boolean;
  /** Prefer direct HLS/MP4 over embed WebView when a stream URL exists */
  preferDirectHls?: boolean;
  /** Default subtitle rendering for direct web playback */
  subtitleMode?: SubtitleMode;
};

const HINTS: Record<string, Partial<Record<number, EpisodePlaybackHint>>> = {
  [APOTHECARY_DIARIES_S2_MAL]: {
    15: { preferDirectHls: true, subtitleMode: 'off' },
    16: { preferDirectHls: true, subtitleMode: 'off' },
    19: { forceFreshSource: true, preferDirectHls: true },
    20: { forceFreshSource: true, preferDirectHls: true },
  },
};

export function getEpisodePlaybackHint(
  malId: string | undefined,
  episodeNumber: number,
): EpisodePlaybackHint | null {
  if (!malId || !Number.isFinite(episodeNumber)) return null;
  const row = HINTS[malId];
  if (!row) return null;
  const hint = row[episodeNumber];
  return hint ? { ...hint } : null;
}

export function shouldPreferDirectPlayback(
  hint: EpisodePlaybackHint | null,
  platformIsWeb: boolean,
): boolean {
  return !!hint?.preferDirectHls || platformIsWeb;
}
