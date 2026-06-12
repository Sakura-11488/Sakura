import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type LaunchBody = {
  name?: string;
  symbol?: string;
  description?: string;
  image_url?: string;
  metadata_uri?: string;
};

const cors = corsHeaders();
const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-coin-launch');
    const body = (await req.json()) as LaunchBody;
    const name = (body.name ?? '').trim().slice(0, 80);
    const symbol = (body.symbol ?? '').trim().toUpperCase();
    const description = (body.description ?? '').trim().slice(0, 2000);

    if (name.length < 2) return jsonResponse(400, { error: 'Coin name is required.' }, cors);
    if (!SYMBOL_RE.test(symbol)) return jsonResponse(400, { error: 'Symbol must be 2-10 uppercase letters or numbers.' }, cors);
    if (!body.metadata_uri && !body.image_url) {
      return jsonResponse(400, { error: 'Add stable token metadata or an image before launch.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [{ data: profile }, { data: eligibility }] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('creator_verification_state, follower_count, revenue_enabled_at')
        .eq('wallet_address', walletAddress)
        .maybeSingle(),
      supabase
        .from('creator_revenue_eligibility')
        .select('eligible, eligibility_state')
        .eq('creator_wallet', walletAddress)
        .maybeSingle(),
    ]);

    const verified = profile?.creator_verification_state === 'verified';
    const eligible = eligibility?.eligible === true || profile?.revenue_enabled_at;
    if (!verified || !eligible) {
      return jsonResponse(403, { error: 'Creator must be verified and revenue eligible before launching a coin.' }, cors);
    }

    const { data: coin, error: coinErr } = await supabase
      .from('creator_coins')
      .insert({
        creator_wallet: walletAddress,
        name,
        symbol,
        description,
        image_url: body.image_url ?? null,
        metadata_uri: body.metadata_uri ?? null,
        provider: 'pumpfun',
        status: 'requested',
      })
      .select('id')
      .single();
    if (coinErr) return jsonResponse(500, { error: coinErr.message }, cors);

    let providerResponse: Record<string, unknown> = {};
    let unsignedTransaction: string | null = null;
    const builderUrl = Deno.env.get('PUMPFUN_UNSIGNED_TX_URL')?.trim();

    if (builderUrl) {
      const response = await fetch(builderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorWallet: walletAddress,
          name,
          symbol,
          description,
          imageUrl: body.image_url ?? null,
          metadataUri: body.metadata_uri ?? null,
        }),
      });
      providerResponse = await response.json().catch(() => ({ status: response.status }));
      if (!response.ok) {
        await supabase.from('creator_coins').update({ status: 'failed' }).eq('id', coin.id);
        return jsonResponse(502, { error: 'Coin launch provider failed.', providerResponse }, cors);
      }
      const maybeTx = providerResponse.unsignedTransaction ?? providerResponse.transaction;
      unsignedTransaction = typeof maybeTx === 'string' ? maybeTx : null;
    }

    const { data: requestRow, error: requestErr } = await supabase
      .from('creator_coin_launch_requests')
      .insert({
        creator_wallet: walletAddress,
        creator_coin_id: coin.id,
        status: unsignedTransaction ? 'built' : 'submitted',
        requested_payload: {
          name,
          symbol,
          description,
          image_url: body.image_url ?? null,
          metadata_uri: body.metadata_uri ?? null,
        },
        unsigned_transaction: unsignedTransaction,
        provider_response: providerResponse,
      })
      .select('id, status')
      .single();
    if (requestErr) return jsonResponse(500, { error: requestErr.message }, cors);

    await supabase
      .from('creator_coins')
      .update({ status: unsignedTransaction ? 'pending_signature' : 'requested' })
      .eq('id', coin.id);

    return jsonResponse(
      200,
      {
        ok: true,
        coin_id: coin.id,
        launch_request_id: requestRow.id,
        status: requestRow.status,
        unsigned_transaction: unsignedTransaction,
      },
      cors,
    );
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Coin launch request failed.' }, cors);
  }
});
