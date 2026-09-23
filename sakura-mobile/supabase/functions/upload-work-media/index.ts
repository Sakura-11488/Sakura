import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

/**
 * Creator media recorder — the single ownership-checked path for attaching
 * media to a creator work/release.
 *
 * Two modes:
 *  - Image upload: `image_base64` + `mime_type` → stored in the right
 *    Supabase bucket, asset_files + work_assets rows written.
 *  - Droplet video registration: `remote_video` (URLs returned by the
 *    droplet media-ingest service) → rows only, no storage write. Video
 *    bytes never touch Supabase (cost).
 */

type RemoteVideo = {
  video_url: string;
  poster_url?: string;
  size_bytes?: number;
  duration_ms?: number;
};

type UploadBody = {
  work_id?: string;
  release_id?: string;
  role?: string;
  sort_order?: number;
  is_primary?: boolean;
  image_base64?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  remote_video?: RemoteVideo;
  attachment_request?: { file_name?: string; mime_type?: string; size_bytes?: number };
  attachment_complete?: { object_path?: string; file_name?: string; mime_type?: string };
  video_preflight?: boolean;
};

const cors = corsHeaders();
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_FILE_RE = /^[0-9a-f-]{36}\.(mp4|mov|webm|m4v)$/i;
const POSTER_FILE_RE = /^[0-9a-f-]{36}\.jpg$/i;

/** role → { bucket, asset kind, public? } for image uploads. */
const IMAGE_ROLES: Record<string, { bucket: string; kind: string; isPublic: boolean }> = {
  manga_page: { bucket: 'manga-pages', kind: 'manga_page', isPublic: false },
  poster: { bucket: 'anime-posters', kind: 'poster', isPublic: true },
  cover: { bucket: 'creator-covers', kind: 'cover', isPublic: true },
  thumbnail: { bucket: 'creator-thumbnails', kind: 'thumbnail', isPublic: true },
};

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'upload-work-media');
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const limit = await checkRateLimit(supabase, `creator-media:${walletAddress}`, 240, 3600);
    if (!limit.allowed) return jsonResponse(429, { error: 'Upload limit reached. Try again later.' }, cors);
    const body = (await req.json()) as UploadBody;

    const workId = body.work_id?.trim() ?? '';
    if (!UUID_RE.test(workId)) return jsonResponse(400, { error: 'Valid work_id is required.' }, cors);
    const releaseId = body.release_id?.trim() || null;
    if (releaseId && !UUID_RE.test(releaseId)) {
      return jsonResponse(400, { error: 'release_id must be a UUID.' }, cors);
    }

    // ── Ownership ──
    const { data: work, error: workErr } = await supabase
      .from('creator_works')
      .select('id, creator_wallet, kind, publication_status, price_sakura')
      .eq('id', workId)
      .maybeSingle();
    if (workErr) throw workErr;
    if (!work || work.creator_wallet !== walletAddress) {
      return jsonResponse(403, { error: 'You do not own this work.' }, cors);
    }
    if (body.video_preflight) {
      if (work.kind !== 'anime' || work.publication_status !== 'draft') {
        return jsonResponse(409, { error: 'Video uploads require an unpublished anime work.' }, cors);
      }
      const videoLimit = await checkRateLimit(supabase, `creator-video:${walletAddress}`, 8, 86400);
      if (!videoLimit.allowed) return jsonResponse(429, { error: 'Daily video upload limit reached.' }, cors);
      return jsonResponse(200, { ok: true, paid: Number(work.price_sakura) > 0 }, cors);
    }
    if (releaseId) {
      const { data: release } = await supabase
        .from('work_releases')
        .select('id, work_id')
        .eq('id', releaseId)
        .maybeSingle();
      if (!release || release.work_id !== workId) {
        return jsonResponse(403, { error: 'Release does not belong to this work.' }, cors);
      }
    }

    const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0;
    const isPrimary = body.is_primary === true;

    if (body.attachment_request || body.attachment_complete) {
      if (!releaseId) return jsonResponse(400, { error: 'A release is required for attachments.' }, cors);
      const dir = `${walletAddress}/${workId}/${releaseId}/`;
      if (body.attachment_request) {
        const { count: attachedCount, error: countErr } = await supabase.from('work_assets')
          .select('*', { count: 'exact', head: true })
          .eq('release_id', releaseId).eq('role', 'attachment');
        if (countErr) throw countErr;
        if ((attachedCount ?? 0) >= 10) {
          return jsonResponse(409, { error: 'A release can have up to 10 attachments.' }, cors);
        }
        const fileName = String(body.attachment_request.file_name || '')
          .replace(/[\\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        const mimeType = String(body.attachment_request.mime_type || 'application/octet-stream').trim().slice(0, 120);
        const size = Number(body.attachment_request.size_bytes);
        if (!fileName || !Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
          return jsonResponse(400, { error: 'Choose a file up to 50 MB with a valid name.' }, cors);
        }
        if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
          return jsonResponse(400, { error: 'Invalid file type.' }, cors);
        }
        const safeName = fileName.replace(/[^\w.()-]+/g, '-');
        const objectPath = `${dir}${crypto.randomUUID()}-${safeName}`;
        const { data, error } = await supabase.storage.from('release-attachments')
          .createSignedUploadUrl(objectPath);
        if (error) throw error;
        return jsonResponse(200, { ok: true, object_path: objectPath, token: data.token }, cors);
      }

      const objectPath = String(body.attachment_complete?.object_path || '');
      if (!objectPath.startsWith(dir) || !/^[0-9a-f-]{36}-[^/]{1,120}$/.test(objectPath.slice(dir.length))) {
        return jsonResponse(400, { error: 'Attachment path does not belong to this release.' }, cors);
      }
      const fileName = String(body.attachment_complete?.file_name || '')
        .replace(/[\\/\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
      if (!fileName) return jsonResponse(400, { error: 'Attachment name is required.' }, cors);
      const { data: listed, error: listErr } = await supabase.storage.from('release-attachments')
        .list(dir.slice(0, -1), { search: objectPath.slice(dir.length), limit: 10 });
      if (listErr) throw listErr;
      const stored = listed?.find((file) => file.name === objectPath.slice(dir.length));
      const actualSize = Number(stored?.metadata?.size ?? 0);
      if (!stored || !actualSize || actualSize > MAX_ATTACHMENT_BYTES) {
        return jsonResponse(422, { error: 'Attachment upload is incomplete or exceeds 50 MB.' }, cors);
      }
      const { data: existing } = await supabase.from('asset_files').select('id')
        .eq('bucket', 'release-attachments').eq('object_path', objectPath).maybeSingle();
      if (existing) return jsonResponse(200, { ok: true, asset_file_id: existing.id }, cors);
      const mimeType = String(stored.metadata?.mimetype || body.attachment_complete?.mime_type ||
        'application/octet-stream').slice(0, 120);
      const { data: asset, error: assetErr } = await supabase.from('asset_files').insert({
        owner_wallet: walletAddress, storage_provider: 'supabase',
        bucket: 'release-attachments', object_path: objectPath,
        kind: 'attachment', mime_type: mimeType, original_filename: fileName,
        size_bytes: actualSize, status: 'ready', is_public: false,
      }).select('id').single();
      if (assetErr) throw assetErr;
      const { error: linkErr } = await supabase.from('work_assets').insert({
        work_id: workId, release_id: releaseId, asset_file_id: asset.id,
        role: 'attachment', sort_order: sortOrder, is_primary: false,
      });
      if (linkErr) throw linkErr;
      return jsonResponse(200, { ok: true, asset_file_id: asset.id }, cors);
    }

    // ── Mode A: droplet-hosted video registration ──
    if (body.remote_video) {
      if (work.kind !== 'anime' || !releaseId) {
        return jsonResponse(400, { error: 'An episode release is required for video.' }, cors);
      }
      const paid = Number(work.price_sakura) > 0;
      const prefix = paid
        ? `/media/v1/creator/private/${walletAddress}/${workId}/`
        : `/creator-media/${walletAddress}/${workId}/`;
      const posterPrefix = `/creator-media/${walletAddress}/${workId}/`;
      const videoUrl = String(body.remote_video.video_url || '').trim();
      if (!videoUrl.startsWith(prefix) || !VIDEO_FILE_RE.test(videoUrl.slice(prefix.length))) {
        return jsonResponse(400, { error: 'Video path must belong to this wallet and work.' }, cors);
      }
      const posterUrl = String(body.remote_video.poster_url || '').trim();
      if (posterUrl && (!posterUrl.startsWith(posterPrefix) ||
        !POSTER_FILE_RE.test(posterUrl.slice(posterPrefix.length)) ||
        posterUrl.slice(posterPrefix.length, -4) !== videoUrl.slice(prefix.length).replace(/\.(mp4|mov|webm|m4v)$/i, ''))) {
        return jsonResponse(400, { error: 'Poster path must match this video.' }, cors);
      }
      const mediaOrigin = Deno.env.get('MEDIA_PUBLIC_BASE_URL') || 'https://165-232-83-159.nip.io';
      const videoCheck = await fetch(paid
        ? `${mediaOrigin}/media/v1/creator/videos/check?path=${encodeURIComponent(videoUrl)}`
        : `${mediaOrigin}${videoUrl}`, {
        method: paid ? 'GET' : 'HEAD',
        headers: paid ? {
          'x-wallet-address': req.headers.get('x-wallet-address') || '',
          'x-signature': req.headers.get('x-signature') || '',
          'x-message': req.headers.get('x-message') || '',
        } : undefined,
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (!videoCheck?.ok) {
        return jsonResponse(422, { error: 'Uploaded video is not reachable. Retry registration.' }, cors);
      }

      const { data: videoAsset, error: assetErr } = await supabase
        .from('asset_files')
        .insert({
          owner_wallet: walletAddress,
          storage_provider: 'local', // droplet disk, served by nginx
          bucket: 'anime-media',
          object_path: videoUrl,
          kind: 'video_source',
          mime_type: 'video/mp4',
          size_bytes: Math.max(0, Number(body.remote_video.size_bytes) || 0),
          duration_ms: Number.isFinite(body.remote_video.duration_ms)
            ? Number(body.remote_video.duration_ms)
            : null,
          status: 'ready',
          is_public: !paid,
          metadata: { host: 'droplet', poster_url: posterUrl || null },
        })
        .select('id')
        .single();
      if (assetErr) throw assetErr;

      const rows = [
        {
          work_id: workId,
          release_id: releaseId,
          asset_file_id: videoAsset.id,
          role: 'video_source',
          sort_order: sortOrder,
          is_primary: isPrimary,
        },
      ];

      let posterAssetId: string | null = null;
      if (posterUrl) {
        const { data: posterAsset, error: posterErr } = await supabase
          .from('asset_files')
          .insert({
            owner_wallet: walletAddress,
            storage_provider: 'local',
            bucket: 'anime-posters',
            object_path: posterUrl,
            kind: 'poster',
            mime_type: 'image/jpeg',
            status: 'ready',
            is_public: true,
            metadata: { host: 'droplet', for_video: videoUrl },
          })
          .select('id')
          .single();
        if (posterErr) throw posterErr;
        posterAssetId = posterAsset.id;
        rows.push({
          work_id: workId,
          release_id: releaseId,
          asset_file_id: posterAsset.id,
          role: 'poster',
          sort_order: sortOrder,
          is_primary: isPrimary,
        });
      }

      const { error: linkErr } = await supabase.from('work_assets').insert(rows);
      if (linkErr) throw linkErr;

      return jsonResponse(200, {
        ok: true,
        asset_file_id: videoAsset.id,
        poster_asset_id: posterAssetId,
        video_url: videoUrl,
        poster_url: posterUrl || null,
      }, cors);
    }

    // ── Mode B: image upload ──
    const role = String(body.role || '').trim();
    const target = IMAGE_ROLES[role];
    if (!target) {
      return jsonResponse(400, { error: `role must be one of: ${Object.keys(IMAGE_ROLES).join(', ')} (or pass remote_video).` }, cors);
    }
    if (role === 'thumbnail' && Number(work.price_sakura) > 0) {
      return jsonResponse(403, { error: 'Paid chapter pages cannot be published as public thumbnails.' }, cors);
    }
    const rawBase64 = body.image_base64?.trim();
    if (!rawBase64) return jsonResponse(400, { error: 'image_base64 is required.' }, cors);
    const mimeType = body.mime_type?.trim() || 'image/jpeg';
    if (!ALLOWED_MIME.has(mimeType)) {
      return jsonResponse(400, { error: 'Use a JPEG, PNG, or WebP image.' }, cors);
    }
    const bytes = decodeBase64(rawBase64);
    if (!bytes.length) return jsonResponse(400, { error: 'Image data is empty.' }, cors);
    if (bytes.length > MAX_IMAGE_BYTES) {
      return jsonResponse(400, { error: 'Image must be 6 MB or smaller.' }, cors);
    }

    const ext = extForMime(mimeType);
    const objectPath = `${walletAddress}/${workId}/${releaseId ?? 'work'}/${role}-${String(sortOrder).padStart(3, '0')}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(target.bucket)
      .upload(objectPath, bytes, { contentType: mimeType, upsert: false });
    if (uploadErr) throw uploadErr;

    const { data: asset, error: assetErr } = await supabase
      .from('asset_files')
      .insert({
        owner_wallet: walletAddress,
        storage_provider: 'supabase',
        bucket: target.bucket,
        object_path: objectPath,
        kind: target.kind,
        mime_type: mimeType,
        size_bytes: bytes.length,
        width: Number.isFinite(body.width) ? Number(body.width) : null,
        height: Number.isFinite(body.height) ? Number(body.height) : null,
        status: 'ready',
        is_public: target.isPublic,
      })
      .select('id')
      .single();
    if (assetErr) throw assetErr;

    const { error: linkErr } = await supabase.from('work_assets').insert({
      work_id: workId,
      release_id: releaseId,
      asset_file_id: asset.id,
      role,
      sort_order: sortOrder,
      is_primary: isPrimary,
    });
    if (linkErr) throw linkErr;

    // URL for immediate client display: public URL for public buckets,
    // 1-hour signed URL for private ones (manga pages).
    let url: string;
    if (target.isPublic) {
      url = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/${target.bucket}/${objectPath}`;
    } else {
      const { data: signed, error: signErr } = await supabase.storage
        .from(target.bucket)
        .createSignedUrl(objectPath, 3600);
      if (signErr) throw signErr;
      url = signed.signedUrl;
    }

    // A cover is the work's catalog art. Record it on the work itself so the
    // catalog + detail screens can read release_metadata.cover_url directly
    // (they don't join work_assets). Merge so other metadata is preserved.
    if (role === 'cover') {
      const { data: existing } = await supabase
        .from('creator_works')
        .select('release_metadata')
        .eq('id', workId)
        .maybeSingle();
      const meta =
        existing?.release_metadata && typeof existing.release_metadata === 'object'
          ? (existing.release_metadata as Record<string, unknown>)
          : {};
      await supabase
        .from('creator_works')
        .update({
          release_metadata: { ...meta, cover_url: url, cover_path: objectPath },
          updated_at: new Date().toISOString(),
        })
        .eq('id', workId);
    }

    return jsonResponse(200, {
      ok: true,
      asset_file_id: asset.id,
      bucket: target.bucket,
      object_path: objectPath,
      url,
    }, cors);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Upload failed.';
    const status = /wallet|signature|expired/i.test(message) ? 401 : 500;
    return jsonResponse(status, { error: message }, cors);
  }
});
