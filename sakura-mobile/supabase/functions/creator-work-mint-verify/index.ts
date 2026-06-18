import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type Body = {
  work_id?: string;
  tx_signature?: string;
  metadata_uri?: string;
  mint_type?: string;
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
      id: 'sakura-work-mint-verify',
      method: 'getTransaction',
      params: [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message ?? 'RPC transaction lookup failed.');
  if (!json.result || json.result.meta?.err) throw new Error('Mint receipt is not confirmed.');
  return json.result;
}

function transactionIncludesWallet(result: unknown, wallet: string): boolean {
  return JSON.stringify(result).includes(wallet);
}

function transactionIncludesMemo(result: unknown, workId: string): boolean {
  const raw = JSON.stringify(result);
  return raw.includes(`sakura:work-mint:${workId}`) || raw.includes(workId);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-work-mint-verify');
    const body = (await req.json()) as Body;
    const workId = body.work_id?.trim() ?? '';
    const txSignature = body.tx_signature?.trim() ?? '';
    const metadataUri = body.metadata_uri?.trim() ?? '';
    const mintType = body.mint_type?.trim() || 'collectible';

    if (!workId || !txSignature || !metadataUri) {
      return jsonResponse(400, { error: 'work_id, tx_signature, and metadata_uri are required.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: work, error: workErr } = await supabase
      .from('creator_works')
      .select('id, creator_wallet, title, kind')
      .eq('id', workId)
      .maybeSingle();
    if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
    if (!work) return jsonResponse(404, { error: 'Work not found.' }, cors);
    if (work.creator_wallet !== walletAddress) return jsonResponse(403, { error: 'Not your work.' }, cors);

    const { data: duplicate } = await supabase
      .from('work_mints')
      .select('*')
      .eq('setup_tx_signature', txSignature)
      .maybeSingle();
    if (duplicate) {
      if (duplicate.creator_wallet !== walletAddress) {
        return jsonResponse(400, { error: 'Mint receipt already claimed.' }, cors);
      }
      return jsonResponse(200, { ok: true, mint: duplicate }, cors);
    }

    const tx = await fetchConfirmedTransaction(txSignature);
    if (!transactionIncludesWallet(tx, walletAddress)) {
      return jsonResponse(400, { error: 'Transaction signer does not match wallet.' }, cors);
    }
    if (!transactionIncludesMemo(tx, workId)) {
      return jsonResponse(400, { error: 'Transaction memo does not match this work.' }, cors);
    }

    const now = new Date().toISOString();
    const mintRow = {
      work_id: workId,
      release_id: null,
      creator_wallet: walletAddress,
      mint_scope: 'work',
      mint_type: mintType,
      status: 'pending_review',
      metadata_uri: metadataUri,
      mint_price: 0,
      currency: 'SKR',
      setup_tx_signature: txSignature,
      verified_at: now,
      verification_state: { signature: txSignature, verified_at: now, method: 'memo' },
      updated_at: now,
    };

    const { data: mint, error: mintErr } = await supabase
      .from('work_mints')
      .insert(mintRow)
      .select('*')
      .single();

    if (mintErr) return jsonResponse(500, { error: mintErr.message }, cors);

    await supabase.from('creator_works').update({ minting_enabled: true, updated_at: now }).eq('id', workId);
    return jsonResponse(200, { ok: true, mint }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Mint verification failed.' }, cors);
  }
});
