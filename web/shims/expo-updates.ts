export const isEnabled = false;
export const updateId = null;
export const channel = null;
export const runtimeVersion = null;

export async function checkForUpdateAsync(): Promise<{ isAvailable: boolean }> {
  return { isAvailable: false };
}

export async function fetchUpdateAsync(): Promise<void> {}

export async function reloadAsync(): Promise<void> {}

export enum UpdatesCheckAutomaticallyValue {
  ON_LOAD = 'ON_LOAD',
  ON_ERROR_RECOVERY = 'ON_ERROR_RECOVERY',
  NEVER = 'NEVER',
  WIFI_ONLY = 'WIFI_ONLY',
}
