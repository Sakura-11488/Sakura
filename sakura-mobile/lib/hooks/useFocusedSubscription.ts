import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * Listen to a store only while this screen is focused.
 *
 * A stack keeps the screens under the top one mounted (on web they stay in the
 * DOM, hidden), so a plain useEffect subscription keeps re-rendering them.
 * The reader saves progress on every page turn (lib/reader-progress, 400 ms
 * debounce), and each save refreshed home's Continue Reading row and the
 * title page underneath it: measured on the live site at 4x CPU, reading after
 * coming in through home and a title page took 530–561 ms of script per 4 s of
 * scrolling against 259–308 ms when the reader was opened directly.
 *
 * Nothing is lost by not listening while hidden: every caller also reloads
 * when the screen regains focus, which is the only moment the change becomes
 * visible.
 *
 * `listener` should be stable (useCallback), or the subscription is renewed
 * on every render.
 */
export function useFocusedSubscription(
  subscribe: (listener: () => void) => () => void,
  listener: () => void,
): void {
  useFocusEffect(useCallback(() => subscribe(listener), [subscribe, listener]));
}
