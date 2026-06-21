import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

function extensionFromUrl(url: string): string {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'jpg';
  if (path.endsWith('.webp')) return 'webp';
  if (path.endsWith('.gif')) return 'gif';
  return 'png';
}

export async function saveProfileImageToDevice(imageUrl: string, label = 'sakura-pfp'): Promise<void> {
  const trimmed = imageUrl.trim();
  if (!trimmed) throw new Error('No profile photo to save.');

  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new Error('Photo library access is required to save your profile picture.');
  }

  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) throw new Error('Could not access device storage.');

  const ext = extensionFromUrl(trimmed);
  const dest = `${cacheDir}${label}-${Date.now()}.${ext}`;
  const downloaded = await FileSystem.downloadAsync(trimmed, dest);
  if (downloaded.status !== 200) {
    await FileSystem.deleteAsync(dest, { idempotent: true });
    throw new Error('Could not download your profile photo.');
  }

  try {
    await MediaLibrary.createAssetAsync(downloaded.uri);
  } finally {
    await FileSystem.deleteAsync(dest, { idempotent: true });
  }
}
