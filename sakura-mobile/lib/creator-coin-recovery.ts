import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY_PREFIX = 'sakura_creator_coin_launch_';

export type PendingCreatorCoinLaunch = {
  creatorWallet: string;
  coinId: string;
  launchRequestId: string;
  mintAddress: string;
  signature: string;
};

function keyFor(wallet: string): string {
  return `${KEY_PREFIX}${wallet}`;
}

/** A signed transaction may land even if the app loses its verify response. */
export async function savePendingCreatorCoinLaunch(launch: PendingCreatorCoinLaunch): Promise<void> {
  const key = keyFor(launch.creatorWallet);
  const value = JSON.stringify(launch);
  if (Platform.OS === 'web') {
    localStorage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

export async function getPendingCreatorCoinLaunch(wallet: string): Promise<PendingCreatorCoinLaunch | null> {
  const key = keyFor(wallet);
  const raw = Platform.OS === 'web'
    ? (typeof localStorage === 'undefined' ? null : localStorage.getItem(key))
    : await SecureStore.getItemAsync(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== 'object' ||
      !('creatorWallet' in parsed) || parsed.creatorWallet !== wallet ||
      !('coinId' in parsed) || typeof parsed.coinId !== 'string' ||
      !('launchRequestId' in parsed) || typeof parsed.launchRequestId !== 'string' ||
      !('mintAddress' in parsed) || typeof parsed.mintAddress !== 'string' ||
      !('signature' in parsed) || typeof parsed.signature !== 'string'
    ) return null;
    return parsed as PendingCreatorCoinLaunch;
  } catch {
    return null;
  }
}

export async function clearPendingCreatorCoinLaunch(wallet: string): Promise<void> {
  const key = keyFor(wallet);
  if (Platform.OS === 'web') {
    localStorage.removeItem(key);
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}
