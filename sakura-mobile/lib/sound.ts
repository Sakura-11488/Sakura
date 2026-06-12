import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';

let tapPlayer: AudioPlayer | null = null;
let switchPlayer: AudioPlayer | null = null;
let initialized = false;

async function ensureLoaded() {
  if (initialized) return;
  initialized = true;
  try {
    await setAudioModeAsync({ playsInSilentMode: false });
    tapPlayer    = createAudioPlayer(require('@/assets/sounds/tap.mp3'));
    switchPlayer = createAudioPlayer(require('@/assets/sounds/switch.wav'));
    tapPlayer.volume    = 0.6;
    switchPlayer.volume = 0.5;
  } catch {}
}

async function play(getPlayer: () => AudioPlayer | null) {
  await ensureLoaded();
  const player = getPlayer();
  if (!player) return;
  try {
    await player.seekTo(0);
    player.play();
  } catch {}
}

export const playTap    = () => play(() => tapPlayer);
export const playSwitch = () => play(() => switchPlayer);

/** Play tap sound, then run the action — use for back/nav/header buttons. */
export function onTap(action: () => void): () => void {
  return () => {
    playTap();
    action();
  };
}
