import type { ReadingActivityProps } from './reading-activity-types';

export type { ReadingActivityProps };

// Default no-op implementation. Platform-specific behaviour lives in
// `reading-activity.ios.ts` (Live Activity) and `reading-activity.android.ts`
// (ongoing progress notification). Metro resolves those automatically.
export async function upsertReadingActivity(
  _props: ReadingActivityProps,
  _url?: string,
): Promise<void> {}

export async function endReadingActivity(_finalProps?: ReadingActivityProps): Promise<void> {}
