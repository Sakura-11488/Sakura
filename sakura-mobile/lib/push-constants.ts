/** Must match filename bundled via expo-notifications plugin and Expo push payloads. */
export const PUSH_NOTIFICATION_SOUND = 'notification.wav';

export type PushRouteType =
  | 'anime'
  | 'manga'
  | 'chapter'
  | 'novel'
  | 'pass_reminder'
  | 'home'
  | 'new_releases'
  | 're_engagement';
