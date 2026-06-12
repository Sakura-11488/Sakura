import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type BuybackBody = {
  creator_coin_id?: string;
  source_claim_id?: string;
  source_amount?: number;
  sakura_amount?: number;
  buyback_signature?: string;
};

const cors = corsHeaders();

async function assertConfirmed(signature: string) {
  const rpcUrl = Deno.env.get('SOLANA_RPC_URL')?.trim() || Deno.env.get('EXPO_PUBLIC_SOLANA_RPC_URL')?.trim();
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not configured.');
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sakura-buyback-verify',
      method: 'getSignatureStatuses',
      params: [[signature], { searchTransactionHistory: true }],
    }),
  });
  const json = await response.json();
  const status = json.result?.value?.[0];
  if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus)) {
    throw new Error('Buyback signature is not confirmed.');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'sakura-buyback-verify');
    const body = (await req.json()) as BuybackBody;
    if (!body.creator_coin_id || !body.buyback_signature) {
      return jsonResponse(400, { error: 'creator_coin_id and buyback_signature are required.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: coin, error: coinErr } = await supabase
      .from('creator_coins')
      .select('id, creator_wallet')
      .eq('id', body.creator_coin_id)
      .maybeSingle();
    if (coinErr) return jsonResponse(500, { error: coinErr.message }, cors);
    if (!coin) return jsonResponse(404, { error: 'Coin not found.' }, cors);
    if (coin.creator_wallet !== walletAddress) return jsonResponse(403, { error: 'Not your creator coin.' }, cors);

    await assertConfirmed(body.buyback_signature);
    const { data, error } = await supabase
      .from('sakura_buyback_records')
      .insert({
        creator_coin_id: body.creator_coin_id,
        source_claim_id: body.source_claim_id ?? null,
        source_asset: 'SOL',
        source_amount: body.source_amount ?? 0,
        sakura_amount: body.sakura_amount ?? null,
        buyback_signature: body.buyback_signature,
        status: 'confirmed',
        verified_at: new Date().toISOString(),
        metadata: { verified_by_creator_wallet: walletAddress },
      })
      .select('id')
      .single();
    if (error) return jsonResponse(500, { error: error.message }, cors);

    return jsonResponse(200, { ok: true, buyback_record_id: data.id }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Buyback verification failed.' }, cors);
  }
});
