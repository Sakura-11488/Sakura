import type Hls from 'hls.js';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';
import type { QualityPreference, SubtitleLanguage } from './player-preferences';

type LanguageTrack = { language?: string; lang?: string; label?: string; name?: string; mode?: string };
const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en', english: 'en', jpn: 'ja', japanese: 'ja', 日本語: 'ja', spa: 'es', spanish: 'es', espanol: 'es',
  fra: 'fr', fre: 'fr', french: 'fr', francais: 'fr', por: 'pt', portuguese: 'pt', portugues: 'pt',
  deu: 'de', ger: 'de', german: 'de', deutsch: 'de', ita: 'it', italian: 'it', italiano: 'it',
  ara: 'ar', arabic: 'ar', rus: 'ru', russian: 'ru', zho: 'zh', chi: 'zh', chinese: 'zh',
  kor: 'ko', korean: 'ko', hin: 'hi', hindi: 'hi', tur: 'tr', turkish: 'tr', ind: 'id', indonesian: 'id',
  tha: 'th', thai: 'th', vie: 'vi', vietnamese: 'vi', pol: 'pl', polish: 'pl', ukr: 'uk', ukrainian: 'uk',
};
const normalize = (value = '') => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/_/g, '-');
function languageCode(code = '', label = ''): string {
  const normalized = normalize(code);
  if (normalized) {
    const [base, ...region] = normalized.split('-');
    return [LANGUAGE_ALIASES[base] ?? base, ...region].join('-');
  }
  return LANGUAGE_ALIASES[normalize(label)] ?? normalize(label).split(/[\s(\[]/).map(word => LANGUAGE_ALIASES[word]).find(Boolean) ?? '';
}
/** Prefer a saved code/label, then a currently showing track, English, or the first available track. */
export function preferredSubtitleIndex(tracks: readonly LanguageTrack[], preferred?: SubtitleLanguage): number {
  if (!tracks.length) return -1;
  const preferredCode = languageCode(preferred?.code, preferred?.label), preferredLabel = normalize(preferred?.label);
  const scores: number[] = tracks.map(track => {
    const code = languageCode(track.language || track.lang, track.label || track.name), label = normalize(track.label || track.name);
    const labelMatches = !!preferredLabel && label === preferredLabel;
    if (preferredCode && code === preferredCode) return labelMatches ? 120 : 100;
    if (preferredCode && code && code.split('-')[0] === preferredCode.split('-')[0]) return labelMatches ? 95 : 90;
    return labelMatches ? 80 : 0;
  });
  const best = Math.max(...scores);
  if (best) return scores.indexOf(best);
  const showing = tracks.findIndex(track => track.mode === 'showing');
  if (showing >= 0) return showing;
  const english = tracks.findIndex(track => languageCode(track.language || track.lang, track.label || track.name).split('-')[0] === 'en');
  return english >= 0 ? english : 0;
}

export function applySubtitlePreferences(video: HTMLVideoElement, hls: Hls | null, mode: SubtitleMode, preferred?: SubtitleLanguage): void {
  if (hls) {
    hls.subtitleDisplay = mode !== 'off';
    const index = mode === 'off' ? -1 : preferredSubtitleIndex(hls.subtitleTracks ?? [], preferred);
    if (hls.subtitleTrack !== index) hls.subtitleTrack = index;
  }
  const tracks = Array.from(video.textTracks ?? []).filter(track => track.kind === 'subtitles' || track.kind === 'captions');
  const selected = mode === 'off' ? -1 : preferredSubtitleIndex(tracks, preferred);
  tracks.forEach((track, index) => { const mode = index === selected ? 'showing' : 'disabled'; if (track.mode !== mode) track.mode = mode; });
}

type Level = { height?: number; bitrate?: number };
export function qualityLimit(levels: readonly Level[], preference: QualityPreference): { index: number; pinned: boolean } {
  if (preference === 'auto' || !levels.length) return { index: -1, pinned: false };
  const ceiling = preference === 'balanced' ? 720 : 480;
  const under = (level: Level) => !!level.height && level.height > 0 && level.height <= ceiling;
  // Hls sorts variants by resolution. A conservative prefix also handles unusual
  // HDCP/codec groups without letting a high-resolution level through the cap.
  let prefix = -1;
  for (let i = 0; i < levels.length && under(levels[i]); i++) prefix = i;
  if (prefix >= 0) return { index: prefix, pinned: false };
  const candidates = levels.map((level, index) => ({ ...level, index })).filter(under);
  if (candidates.length) return { index: candidates.reduce((a, b) => (b.height ?? 0) > (a.height ?? 0) ? b : a).index, pinned: true };
  const lowest = levels.map((level, index) => ({ ...level, index })).reduce((a, b) => {
    const aSize = a.height || Infinity, bSize = b.height || Infinity;
    return bSize < aSize || (bSize === aSize && (b.bitrate ?? Infinity) < (a.bitrate ?? Infinity)) ? b : a;
  });
  return { index: lowest.index, pinned: lowest.index > 0 };
}

export function applyQualityPreference(hls: Hls, preference: QualityPreference, initial = false, resetManual = false): void {
  const { index, pinned } = qualityLimit(hls.levels ?? [], preference);
  hls.autoLevelCapping = pinned ? -1 : index;
  if (pinned) hls.loadLevel = index;
  else if (resetManual || hls.autoLevelEnabled === false) hls.loadLevel = -1;
  if (initial && index >= 0) hls.startLevel = pinned ? index : Math.min(Math.max(hls.startLevel, 0), index);
  if (index >= 0 && !pinned) hls.nextAutoLevel = index;
}
