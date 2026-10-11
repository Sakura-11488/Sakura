import type { SubtitleMode } from '@/lib/anime-playback-overrides';

export type PlayerPreferences = { volume: number; muted: boolean; speed: number; captions?: SubtitleMode };
const KEY = 'sakura.player.preferences.v1';
export function readPlayerPreferences(): PlayerPreferences {
  const defaults: PlayerPreferences = { volume: 1, muted: false, speed: 1 };
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      volume: typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : 1,
      muted: value.muted === true,
      speed: [0.75, 1, 1.25, 1.5, 1.75, 2].includes(value.speed) ? value.speed : 1,
      captions: value.captions === 'off' || value.captions === 'auto' ? value.captions : undefined,
    };
  } catch { return defaults; }
}
export function savePlayerPreferences(patch: Partial<PlayerPreferences>): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readPlayerPreferences(), ...patch })); } catch { /* Private browsing still supports playback. */ }
}
