import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type MediaInput = {
  media_type?: 'image' | 'video';
  url?: string;
  thumbnail_url?: string | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
};

type PostBody = {
  caption?: string;
  media?: MediaInput[];
  visibility?: 'public' | 'followers' | 'private';
};

const cors = corsHeaders();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-post');
    const body = (await req.json()) as PostBody;
    const caption = (body.caption ?? '').trim().slice(0, 2000);
    const media = (body.media ?? []).filter((item) => item.url && item.media_type).slice(0, 6);
    if (!caption && !media.length) return jsonResponse(400, { error: 'Post needs text or media.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const postType = media.some((item) => item.media_type === 'video')
      ? 'video'
      : media.length
        ? 'image'
        : 'text';
    const { data: post, error } = await supabase
      .from('creator_posts')
      .insert({
        creator_wallet: walletAddress,
        post_type: postType,
        caption,
        visibility: body.visibility ?? 'public',
        moderation_state: 'approved',
      })
      .select('*')
      .single();
    if (error) return jsonResponse(500, { error: error.message }, cors);

    if (media.length) {
      const { error: mediaErr } = await supabase.from('creator_post_media').insert(
        media.map((item, index) => ({
          post_id: post.id,
          media_type: item.media_type,
          url: item.url,
          thumbnail_url: item.thumbnail_url ?? null,
          width: item.width ?? null,
          height: item.height ?? null,
          duration_seconds: item.duration_seconds ?? null,
          sort_order: index,
        })),
      );
      if (mediaErr) return jsonResponse(500, { error: mediaErr.message }, cors);
    }

    return jsonResponse(200, { ok: true, post }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Post failed.' }, cors);
  }
});
