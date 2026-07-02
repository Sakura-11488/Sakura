export enum PermissionStatus {
  GRANTED = 'granted',
  DENIED = 'denied',
  UNDETERMINED = 'undetermined',
}

export async function requestPermissionsAsync(_writeOnly?: boolean) {
  return { status: PermissionStatus.GRANTED, granted: true, canAskAgain: false };
}

export async function getPermissionsAsync(_writeOnly?: boolean) {
  return { status: PermissionStatus.GRANTED, granted: true, canAskAgain: false };
}

export async function createAssetAsync(localUri: string) {
  return { uri: localUri };
}

export async function saveToLibraryAsync(localUri: string) {
  return localUri;
}
