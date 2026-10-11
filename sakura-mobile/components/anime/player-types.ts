import type { StyleProp, ViewStyle } from 'react-native';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';

export type WebVideoPlayerHandle = { seekTo: (seconds: number) => void };
export type PlayerChromeOptions = {
  title: string;
  episodeLabel?: string;
  episodeNumber?: number;
  onBack?: () => void;
  category?: 'sub' | 'dub';
  availableCategories?: string[];
  onToggleCategory?: () => void;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  nextEpisode?: { label: string; title?: string; number?: number; thumbnail?: string; onPlay: () => void };
};
export type WebVideoPlayerProps = {
  uri: string;
  headers?: Record<string, string>;
  isM3U8?: boolean;
  subtitleMode?: SubtitleMode;
  subtitles?: Array<{ url: string; lang: string; label: string }>;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onCheckpoint?: (currentTime: number, duration: number, ended?: boolean) => void;
  startAt?: number;
  startProgress?: number;
  chrome?: PlayerChromeOptions;
};
