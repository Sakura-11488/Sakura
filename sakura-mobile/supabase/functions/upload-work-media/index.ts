import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

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
};

const cors = corsHeaders();
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DROPLET_PATH_RE = /^\/creator-media\/[1-9A-HJ-NP-Za-km-z]{32,44}\/[0-9a-f-]{36}\/[A-Za-z0-9.-]+$/;

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
    const body = (await req.json()) as UploadBody;

    const workId = body.work_id?.trim() ?? '';
    if (!UUID_RE.test(workId)) return jsonResponse(400, { error: 'Valid work_id is required.' }, cors);
    const releaseId = body.release_id?.trim() || null;
    if (releaseId && !UUID_RE.test(releaseId)) {
      return jsonResponse(400, { error: 'release_id must be a UUID.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Ownership ──
    const { data: work, error: workErr } = await supabase
      .from('creator_works')
      .select('id, creator_wallet, kind')
      .eq('id', workId)
      .maybeSingle();
    if (workErr) throw workErr;
    if (!work || work.creator_wallet !== walletAddress) {
      return jsonResponse(403, { error: 'You do not own this work.' }, cors);
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

    // ── Mode A: droplet-hosted video registration ──
    if (body.remote_video) {
      const videoUrl = String(body.remote_video.video_url || '').trim();
      if (!DROPLET_PATH_RE.test(videoUrl) || !videoUrl.includes(`/${walletAddress}/`)) {
        return jsonResponse(400, { error: 'remote_video.video_url is not a valid droplet path for your wallet.' }, cors);
      }
      const posterUrl = String(body.remote_video.poster_url || '').trim();
      if (posterUrl && !DROPLET_PATH_RE.test(posterUrl)) {
        return jsonResponse(400, { error: 'remote_video.poster_url is not a valid droplet path.' }, cors);
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
          is_public: true,
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
