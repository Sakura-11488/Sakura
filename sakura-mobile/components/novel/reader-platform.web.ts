import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderKeyAction } from './reader-platform';

export type { ReaderKeyAction } from './reader-platform';

/**
 * Platform services for the novel reader — browser implementations of the
 * same exports as reader-platform.ts. Everything here is feature-detected and
 * fails quietly: a browser without the Wake Lock or Fullscreen API simply
 * does not get that feature, and never logs an error.
 */

/**
 * Save when the tab is hidden or unloaded.
 *
 * `pagehide` is the last event a mobile browser reliably delivers (unload and
 * beforeunload are skipped when a backgrounded tab is discarded), and
 * `visibilitychange` → hidden covers switching apps, which is when a PWA is
 * most often killed. localStorage writes are synchronous, so the save lands.
 */
export function useFlushOnBackground(flush: () => void) {
  const ref = useRef(flush);
  ref.current = flush;
  useEffect(() => {
    const onHide = () => ref.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') ref.current();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}

type WakeLockSentinelLike = { released: boolean; release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };

/** Let the screen sleep again after this long without scrolling or tapping. */
const IDLE_RELEASE_MS = 10 * 60 * 1000;

/**
 * Keep the screen on while reading (Screen Wake Lock API).
 *
 * A phone dimming mid-chapter is the most common complaint about web readers.
 * The lock is dropped after ten idle minutes so a reader left open on a desk
 * does not drain the battery, re-taken on the next scroll or tap, and re-taken
 * when the tab becomes visible again (browsers release it on hide).
 */
export function useKeepScreenAwake(enabled: boolean): { noteActivity: () => void } {
  const sentinel = useRef<WakeLockSentinelLike | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requesting = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const release = useCallback(() => {
    const s = sentinel.current;
    sentinel.current = null;
    if (s && !s.released) void s.release().catch(() => undefined);
  }, []);

  const acquire = useCallback(() => {
    const api = (navigator as WakeLockNavigator).wakeLock;
    if (!api || !enabledRef.current || requesting.current) return;
    if (document.visibilityState !== 'visible') return;
    if (sentinel.current && !sentinel.current.released) return;
    requesting.current = true;
    api
      .request('screen')
      .then((s) => {
        sentinel.current = s;
        if (!enabledRef.current) release();
      })
      // NotAllowedError (battery saver, permissions policy) is not our error to show.
      .catch(() => undefined)
      .finally(() => {
        requesting.current = false;
      });
  }, [release]);

  const noteActivity = useCallback(() => {
    if (!enabledRef.current) return;
    acquire();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(release, IDLE_RELEASE_MS);
  }, [acquire, release]);

  useEffect(() => {
    if (!enabled) {
      release();
      return;
    }
    noteActivity();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') noteActivity();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      release();
    };
  }, [enabled, noteActivity, release]);

  return { noteActivity };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Desktop keys: Space / PageDown / → turn the page, Shift+Space / PageUp / ←
 * go back, ↑/↓ nudge, Home/End jump, N/P change chapter, M toggles the bars,
 * A starts or pauses auto-scroll.
 * The handler returns false when it did not act, so the browser's default
 * (e.g. scrolling a focused list in a sheet) still happens.
 */
export function useReaderKeys(handler: (action: ReaderKeyAction) => boolean | void, enabled: boolean) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      let action: ReaderKeyAction | null = null;
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          action = e.shiftKey ? 'page-up' : 'page-down';
          break;
        case 'PageDown':
        case 'ArrowRight':
          action = 'page-down';
          break;
        case 'PageUp':
        case 'ArrowLeft':
          action = 'page-up';
          break;
        case 'ArrowDown':
          action = 'line-down';
          break;
        case 'ArrowUp':
          action = 'line-up';
          break;
        case 'Home':
          action = 'top';
          break;
        case 'End':
          action = 'bottom';
          break;
        case 'n':
        case 'N':
          action = 'next-chapter';
          break;
        case 'p':
        case 'P':
          action = 'prev-chapter';
          break;
        case 'm':
        case 'M':
          action = 'toggle-controls';
          break;
        case 'a':
        case 'A':
          action = 'auto-scroll';
          break;
      }
      if (!action) return;
      // A focused button handles Space itself (that is how it is pressed).
      if (action.startsWith('page') && e.key === ' ' && (e.target as HTMLElement | null)?.closest?.('button, a, [role="button"]')) return;
      if (ref.current(action) !== false) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export function fullscreenSupported(): boolean {
  try {
    return typeof document !== 'undefined' && !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
  } catch {
    return false;
  }
}

/** Real full screen (hides the browser chrome); iPhone Safari has no API, so the button hides there. */
export function useFullscreen(): { active: boolean; toggle: () => void } {
  const [active, setActive] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      // Leaving the reader leaves full screen too.
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, []);
  const toggle = useCallback(() => {
    if (!fullscreenSupported()) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  }, []);
  return { active, toggle };
}

/** A drag that selected text must not also toggle the bars or turn the page. */
export function hasTextSelection(): boolean {
  try {
    const s = window.getSelection?.();
    return !!s && !s.isCollapsed && s.toString().trim().length > 0;
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** Edge taps turn pages on touch screens; a mouse click in the margin should not. */
export function defaultTapZones(): boolean {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches ?? false;
  } catch {
    return false;
  }
}
