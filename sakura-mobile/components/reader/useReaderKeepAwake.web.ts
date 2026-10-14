import { useEffect } from 'react';

type WakeLockSentinelLike = { released: boolean; release(): Promise<void>; addEventListener?: (t: string, fn: () => void) => void };
type WakeLockLike = { request(type: 'screen'): Promise<WakeLockSentinelLike> };

/**
 * Keep the screen on while `active`, through the Screen Wake Lock API.
 *
 * The browser drops a wake lock whenever the tab is hidden, and it does not
 * come back by itself, so it is requested again each time the page becomes
 * visible. Browsers without the API (older Safari, Firefox before 126) just
 * keep their normal screen timeout; nothing is shown for it.
 */
export function useReaderKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined' || typeof navigator === 'undefined') return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock?.request) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;

    const acquire = () => {
      if (disposed || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      wakeLock
        .request('screen')
        .then((lock) => {
          if (disposed) {
            void lock.release().catch(() => undefined);
            return;
          }
          sentinel = lock;
        })
        // Refused (battery saver, permissions policy, not visible): reading
        // goes on with the normal screen timeout.
        .catch(() => undefined);
    };

    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}
