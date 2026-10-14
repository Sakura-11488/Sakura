import type { SubtitleMode } from '@/lib/anime-playback-overrides';

export type SubtitleLanguage = { code?: string; label?: string };
export type CaptionSize = 'small' | 'medium' | 'large';
export type CaptionBackground = 'none' | 'soft' | 'solid';
export type QualityPreference = 'auto' | 'balanced' | 'data-saver';
export type PlayerPreferences = {
  volume: number; muted: boolean; speed: number; captions?: SubtitleMode;
  autoplayNext: boolean; audio?: 'sub' | 'dub'; subtitleLanguage?: SubtitleLanguage;
  captionSize: CaptionSize; captionBackground: CaptionBackground; qualityPreference: QualityPreference;
  /** Jump past openings and endings automatically when their timings are known. Off by default. */
  autoSkip: boolean;
};
const KEY = 'sakura.player.preferences.v1';
const shortText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined;
export function readPlayerPreferences(): PlayerPreferences {
  const defaults: PlayerPreferences = { volume: 1, muted: false, speed: 1, autoplayNext: true, audio: 'sub', captionSize: 'medium', captionBackground: 'soft', qualityPreference: 'auto', autoSkip: false };
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    const code = shortText(value.subtitleLanguage?.code), label = shortText(value.subtitleLanguage?.label);
    return {
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : 1,
      muted: value.muted === true,
      speed: [0.75, 1, 1.25, 1.5, 1.75, 2].includes(value.speed) ? value.speed : 1,
      autoplayNext: value.autoplayNext !== false,
      audio: value.audio === 'dub' ? 'dub' : 'sub',
      captions: value.captions === 'off' || value.captions === 'auto' ? value.captions : undefined,
      subtitleLanguage: code || label ? { code, label } : undefined,
      captionSize: value.captionSize === 'small' || value.captionSize === 'large' ? value.captionSize : 'medium',
      captionBackground: value.captionBackground === 'none' || value.captionBackground === 'solid' ? value.captionBackground : 'soft',
      qualityPreference: value.qualityPreference === 'balanced' || value.qualityPreference === 'data-saver' ? value.qualityPreference : 'auto',
      autoSkip: value.autoSkip === true,
    };
  } catch { return defaults; }
}
export function savePlayerPreferences(patch: Partial<PlayerPreferences>): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readPlayerPreferences(), ...patch })); } catch { /* Private browsing still supports playback. */ }
}
