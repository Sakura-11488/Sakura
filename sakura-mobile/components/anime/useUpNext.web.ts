import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerChromeOptions } from './player-types';
import { readPlayerPreferences, savePlayerPreferences } from './player-preferences';

const COUNTDOWN_MS = 5000;
type UpNextState = { remainingMs: number | null; paused: boolean } | null;
type Controller = { play: () => void; cancel: () => void; clear: () => void; setAutoplay: () => void };

/** A timer belongs to one source and can hand off to the next episode only once. */
export default function useUpNext(
  videoRef: RefObject<HTMLVideoElement | null>,
  sourceKey: string,
  nextEpisode: PlayerChromeOptions['nextEpisode'],
) {
  const [autoplay, setAutoplay] = useState(() => readPlayerPreferences().autoplayNext);
  const autoplayRef = useRef(autoplay);
  const [upNext, setUpNext] = useState<UpNextState>(null);
  const controller = useRef<Controller | null>(null);
  const latest = useRef({ sourceKey, nextEpisode });
  // The countdown does not restart when its parent supplies a new callback.
  useLayoutEffect(() => { latest.current = { sourceKey, nextEpisode }; }, [sourceKey, nextEpisode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false, completed = false, cancelled = false, transitioned = false;
    let remainingMs = COUNTDOWN_MS;
    let startedAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !disposed && latest.current.sourceKey === sourceKey;
    const stopClock = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (startedAt !== null) remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt));
      startedAt = null;
    };
    const clear = () => {
      stopClock();
      completed = false;
      if (isCurrent()) setUpNext(null);
    };
    const play = () => {
      if (!isCurrent() || transitioned || !latest.current.nextEpisode) return;
      // Claim before invoking navigation: synchronous renders or repeated ended
      // events must never dispatch a second transition for the current source.
      transitioned = true;
      clear();
      latest.current.nextEpisode.onPlay();
    };
    const publish = () => {
      if (isCurrent()) setUpNext({ remainingMs: autoplayRef.current ? remainingMs : null, paused: document.visibilityState === 'hidden' });
    };
    const tick = () => {
      stopClock();
      if (!isCurrent() || !completed || cancelled || transitioned || !latest.current.nextEpisode) { clear(); return; }
      if (!autoplayRef.current || document.visibilityState === 'hidden') { publish(); return; }
      if (remainingMs <= 0) { play(); return; }
      publish();
      startedAt = performance.now();
      timer = setTimeout(tick, Math.min(250, remainingMs));
    };
    const onEnded = () => {
      // Progress percentages and opening/ending markers never start autoplay.
      if (!isCurrent() || !video.ended || completed || cancelled || transitioned || !latest.current.nextEpisode) return;
      completed = true;
      remainingMs = COUNTDOWN_MS;
      tick();
    };
    const cancel = () => { cancelled = true; clear(); };
    const changeAutoplay = () => {
      if (!completed || !isCurrent()) return;
      stopClock();
      remainingMs = COUNTDOWN_MS;
      tick();
    };
    const onVisibility = () => { if (completed) tick(); };
    const actions = { play, cancel, clear, setAutoplay: changeAutoplay };
    controller.current = actions;
    setUpNext(null);
    video.addEventListener('ended', onEnded);
    video.addEventListener('play', clear);
    video.addEventListener('seeking', clear);
    video.addEventListener('seeked', clear);
    video.addEventListener('emptied', clear);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      stopClock();
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('play', clear);
      video.removeEventListener('seeking', clear);
      video.removeEventListener('seeked', clear);
      video.removeEventListener('emptied', clear);
      document.removeEventListener('visibilitychange', onVisibility);
      if (controller.current === actions) controller.current = null;
    };
  }, [sourceKey, videoRef]);

  const toggleAutoplay = useCallback(() => {
    const enabled = !autoplayRef.current;
    autoplayRef.current = enabled;
    setAutoplay(enabled);
    savePlayerPreferences({ autoplayNext: enabled });
    controller.current?.setAutoplay();
  }, []);
  const playNext = useCallback(() => { controller.current?.play(); }, []);
  const cancelNext = useCallback(() => { controller.current?.cancel(); }, []);
  const clearNext = useCallback(() => { controller.current?.clear(); }, []);
  return { upNext, autoplay, toggleAutoplay, playNext, cancelNext, clearNext };
}
