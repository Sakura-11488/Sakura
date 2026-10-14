import { useEffect } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

/**
 * Keep the screen on while `active` (the reader is focused and the
 * "Keep screen on" preference is set). Mihon does this by default: reading
 * one long page is a minute without a touch, and the screen dimming mid-panel
 * is the most common complaint about readers that don't.
 *
 * expo-keep-awake ships with expo itself (expo's dev tools use it), so this
 * adds no native module. A tag of its own, so it never releases a hold some
 * other screen took.
 */
const TAG = 'sakura-reader';

export function useReaderKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    void activateKeepAwakeAsync(TAG).catch(() => undefined);
    return () => {
      void deactivateKeepAwake(TAG).catch(() => undefined);
    };
  }, [active]);
}
