import { useSyncExternalStore } from 'react';
import { getInstallState, subscribeInstallState } from './pwa-install';

const serverState = { canPrompt: false, installed: false, busy: false };
const getServerState = () => serverState;

/** The banner and Settings share the browser's single-use install request. */
export function usePwaInstall() {
  return useSyncExternalStore(subscribeInstallState, getInstallState, getServerState);
}
