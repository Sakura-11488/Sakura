import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type VerifyBody = {
  coin_id?: string;
  launch_request_id?: string;
  signature?: string;
  mint_address?: string;
};

const cors = corsHeaders();

async function fetchConfirmedTransaction(signature: string) {
  const rpcUrl = Deno.env.get('SOLANA_RPC_URL')?.trim() || Deno.env.get('EXPO_PUBLIC_SOLANA_RPC_URL')?.trim();
  if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not configured.');
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sakura-creator-coin-verify',
      method: 'getTransaction',
      params: [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message ?? 'RPC transaction lookup failed.');
  if (!json.result || json.result.meta?.err) throw new Error('Launch transaction is not confirmed.');
  return json.result;
}

function transactionMentions(result: any, value: string): boolean {
  const raw = JSON.stringify(result);
  return raw.includes(value);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-coin-verify');
    const body = (await req.json()) as VerifyBody;
    if (!body.coin_id || !body.signature || !body.mint_address) {
      return jsonResponse(400, { error: 'coin_id, signature, and mint_address are required.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: coin, error: coinErr } = await supabase
      .from('creator_coins')
      .select('id, creator_wallet, status')
      .eq('id', body.coin_id)
      .maybeSingle();
    if (coinErr) return jsonResponse(500, { error: coinErr.message }, cors);
    if (!coin) return jsonResponse(404, { error: 'Coin not found.' }, cors);
    if (coin.creator_wallet !== walletAddress) return jsonResponse(403, { error: 'Not your creator coin.' }, cors);

    const tx = await fetchConfirmedTransaction(body.signature);
    if (!transactionMentions(tx, walletAddress)) return jsonResponse(400, { error: 'Transaction does not include creator wallet.' }, cors);
    if (!transactionMentions(tx, body.mint_address)) return jsonResponse(400, { error: 'Transaction does not include mint address.' }, cors);

    const now = new Date().toISOString();
    const { error: txErr } = await supabase.from('creator_coin_launch_transactions').upsert(
      {
        creator_coin_id: body.coin_id,
        creator_wallet: walletAddress,
        signature: body.signature,
        transaction_type: 'launch',
        status: 'confirmed',
        verified_at: now,
        metadata: { mint_address: body.mint_address, launch_request_id: body.launch_request_id ?? null },
      },
      { onConflict: 'signature' },
    );
    if (txErr) return jsonResponse(500, { error: txErr.message }, cors);

    const { error: updateErr } = await supabase
      .from('creator_coins')
      .update({
        mint_address: body.mint_address,
        launch_signature: body.signature,
        status: 'launched',
        launched_at: now,
        updated_at: now,
      })
      .eq('id', body.coin_id);
    if (updateErr) return jsonResponse(500, { error: updateErr.message }, cors);

    if (body.launch_request_id) {
      await supabase
        .from('creator_coin_launch_requests')
        .update({ status: 'verified', updated_at: now })
        .eq('id', body.launch_request_id)
        .eq('creator_wallet', walletAddress);
    }

    return jsonResponse(200, { ok: true, status: 'launched' }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Coin verification failed.' }, cors);
  }
});
