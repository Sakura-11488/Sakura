import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

/**
 * Applies Expo OTA updates (EAS Update) without shipping a new APK.
 * Checks on launch and on resume; downloads in the background and reloads when
 * a new bundle is ready. No-op in development and Expo Go.
 */
export default function OtaUpdateBridge() {
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;

    let applying = false;

    const checkAndApply = async () => {
      if (applying) return;
      try {
        const result = await Updates.checkForUpdateAsync();
        if (!result.isAvailable) return;
        applying = true;
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } catch {
        applying = false;
        // OTA is best-effort; the installed bundle keeps running on failure.
      }
    };

    checkAndApply();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkAndApply();
    });
    return () => sub.remove();
  }, []);

  return null;
}
