import { ReadingActivity } from '@/widgets/ReadingActivity';
import type { ReadingActivityProps } from './reading-activity-types';

export type { ReadingActivityProps };

let disabled = false;
let activeInstance: ReturnType<typeof ReadingActivity.start> | null = null;

export async function upsertReadingActivity(
  props: ReadingActivityProps,
  url?: string,
): Promise<void> {
  if (disabled) return;
  try {
    if (!activeInstance) {
      // Recover a still-running activity after an app restart or crash.
      const existing = ReadingActivity.getInstances();
      activeInstance = existing.length > 0 ? existing[0] : null;
    }
    if (!activeInstance) {
      activeInstance = ReadingActivity.start(props, url);
    } else {
      await activeInstance.update(props);
    }
  } catch {
    disabled = true;
  }
}

export async function endReadingActivity(finalProps?: ReadingActivityProps): Promise<void> {
  if (!activeInstance) return;
  try {
    await activeInstance.end('immediate', finalProps);
  } catch {
    // no-op
  } finally {
    activeInstance = null;
  }
}
