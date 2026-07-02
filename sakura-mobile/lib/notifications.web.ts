export class PushRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: 'permission_denied' | 'no_project_id' | 'token_failed',
  ) {
    super(message);
    this.name = 'PushRegistrationError';
  }
}

export async function getNotificationPermissionStatus(): Promise<'undetermined'> {
  return 'undetermined';
}

export async function requestNotificationPermission(): Promise<boolean> {
  return false;
}

export async function openNotificationSettings(): Promise<void> {}

export async function registerForPushNotifications(): Promise<string | null> {
  return null;
}

export async function unregisterPushNotifications(): Promise<void> {}
