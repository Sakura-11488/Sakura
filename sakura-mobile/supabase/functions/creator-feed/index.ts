import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse } from '../_shared/wallet-auth.ts';

type FeedBody = {
  limit?: number;
  cursor?: string;
  creator_wallet?: string;
};

const cors = corsHeaders();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const body = (await req.json().catch(() => ({}))) as FeedBody;
    const limit = Math.min(Math.max(body.limit ?? 20, 1), 50);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let query = supabase
      .from('creator_posts')
      .select('*')
      .eq('visibility', 'public')
      .eq('moderation_state', 'approved')
      .order('published_at', { ascending: false })
      .limit(limit);

    if (body.cursor) query = query.lt('published_at', body.cursor);
    if (body.creator_wallet) query = query.eq('creator_wallet', body.creator_wallet);

    const { data: posts, error } = await query;
    if (error) return jsonResponse(500, { error: error.message }, cors);
    const postIds = (posts ?? []).map((post) => post.id);
    const wallets = [...new Set((posts ?? []).map((post) => post.creator_wallet))];

    const [{ data: media }, { data: profiles }] = await Promise.all([
      postIds.length
        ? supabase
            .from('creator_post_media')
            .select('*')
            .in('post_id', postIds)
            .order('sort_order', { ascending: true })
        : Promise.resolve({ data: [] }),
      wallets.length
        ? supabase
            .from('user_profiles')
            .select('wallet_address, display_name, avatar_seed, avatar_url, creator_verification_state')
            .in('wallet_address', wallets)
        : Promise.resolve({ data: [] }),
    ]);

    const mediaByPost = new Map<string, unknown[]>();
    for (const item of media ?? []) {
      const list = mediaByPost.get(item.post_id) ?? [];
      list.push(item);
      mediaByPost.set(item.post_id, list);
    }

    const profileByWallet = new Map((profiles ?? []).map((profile) => [profile.wallet_address, profile]));
    const items = (posts ?? []).map((post) => ({
      ...post,
      media: mediaByPost.get(post.id) ?? [],
      creator: profileByWallet.get(post.creator_wallet) ?? null,
    }));

    return jsonResponse(200, { items, nextCursor: items.at(-1)?.published_at ?? null }, cors);
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'Feed load failed.' }, cors);
  }
});
