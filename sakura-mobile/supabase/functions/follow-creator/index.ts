import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type FollowBody = {
  action?: 'follow' | 'unfollow' | 'status';
  creator_wallet?: string;
  notify_new_works?: boolean;
};

const cors = corsHeaders();

/**
 * Read-only. This is the number returned to the client; it is NOT written back
 * to user_profiles.follower_count.
 *
 * This function used to follow the count with its own UPDATE of that column,
 * which made it the third writer racing two triggers on creator_follows. It was
 * also the worst of the three: it ran after the transaction had committed, so
 * concurrent follows could interleave and write each other's stale values, and
 * `if (error) return 0` below meant a transient read failure wrote a hard zero
 * over a count the in-transaction trigger had already got right. The single
 * absolute-recount trigger installed by 20260727000000_follow_counts_single_writer.sql
 * owns that column now.
 */
async function countFollowers(
  supabase: ReturnType<typeof createClient>,
  creatorWallet: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('creator_follows')
    .select('*', { count: 'exact', head: true })
    .eq('creator_wallet', creatorWallet);
  if (error) return 0;
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-follow');
    const body = (await req.json()) as FollowBody;
    const creatorWallet = body.creator_wallet?.trim() ?? '';
    if (!isWallet(creatorWallet)) return jsonResponse(400, { error: 'Invalid creator wallet.' }, cors);
    if (creatorWallet === walletAddress) return jsonResponse(400, { error: 'You cannot follow yourself.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const action = body.action ?? 'follow';
    if (action === 'unfollow') {
      const { error } = await supabase
        .from('creator_follows')
        .delete()
        .eq('follower_wallet', walletAddress)
        .eq('creator_wallet', creatorWallet);
      if (error) return jsonResponse(500, { error: error.message }, cors);
    } else if (action === 'follow') {
      const { error } = await supabase.from('creator_follows').upsert(
        {
          follower_wallet: walletAddress,
          creator_wallet: creatorWallet,
          notify_new_works: body.notify_new_works ?? true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'follower_wallet,creator_wallet' },
      );
      if (error) return jsonResponse(500, { error: error.message }, cors);
    }

    const [{ data: follow }, { data: profile }, followerCount] = await Promise.all([
      supabase
        .from('creator_follows')
        .select('notify_new_works, created_at')
        .eq('follower_wallet', walletAddress)
        .eq('creator_wallet', creatorWallet)
        .maybeSingle(),
      supabase
        .from('user_profiles')
        .select('creator_verification_state, creator_verified_at')
        .eq('wallet_address', creatorWallet)
        .maybeSingle(),
      countFollowers(supabase, creatorWallet),
    ]);

    return jsonResponse(
      200,
      {
        following: !!follow,
        notify_new_works: follow?.notify_new_works ?? false,
        follower_count: followerCount,
        verified: profile?.creator_verification_state === 'verified',
        creator_verified_at: profile?.creator_verified_at ?? null,
      },
      cors,
    );
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Follow failed.' }, cors);
  }
});
