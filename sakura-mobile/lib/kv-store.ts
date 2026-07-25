import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Small persistent key/value store that actually works on both platforms.
 *
 * expo-file-system has no web implementation: `documentDirectory` is null and
 * the write throws. Every module that persisted a JSON blob through it was
 * therefore memory-only on web, with the failure swallowed by a catch — so
 * reading history and the API cache survived a reload on native and vanished
 * on web. Backgrounding the PWA is enough for the browser to evict the tab,
 * which is why "I checked Twitter and came back" lost someone's place.
 *
 * Web uses localStorage, which is synchronous and survives eviction. Native
 * keeps the file, which has no practical size limit.
 */

const WEB_PREFIX = 'sakura_store_';

function webStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Access itself throws when site data is blocked.
    return null;
  }
}

export async function readStore(name: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return webStorage()?.getItem(`${WEB_PREFIX}${name}`) ?? null;
    } catch {
      return null;
    }
  }
  try {
    const file = `${FileSystem.documentDirectory}${name}`;
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    return await FileSystem.readAsStringAsync(file);
  } catch {
    return null;
  }
}

/** Returns false when the value could not be stored, so callers can react. */
export async function writeStore(name: string, value: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    const store = webStorage();
    if (!store) return false;
    try {
      store.setItem(`${WEB_PREFIX}${name}`, value);
      return true;
    } catch {
      // Almost always the ~5MB quota. Drop caches — which are rebuildable —
      // and retry once, so a large cache can never squeeze out something
      // small and irreplaceable like reading progress.
      try {
        for (const key of Object.keys(store)) {
          if (key.startsWith(`${WEB_PREFIX}`) && key.includes('cache')) store.removeItem(key);
        }
        store.setItem(`${WEB_PREFIX}${name}`, value);
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    await FileSystem.writeAsStringAsync(`${FileSystem.documentDirectory}${name}`, value);
    return true;
  } catch {
    return false;
  }
}

export async function removeStore(name: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      webStorage()?.removeItem(`${WEB_PREFIX}${name}`);
    } catch {
      // nothing to do
    }
    return;
  }
  try {
    await FileSystem.deleteAsync(`${FileSystem.documentDirectory}${name}`, { idempotent: true });
  } catch {
    // nothing to do
  }
}
