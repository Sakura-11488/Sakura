import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { Keypair } from '@solana/web3.js';
import { invokeCreatorFunction } from './creator-api';
import { buildWalletAuthHeaders } from './wallet-auth';
import { MEDIA_BASE_DEFAULT } from './content-hosts';

// Longest-edge cap for uploaded images. Keeps the base64 request body well under
// the edge function's 6 MB decoded cap (a 4000px phone scan was ~7-9 MB and was
// silently rejected, which is why creator covers/pages never uploaded).
const MAX_UPLOAD_EDGE = 1600;

/**
 * Creator media uploads (mobile-first).
 *
 * - Images (manga pages, posters, thumbnails) → Supabase buckets through the
 *   ownership-checked `upload-work-media` edge function. Small files only.
 * - Video (anime episodes) → the droplet media-ingest service directly
 *   (wallet-signature auth), so large files never touch Supabase storage or
 *   an edge function body limit. The returned URLs are then recorded in
 *   asset_files/work_assets via the same edge function.
 */

const MEDIA_INGEST_BASE = (
  process.env.EXPO_PUBLIC_MEDIA_INGEST_BASE?.trim() || `${MEDIA_BASE_DEFAULT}/media/v1`
).replace(/\/+$/, '');

export type WorkImageRole = 'manga_page' | 'poster' | 'cover' | 'thumbnail';

export interface UploadedWorkImage {
  asset_file_id: string;
  bucket: string;
  object_path: string;
  /** Public URL, or 1-hour signed URL for private buckets (manga pages). */
  url: string;
}

export interface UploadedEpisodeVideo {
  asset_file_id: string;
  /** Absolute URLs on the media host. */
  videoUrl: string;
  posterUrl: string | null;
}

/**
 * Resize (only if oversized) + recompress an image and return raw base64 (no
 * data-URI prefix). This is the single source of image bytes for uploads:
 *  - keeps files under the edge function's 6 MB cap (the reason uploads failed),
 *  - normalizes any picker URI (ph://, content://, blob:) to a decodable image
 *    on every platform, replacing the fragile FileSystem.readAsStringAsync path,
 *  - always emits JPEG, which the edge function's ALLOWED_MIME accepts.
 */
async function prepareImageBase64(
  localUri: string,
): Promise<{ base64: string; mimeType: string; width: number; height: number }> {
  // First pass decodes the image (and normalizes the URI) so we know its real
  // dimensions and never upscale a small image.
  const probe = await manipulateAsync(localUri, [], { compress: 1, format: SaveFormat.JPEG });
  const longest = Math.max(probe.width, probe.height);
  const actions =
    longest > MAX_UPLOAD_EDGE
      ? [
          {
            resize:
              probe.width >= probe.height
                ? { width: MAX_UPLOAD_EDGE }
                : { height: MAX_UPLOAD_EDGE },
          },
        ]
      : [];
  const out = await manipulateAsync(probe.uri, actions, {
    compress: 0.8,
    format: SaveFormat.JPEG,
    base64: true,
  });
  if (!out.base64) throw new Error('Could not read the image.');
  return { base64: out.base64, mimeType: 'image/jpeg', width: out.width, height: out.height };
}

function videoMimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}

export async function uploadWorkImage(input: {
  keypair: Keypair;
  workId: string;
  releaseId?: string;
  role: WorkImageRole;
  localUri: string;
  mimeType?: string;
  sortOrder?: number;
  isPrimary?: boolean;
}): Promise<UploadedWorkImage> {
  const prepared = await prepareImageBase64(input.localUri);
  return invokeCreatorFunction<UploadedWorkImage>(
    'upload-work-media',
    'upload-work-media',
    input.keypair,
    {
      work_id: input.workId,
      release_id: input.releaseId,
      role: input.role,
      image_base64: prepared.base64,
      mime_type: prepared.mimeType,
      width: prepared.width,
      height: prepared.height,
      sort_order: input.sortOrder ?? 0,
      is_primary: input.isPrimary ?? false,
    },
  );
}

/**
 * Upload a manga chapter's pages in order. The first page is also stored to
 * the public creator-thumbnails bucket as the chapter thumbnail.
 */
export async function uploadMangaPages(input: {
  keypair: Keypair;
  workId: string;
  releaseId: string;
  localUris: string[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ results: UploadedWorkImage[]; failed: number[] }> {
  const results: UploadedWorkImage[] = [];
  const failed: number[] = [];
  const total = input.localUris.length;
  for (let i = 0; i < total; i++) {
    const uri = input.localUris[i];
    try {
      const page = await uploadWorkImage({
        keypair: input.keypair,
        workId: input.workId,
        releaseId: input.releaseId,
        role: 'manga_page',
        localUri: uri,
        sortOrder: i + 1,
        isPrimary: i === 0,
      });
      results.push(page);
    } catch (e) {
      // A single bad/oversized page must not abort the whole chapter publish —
      // record it and keep going so the rest of the pages still upload.
      console.warn(`[creator-media] page ${i + 1} failed:`, e);
      failed.push(i + 1);
    }
    input.onProgress?.(i + 1, total);
  }

  if (input.localUris[0]) {
    // Public chapter thumbnail from page 1 (pages themselves stay private).
    await uploadWorkImage({
      keypair: input.keypair,
      workId: input.workId,
      releaseId: input.releaseId,
      role: 'thumbnail',
      localUri: input.localUris[0],
      sortOrder: 0,
      isPrimary: true,
    }).catch((e) => console.warn('[creator-media] chapter thumbnail failed:', e));
  }

  return { results, failed };
}

/**
 * Upload an anime episode video to the droplet (large-file path) and record
 * the asset. A poster frame is generated automatically by ffmpeg on the
 * server. Note: web builds can't call the plain-http media host directly —
 * this flow is mobile-first by design.
 */
export async function uploadAnimeEpisodeVideo(input: {
  keypair: Keypair;
  workId: string;
  releaseId: string;
  localUri: string;
  fileName?: string;
}): Promise<UploadedEpisodeVideo> {
  const name = input.fileName?.trim() || input.localUri.split('/').pop() || 'episode.mp4';
  const mime = videoMimeForName(name);
  const headers = buildWalletAuthHeaders(input.keypair, 'upload-work-media');

  const form = new FormData();
  form.append('workId', input.workId.toLowerCase());
  form.append('file', {
    uri: input.localUri,
    name,
    type: mime,
  } as unknown as Blob);

  const res = await fetch(`${MEDIA_INGEST_BASE}/creator/videos`, {
    method: 'POST',
    headers,
    body: form,
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    videoUrl?: string;
    posterUrl?: string;
    bytes?: number;
    error?: string;
  };
  if (!res.ok || !payload.videoUrl) {
    throw new Error(payload.error || `Video upload failed (${res.status})`);
  }

  const recorded = await invokeCreatorFunction<{ asset_file_id: string }>(
    'upload-work-media',
    'upload-work-media',
    input.keypair,
    {
      work_id: input.workId,
      release_id: input.releaseId,
      is_primary: true,
      remote_video: {
        video_url: payload.videoUrl,
        poster_url: payload.posterUrl,
        size_bytes: payload.bytes,
      },
    },
  );

  return {
    asset_file_id: recorded.asset_file_id,
    videoUrl: `${MEDIA_BASE_DEFAULT}${payload.videoUrl}`,
    posterUrl: payload.posterUrl ? `${MEDIA_BASE_DEFAULT}${payload.posterUrl}` : null,
  };
}
