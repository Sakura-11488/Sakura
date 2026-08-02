import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

// Longest-edge cap for uploaded images. Keeps the base64 request body well under
// the edge functions' decoded caps (a 4000px phone scan was ~7-9 MB and was
// silently rejected, which is why creator covers/pages never uploaded).
export const MAX_UPLOAD_EDGE = 1600;

export interface PreparedImage {
  /** Raw base64, no data-URI prefix. */
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Resize (only if oversized) + recompress an image and return raw base64. This
 * is the single source of image bytes for uploads:
 *  - keeps files under the edge functions' size caps (the reason uploads failed),
 *  - normalizes any picker URI (ph://, content://, blob:) to a decodable image
 *    on every platform, replacing the fragile FileSystem.readAsStringAsync path,
 *  - always emits JPEG, which every consumer's allowlist accepts.
 */
export async function prepareImageBase64(
  localUri: string,
  maxEdge: number = MAX_UPLOAD_EDGE,
): Promise<PreparedImage> {
  // First pass decodes the image (and normalizes the URI) so we know its real
  // dimensions and never upscale a small image.
  const probe = await manipulateAsync(localUri, [], { compress: 1, format: SaveFormat.JPEG });
  const longest = Math.max(probe.width, probe.height);
  const actions =
    longest > maxEdge
      ? [{ resize: probe.width >= probe.height ? { width: maxEdge } : { height: maxEdge } }]
      : [];
  const out = await manipulateAsync(probe.uri, actions, {
    compress: 0.8,
    format: SaveFormat.JPEG,
    base64: true,
  });
  if (!out.base64) throw new Error('Could not read the image.');
  return { base64: out.base64, mimeType: 'image/jpeg', width: out.width, height: out.height };
}
