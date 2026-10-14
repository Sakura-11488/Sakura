import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Platform services for the novel reader — native implementations.
 * The web versions live in reader-platform.web.ts with the same exports.
 */

export type ReaderKeyAction =
  | 'page-down'
  | 'page-up'
  | 'line-down'
  | 'line-up'
  | 'top'
  | 'bottom'
  | 'next-chapter'
  | 'prev-chapter'
  | 'toggle-controls'
  | 'auto-scroll';

/**
 * Save before the app can be killed. Backgrounding is the last reliable moment
 * on Android and iOS; the reader also saves on its own schedule and on exit.
 */
export function useFlushOnBackground(flush: () => void) {
  const ref = useRef(flush);
  ref.current = flush;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') ref.current();
    });
    return () => sub.remove();
  }, []);
}

/**
 * Native keeps its existing behaviour (the OS screen timeout applies): holding
 * the screen on needs expo-keep-awake linked into the binary, which has to
 * ship in a new build rather than over the air.
 */
export function useKeepScreenAwake(_enabled: boolean): { noteActivity: () => void } {
  return { noteActivity: () => {} };
}

/** Hardware keyboards on native are rare enough not to bind; web binds keys. */
export function useReaderKeys(_handler: (action: ReaderKeyAction) => boolean | void, _enabled: boolean) {}

export function fullscreenSupported(): boolean {
  return false;
}
export function useFullscreen(): { active: boolean; toggle: () => void } {
  return { active: false, toggle: () => {} };
}

/** Text selection only exists on web here; a tap is always a tap on native. */
export function hasTextSelection(): boolean {
  return false;
}

export function prefersReducedMotion(): boolean {
  return false;
}

/** Touch-first on native, so edge taps turn pages by default. */
export function defaultTapZones(): boolean {
  return true;
}
