/**
 * Pure decisions behind the web player's keyboard, touch and skip behaviour,
 * kept out of PlayerChrome so they can be tested without a browser.
 */

export const PLAYER_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type PlayerShortcut =
  | { type: 'toggle-play' }
  | { type: 'seek-by'; seconds: number }
  | { type: 'seek-fraction'; fraction: number }
  | { type: 'volume'; delta: number }
  | { type: 'speed'; step: 1 | -1 }
  | { type: 'mute' }
  | { type: 'fullscreen' }
  | { type: 'pip' }
  | { type: 'next' }
  | { type: 'captions' }
  | { type: 'help' };

/** What has focus when the key is pressed; decides which keys the page must leave alone. */
export type ShortcutTarget = 'text' | 'range' | 'button' | 'dialog' | 'other';

/**
 * The shortcuts YouTube, Netflix and Crunchyroll viewers already know:
 * Space/K play-pause, J/L ∓10 s, ←/→ ∓5 s, ↑/↓ volume, 0–9 jump to 0–90 %,
 * F fullscreen, M mute, I picture-in-picture, N next episode, C captions,
 * Shift+> / Shift+< speed, ? the list.
 *
 * Keys a focused control handles itself are left to it: Space and Enter press
 * a focused button, arrows move a focused slider, and nothing fires while
 * typing or inside the settings menu. (The previous handler ignored every key
 * whenever any button had focus, so after clicking a control the shortcuts
 * silently stopped working.)
 */
export function shortcutFor(event: { key: string; shiftKey?: boolean }, target: ShortcutTarget): PlayerShortcut | null {
  if (target === 'text' || target === 'dialog') return null;
  const key = event.key;
  if (key === '>' || (event.shiftKey && key === '.')) return { type: 'speed', step: 1 };
  if (key === '<' || (event.shiftKey && key === ',')) return { type: 'speed', step: -1 };
  if (key === '?') return { type: 'help' };
  switch (key.toLowerCase()) {
    case ' ':
    case 'spacebar':
      return target === 'button' ? null : { type: 'toggle-play' };
    case 'k': return { type: 'toggle-play' };
    case 'j': return { type: 'seek-by', seconds: -10 };
    case 'l': return { type: 'seek-by', seconds: 10 };
    case 'arrowleft': return target === 'range' ? null : { type: 'seek-by', seconds: -5 };
    case 'arrowright': return target === 'range' ? null : { type: 'seek-by', seconds: 5 };
    case 'arrowup': return target === 'range' ? null : { type: 'volume', delta: 0.05 };
    case 'arrowdown': return target === 'range' ? null : { type: 'volume', delta: -0.05 };
    case 'm': return { type: 'mute' };
    case 'f': return { type: 'fullscreen' };
    case 'i': return { type: 'pip' };
    case 'n': return { type: 'next' };
    case 'c': return { type: 'captions' };
    default:
      if (!event.shiftKey && /^[0-9]$/.test(key)) return { type: 'seek-fraction', fraction: Number(key) / 10 };
      return null;
  }
}

/** Next step on the speed ladder; an off-ladder rate snaps to the nearest step in that direction. */
export function nextPlayerSpeed(current: number, step: 1 | -1): number {
  const speeds = [...PLAYER_SPEEDS];
  if (step > 0) return speeds.find((speed) => speed > current + 0.001) ?? speeds[speeds.length - 1];
  return [...speeds].reverse().find((speed) => speed < current - 0.001) ?? speeds[0];
}

export type TapState = { at: number; side: -1 | 0 | 1; count: number } | null;

/** Left and right thirds seek; the middle third is left for play/pause and the controls. */
export function tapSide(x: number, width: number): -1 | 0 | 1 {
  if (!(width > 0)) return 0;
  const ratio = x / width;
  return ratio < 0.35 ? -1 : ratio > 0.65 ? 1 : 0;
}

/**
 * Double-tap to seek, as in every phone video app: the second tap on the same
 * side within 320 ms seeks 10 s, and each further quick tap adds another 10 s.
 * Returns the new tap state and how far to seek now (0 for a lone tap).
 */
export function registerTap(previous: TapState, now: number, side: -1 | 0 | 1, windowMs = 320): { state: TapState; seekBy: number; total: number } {
  if (side !== 0 && previous && previous.side === side && now - previous.at <= windowMs) {
    const count = previous.count + 1;
    return { state: { at: now, side, count }, seekBy: side * 10, total: (count - 1) * 10 };
  }
  return { state: { at: now, side, count: 1 }, seekBy: 0, total: 0 };
}

export type SkipMarker = { start: number; end: number };

/** A marker is usable only when it is ordered and sits inside the playing media. */
export function validSkipMarker(marker: SkipMarker | undefined, duration: number): marker is SkipMarker {
  return !!marker && Number.isFinite(marker.start) && Number.isFinite(marker.end) && marker.start >= 0
    && marker.end > marker.start && Number.isFinite(duration) && duration > 0 && marker.end <= duration;
}

/**
 * Where auto-skip should jump, or null. Only while playing, only inside the
 * marker (not in its last second, where skipping gains nothing), and once per
 * marker: after Undo, or a manual seek back into it, the viewer keeps control.
 */
export function autoSkipTarget(time: number, duration: number, marker: SkipMarker | undefined, handled: boolean, playing: boolean): number | null {
  if (!playing || handled || !validSkipMarker(marker, duration)) return null;
  return time >= marker.start && time < marker.end - 1 ? marker.end : null;
}

/** Percent geometry for drawing a skip marker on the timeline. */
export function markerSpan(marker: SkipMarker | undefined, duration: number): { left: number; width: number } | null {
  if (!validSkipMarker(marker, duration)) return null;
  const left = (marker.start / duration) * 100;
  const width = Math.max(0.4, ((marker.end - marker.start) / duration) * 100);
  return { left, width: Math.min(width, 100 - left) };
}
