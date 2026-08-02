import { Platform } from 'react-native';
import type { Keypair } from '@solana/web3.js';
import { invokeCreatorFunction } from './creator-api';
import { buildWalletAuthHeaders } from './wallet-auth';
import { MEDIA_BASE_DEFAULT } from './content-hosts';
import { prepareImageBase64 } from './prepare-image';

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

/**
 * The droplet terminates TLS (Let's Encrypt, auto-renewing), so the ingest host
 * is reachable over https. An https page cannot POST to an http origin — the
 * browser blocks it before the request is sent — so on web the scheme is forced
 * up rather than trusted to configuration.
 *
 * This is deliberately not left to EXPO_PUBLIC_MEDIA_INGEST_BASE alone: that var
 * lives in two separate .env files (sakura-mobile and web), is inlined at build
 * time, and silently compiles out to `undefined` against a stale Metro cache —
 * which reintroduces the exact mixed-content failure this guards against.
 */
const MEDIA_INGEST_BASE = (() => {
  const configured = (
    process.env.EXPO_PUBLIC_MEDIA_INGEST_BASE?.trim() || `${MEDIA_BASE_DEFAULT}/media/v1`
  ).replace(/\/+$/, '');
  if (Platform.OS === 'web' && configured.startsWith('http://')) {
    return `https://${configured.slice('http://'.length)}`;
  }
  return configured;
})();

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

/** True when the ingest host cannot be reached from this platform at all. */
export function mediaIngestBlockedReason(): string | null {
  if (Platform.OS !== 'web') return null;
  // An http:// request from an https:// page is blocked by the browser before it
  // is sent, so no amount of retrying helps and the failure surfaces as an
  // opaque "Failed to fetch". Detect it up front and say so.
  const isHttps = typeof window !== 'undefined' && window.location?.protocol === 'https:';
  if (isHttps && MEDIA_INGEST_BASE.startsWith('http://')) {
    return 'Video uploads need a secure connection to the media server, which is not set up for the web app yet. Publish episodes from the Sakura mobile app for now.';
  }
  return null;
}

/**
 * Cheap liveness probe for the ingest host. Used to fail BEFORE a work row is
 * created, so a dead media server does not leave an orphan draft behind.
 * Returns null when reachable, else a human-readable reason.
 */
export async function checkMediaIngestReachable(): Promise<string | null> {
  const blocked = mediaIngestBlockedReason();
  if (blocked) return blocked;
  try {
    // Probe the health route and require an AFFIRMATIVE JSON ok. Checking for a
    // failure signal instead does not work: Express answers unknown routes with
    // an HTML 404 exactly like nginx does, so "content-type is text/html" is
    // true both when the service is missing AND when it is running fine but the
    // probed path isn't a GET route — which would block publishing outright.
    const res = await fetch(`${MEDIA_INGEST_BASE}/healthz`, {
      method: 'GET',
      // Never let a dead host hold the publish button hostage.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return 'Video hosting is offline right now, so episodes cannot be uploaded. Your work has not been created — try again later.';
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!body?.ok) {
      return 'Video hosting is offline right now, so episodes cannot be uploaded. Your work has not been created — try again later.';
    }
    return null;
  } catch {
    return 'Could not reach the video server. Check your connection and try again.';
  }
}

/**
 * Resolve the multipart body for the video.
 *
 * React Native's FormData accepts a `{uri, name, type}` descriptor, but a
 * browser stringifies that object to "[object Object]" and the server then sees
 * a text field instead of a file. On web we must append a real File/Blob.
 */
async function resolveVideoBody(
  localUri: string,
  name: string,
  mime: string,
  file?: unknown,
): Promise<Blob | { uri: string; name: string; type: string }> {
  if (Platform.OS !== 'web') return { uri: localUri, name, type: mime };
  if (file instanceof Blob) return file;
  // expo-image-picker hands back a blob:/data: URI on web; fetch it back to bytes.
  const res = await fetch(localUri);
  return res.blob();
}

/**
 * Upload an anime episode video to the droplet (large-file path) and record
 * the asset. A poster frame is generated automatically by ffmpeg on the
 * server.
 *
 * Pass `file` on web (expo-image-picker's `asset.file`) — see resolveVideoBody
 * for why the native descriptor shape cannot be used there.
 */
export async function uploadAnimeEpisodeVideo(input: {
  keypair: Keypair;
  workId: string;
  releaseId: string;
  localUri: string;
  fileName?: string;
  file?: unknown;
}): Promise<UploadedEpisodeVideo> {
  const blocked = mediaIngestBlockedReason();
  if (blocked) throw new Error(blocked);

  const name = input.fileName?.trim() || input.localUri.split('/').pop() || 'episode.mp4';
  const mime = videoMimeForName(name);
  const headers = buildWalletAuthHeaders(input.keypair, 'upload-work-media');

  const body = await resolveVideoBody(input.localUri, name, mime, input.file);
  const form = new FormData();
  form.append('workId', input.workId.toLowerCase());
  if (body instanceof Blob) {
    form.append('file', body, name);
  } else {
    form.append('file', body as unknown as Blob);
  }

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
    // A 404 with an HTML body is nginx answering for a route that isn't
    // configured — i.e. the ingest service isn't deployed. That is an outage,
    // not a bad upload, and saying "Video upload failed (404)" sends creators
    // hunting for a problem with their file.
    if (res.status === 404 && (res.headers.get('content-type') || '').includes('text/html')) {
      throw new Error('Video hosting is offline right now, so the episode could not be uploaded.');
    }
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
