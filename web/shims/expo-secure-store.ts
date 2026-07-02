const PREFIX = 'sakura_secure_';

export async function isAvailableAsync(): Promise<boolean> {
  return typeof localStorage !== 'undefined';
}

export async function getItemAsync(key: string, _options?: object): Promise<string | null> {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(PREFIX + key);
}

export async function setItemAsync(key: string, value: string, _options?: object): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(PREFIX + key, value);
}

export async function deleteItemAsync(key: string, _options?: object): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(PREFIX + key);
}

export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;
