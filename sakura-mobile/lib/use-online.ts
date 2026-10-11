import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Connectivity, as far as the web build can know it.
 *
 * Web reads navigator.onLine, which is reliable in the direction that matters:
 * `false` means there is certainly no network, so screens can go straight to
 * downloaded copies instead of waiting out requests that cannot succeed.
 * `true` only means "maybe" (a captive portal reports online), so callers
 * still fall back to offline data when a request fails.
 *
 * Native always reports online. Its screens already fall back on failure, and
 * guessing offline there would need @react-native-community/netinfo — a new
 * native dependency for no current caller.
 */
export function isOnline(): boolean {
  if (Platform.OS !== 'web') return true;
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true;
  return navigator.onLine;
}

function subscribe(onChange: () => void): () => void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Server render has no navigator; assume online so nothing is hidden. */
function getServerSnapshot(): boolean {
  return true;
}

/** Re-renders when the browser goes online or offline. Always true on native. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, getServerSnapshot);
}
