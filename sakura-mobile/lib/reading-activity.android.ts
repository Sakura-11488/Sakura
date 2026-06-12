import * as Notifications from 'expo-notifications';
import type { ReadingActivityProps } from './reading-activity-types';

export type { ReadingActivityProps };

// Android analog of the iOS Live Activity: a silent, ongoing progress
// notification that we update in place while the user reads and dismiss
// when they leave the reader.
const ACTIVITY_ID = 'sakura-reading-activity';
const CHANNEL_ID = 'reading-activity';

let disabled = false;
let channelReady = false;
let active = false;

async function ensureChannel(): Promise<void> {
  if (channelReady) return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Reading Activity',
    importance: Notifications.AndroidImportance.LOW,
    showBadge: false,
    enableVibrate: false,
    sound: undefined,
    lightColor: '#E84545',
  });
  channelReady = true;
}

async function hasPermission(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  return status === 'granted';
}

function buildContent(props: ReadingActivityProps): Notifications.NotificationContentInput {
  const percent = Math.round(props.progressPercent * 100);
  const accent = props.kind === 'manga' ? '#E84545' : '#8B5CF6';
  return {
    title: props.title,
    body: `${props.subtitle} - ${props.progressText} (${percent}%)`,
    subtitle: props.kind === 'manga' ? 'Reading manga' : 'Reading novel',
    sticky: true,
    autoDismiss: false,
    color: accent,
    // Keep it quiet — this is an ambient progress indicator, not an alert.
    priority: Notifications.AndroidNotificationPriority.LOW,
  };
}

export async function upsertReadingActivity(
  props: ReadingActivityProps,
  _url?: string,
): Promise<void> {
  if (disabled) return;
  try {
    // Only show if the user already granted notifications; never prompt mid-read.
    if (!(await hasPermission())) return;
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: ACTIVITY_ID,
      content: { ...buildContent(props), data: { type: 'reading-activity' } },
      trigger: { channelId: CHANNEL_ID } as Notifications.NotificationTriggerInput,
    });
    active = true;
  } catch {
    disabled = true;
  }
}

export async function endReadingActivity(_finalProps?: ReadingActivityProps): Promise<void> {
  if (!active) return;
  try {
    await Notifications.dismissNotificationAsync(ACTIVITY_ID);
  } catch {
    // no-op
  } finally {
    active = false;
  }
}
