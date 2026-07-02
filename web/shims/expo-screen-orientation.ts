export enum OrientationLock {
  DEFAULT = 'default',
  ALL = 'all',
  PORTRAIT = 'portrait',
  PORTRAIT_UP = 'portrait-up',
  PORTRAIT_DOWN = 'portrait-down',
  LANDSCAPE = 'landscape',
  LANDSCAPE_LEFT = 'landscape-left',
  LANDSCAPE_RIGHT = 'landscape-right',
  OTHER = 'other',
  UNKNOWN = 'unknown',
}

export async function lockAsync(_orientation: OrientationLock): Promise<void> {}
export async function unlockAsync(): Promise<void> {}
export async function getOrientationAsync(): Promise<OrientationLock> {
  return OrientationLock.PORTRAIT_UP;
}
