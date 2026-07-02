export enum PermissionStatus {
  GRANTED = 'granted',
  DENIED = 'denied',
  UNDETERMINED = 'undetermined',
}

export enum AndroidImportance {
  DEFAULT = 3,
  HIGH = 4,
  LOW = 2,
  MAX = 5,
  MIN = 1,
  NONE = 0,
  UNSPECIFIED = -1000,
}

export async function getPermissionsAsync() {
  return { status: PermissionStatus.DENIED, granted: false, canAskAgain: false };
}

export async function requestPermissionsAsync() {
  return { status: PermissionStatus.DENIED, granted: false, canAskAgain: false };
}

export async function getExpoPushTokenAsync() {
  return { data: '' };
}

export async function setNotificationHandler(_handler: unknown): Promise<void> {}

export async function setNotificationChannelAsync(_id: string, _channel: unknown): Promise<void> {}

export async function scheduleNotificationAsync(_content: unknown): Promise<string> {
  return '';
}

export async function cancelAllScheduledNotificationsAsync(): Promise<void> {}

export async function dismissAllNotificationsAsync(): Promise<void> {}

export function addNotificationReceivedListener(_listener: unknown) {
  return { remove: () => {} };
}

export function addNotificationResponseReceivedListener(_listener: unknown) {
  return { remove: () => {} };
}
