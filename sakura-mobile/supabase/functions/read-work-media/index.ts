import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse } from '../_shared/wallet-auth.ts';

/**
 * Public reader for a creator work. Given a work_id, returns the work, its
 * published releases (chapters / episodes), and per-release media URLs:
 *   - novel  → body_text is already on the release row (returned as-is)
 *   - manga  → signed page URLs (manga-pages is a private bucket)
 *   - anime  → droplet video/poster paths (client resolves to an absolute /
 *              proxied URL; large video never touches Supabase)
 *
 * No wallet auth: only *published + public* works are returned, so drafts and
 * private works stay hidden. Runs with the service role so it can read private
 * buckets and sign page URLs.
 */

const cors = corsHeaders('POST, OPTIONS');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_URL_TTL = 60 * 60; // 1h signed URLs for private manga pages

type AssetRow = {
  role: string;
  sort_order: number | null;
  release_id: string | null;
  asset_files: {
    bucket: string;
    object_path: string;
    is_public: boolean;
    metadata: Record<string, unknown> | null;
  } | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const body = (await req.json().catch(() => ({}))) as { work_id?: string };
    const workId = body.work_id?.trim() ?? '';
    if (!UUID_RE.test(workId)) return jsonResponse(400, { error: 'Valid work_id is required.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: work, error: workErr } = await supabase
      .from('creator_works')
      .select(
        'id, creator_wallet, kind, title, slug, description, genres, series_status, published_at, release_metadata',
      )
      .eq('id', workId)
      .eq('publication_status', 'published')
      .eq('visibility', 'public')
      .maybeSingle();
    if (workErr) throw workErr;
    if (!work) return jsonResponse(404, { error: 'Work not found or not public.' }, cors);

    const { data: releases, error: relErr } = await supabase
      .from('work_releases')
      .select('id, sequence_number, title, summary, content_type, body_text, published_at')
      .eq('work_id', workId)
      .eq('publication_status', 'published')
      .eq('visibility', 'public')
      .order('sequence_number', { ascending: true });
    if (relErr) throw relErr;

    // All media for the work in one query, grouped by release below.
    const { data: assets, error: assetErr } = await supabase
      .from('work_assets')
      .select('role, sort_order, release_id, asset_files(bucket, object_path, is_public, metadata)')
      .eq('work_id', workId)
      .order('sort_order', { ascending: true });
    if (assetErr) throw assetErr;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const publicUrl = (bucket: string, path: string) =>
      `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;

    async function mediaForRelease(releaseId: string, kind: string) {
      const rows = ((assets ?? []) as AssetRow[]).filter(
        (a) => a.release_id === releaseId && a.asset_files,
      );
      if (kind === 'manga') {
        const pageRows = rows.filter((a) => a.role === 'manga_page');
        const pages: string[] = [];
        for (const row of pageRows) {
          const af = row.asset_files!;
          if (af.is_public) {
            pages.push(publicUrl(af.bucket, af.object_path));
          } else {
            const { data: signed } = await supabase.storage
              .from(af.bucket)
              .createSignedUrl(af.object_path, PAGE_URL_TTL);
            if (signed?.signedUrl) pages.push(signed.signedUrl);
          }
        }
        return { pages };
      }
      if (kind === 'anime') {
        const video = rows.find((a) => a.role === 'video_source')?.asset_files ?? null;
        const poster = rows.find((a) => a.role === 'poster')?.asset_files ?? null;
        return {
          // Droplet paths (storage_provider 'local'); client prefixes the media
          // host and, on web, routes through the media proxy.
          videoPath: video?.object_path ?? null,
          posterPath: poster?.object_path ?? null,
        };
      }
      return {};
    }

    const releaseOut = [];
    for (const r of releases ?? []) {
      releaseOut.push({
        id: r.id,
        sequence_number: r.sequence_number,
        title: r.title,
        summary: r.summary,
        content_type: r.content_type,
        body_text: work.kind === 'novel' ? r.body_text : '',
        published_at: r.published_at,
        media: await mediaForRelease(r.id, work.kind),
      });
    }

    const meta = (work.release_metadata ?? {}) as Record<string, unknown>;
    return jsonResponse(
      200,
      {
        work: {
          id: work.id,
          creator_wallet: work.creator_wallet,
          kind: work.kind,
          title: work.title,
          slug: work.slug,
          description: work.description,
          genres: work.genres,
          series_status: work.series_status,
          published_at: work.published_at,
          cover_url: typeof meta.cover_url === 'string' ? meta.cover_url : null,
        },
        releases: releaseOut,
      },
      cors,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Read failed.';
    return jsonResponse(500, { error: message }, cors);
  }
});
