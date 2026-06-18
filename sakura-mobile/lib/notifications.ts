import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform, Linking } from 'react-native';
import { AppSettings } from './settings';
import { disablePushRegistration } from './push-tokens';
import { PUSH_NOTIFICATION_SOUND } from './push-constants';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export class PushRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: 'permission_denied' | 'no_project_id' | 'token_failed',
  ) {
    super(message);
    this.name = 'PushRegistrationError';
  }
}

export async function getNotificationPermissionStatus(): Promise<Notifications.PermissionStatus> {
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

export async function requestNotificationPermission(): Promise<boolean> {
  const { status: current } = await Notifications.getPermissionsAsync();
  if (current === 'granted') return true;
  if (current === 'denied') {
    await openNotificationSettings();
    return false;
  }
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function openNotificationSettings(): Promise<void> {
  await Linking.openSettings();
}

function resolveEasProjectId(): string | undefined {
  const fromConfig =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();
  return fromEnv || fromConfig;
}

function remotePushEnabled(): boolean {
  return process.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED === 'true';
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!remotePushEnabled()) {
    throw new PushRegistrationError(
      'Push notifications are not configured for this build yet. Anime playback and local alerts still work.',
      'token_failed',
    );
  }

  const granted = await requestNotificationPermission();
  if (!granted) {
    throw new PushRegistrationError(
      'Notification permission was not granted.',
      'permission_denied',
    );
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Sakura',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#E84545',
      sound: PUSH_NOTIFICATION_SOUND,
    });
  }

  const projectId = resolveEasProjectId();
  if (!projectId) {
    throw new PushRegistrationError(
      'Missing EAS project ID. Run `npx eas init` and set EXPO_PUBLIC_EAS_PROJECT_ID in ios/.xcode.env.local.',
      'no_project_id',
    );
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await AppSettings.setPushToken(token);
    return token;
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Could not register for push notifications.';
    const message =
      /Firebase|googleServicesFile|Default FirebaseApp|FirebaseApp/i.test(raw)
        ? 'Push notifications are not configured for this build yet. Anime playback and local alerts still work.'
        : raw;
    throw new PushRegistrationError(message, 'token_failed');
  }
}

export async function unregisterPushNotifications(): Promise<void> {
  const token = await AppSettings.getPushToken();
  await disablePushRegistration(token).catch(() => {});
  await AppSettings.setPushToken('');
}
