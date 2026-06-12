import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type RequestBody = {
  reason?: string;
  social_links?: Record<string, string>;
};

const cors = corsHeaders();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-verification-request');
    const body = (await req.json()) as RequestBody;
    const reason = (body.reason ?? '').trim().slice(0, 2000);
    if (reason.length < 20) return jsonResponse(400, { error: 'Tell us why you should be verified.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [{ count: publishedWorkCount }, { data: profile }] = await Promise.all([
      supabase
        .from('creator_works')
        .select('*', { count: 'exact', head: true })
        .eq('creator_wallet', walletAddress)
        .eq('publication_status', 'published'),
      supabase
        .from('user_profiles')
        .select('follower_count, creator_verification_state')
        .eq('wallet_address', walletAddress)
        .maybeSingle(),
    ]);

    if (profile?.creator_verification_state === 'verified') {
      return jsonResponse(400, { error: 'Creator is already verified.' }, cors);
    }

    const { data: requestRow, error } = await supabase
      .from('creator_verification_requests')
      .insert({
        creator_wallet: walletAddress,
        status: 'submitted',
        reason,
        social_links: body.social_links ?? {},
        follower_count_at_request: profile?.follower_count ?? 0,
        published_work_count_at_request: publishedWorkCount ?? 0,
      })
      .select('id, status')
      .single();
    if (error) return jsonResponse(500, { error: error.message }, cors);

    await supabase
      .from('user_profiles')
      .update({ creator_verification_state: 'pending', updated_at: new Date().toISOString() })
      .eq('wallet_address', walletAddress);

    return jsonResponse(200, { ok: true, request: requestRow }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Verification request failed.' }, cors);
  }
});
