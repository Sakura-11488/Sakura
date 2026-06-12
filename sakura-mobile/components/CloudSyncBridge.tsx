import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useWallet } from '@/lib/wallet/context';
import { subscribeReadingProgress } from '@/lib/reader-progress';
import { subscribeWatchProgress } from '@/lib/watch-progress';
import { pullAllFromCloud, pushAllToCloud, scheduleCloudPush } from '@/lib/cloud-sync';

/**
 * Keeps the connected wallet's library and progress in sync with Supabase.
 * Pulls + merges on connect, then pushes (debounced) whenever local progress
 * changes or the app backgrounds. Best-effort and silent on failure.
 */
export default function CloudSyncBridge() {
  const { address, connected } = useWallet();
  const pulledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!connected || !address) {
      pulledRef.current = null;
      return;
    }

    let cancelled = false;

    // Initial pull-then-push when this wallet connects.
    if (pulledRef.current !== address) {
      pulledRef.current = address;
      pullAllFromCloud(address)
        .then(() => {
          if (!cancelled) scheduleCloudPush(address);
        })
        .catch(() => {});
    }

    const unsubRead = subscribeReadingProgress(() => scheduleCloudPush(address));
    const unsubWatch = subscribeWatchProgress(() => scheduleCloudPush(address));
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        pushAllToCloud(address).catch(() => {});
      }
    });

    return () => {
      cancelled = true;
      unsubRead();
      unsubWatch();
      appSub.remove();
    };
  }, [connected, address]);

  return null;
}
