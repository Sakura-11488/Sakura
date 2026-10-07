import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { verifyTransfer, TransferVerificationError } from '../_shared/verify-transfer.ts';

const cors = corsHeaders();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  let buyer: string;
  try {
    buyer = verifyWalletHeaders(req.headers, 'purchase-creator-work').walletAddress;
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Unlock your wallet.' }, cors);
  }

  try {
    const body = (await req.json()) as { work_id?: string; payment_signature?: string };
    const workId = body.work_id?.trim() ?? '';
    const signature = body.payment_signature?.trim() ?? '';
    if (!UUID_RE.test(workId) || !SIGNATURE_RE.test(signature)) {
      return jsonResponse(400, { error: 'A work and payment transaction are required.' }, cors);
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: work, error: workError } = await supabase.from('creator_works')
      .select('id, creator_wallet, price_sakura, publication_status, visibility')
      .eq('id', workId).maybeSingle();
    if (workError) throw workError;
    if (!work || work.publication_status !== 'published' || work.visibility !== 'public') {
      return jsonResponse(404, { error: 'Published work not found.' }, cors);
    }
    const price = Number(work.price_sakura);
    if (!Number.isFinite(price) || price <= 0) {
      return jsonResponse(409, { error: 'This work is free; no purchase is needed.' }, cors);
    }
    if (buyer === work.creator_wallet) return jsonResponse(200, { ok: true, owner: true }, cors);

    const { data: existing, error: existingError } = await supabase
      .from('creator_work_entitlements').select('payment_signature')
      .eq('work_id', workId).eq('buyer_wallet', buyer).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return jsonResponse(200, { ok: true, already_owned: true }, cors);

    // Wait for finality. If this is still propagating the client retains the
    // signature and retries the claim; it must never send a second payment.
    const paid = await verifyTransfer({ signature, expectedSigner: buyer,
      receiver: work.creator_wallet, asset: 'sakura', finalized: true });
    const requiredRaw = BigInt(price.toFixed(paid.decimals).replace('.', ''));
    if (paid.raw < requiredRaw) {
      return jsonResponse(402, { error: `That transfer sent less than ${price} SAKURA to the creator.` }, cors);
    }

    const { error: insertError } = await supabase.from('creator_work_entitlements').insert({
      work_id: workId, buyer_wallet: buyer, creator_wallet: work.creator_wallet,
      price_sakura: price, payment_signature: signature,
    });
    if (insertError) {
      // The unique signature constraint rejects attempts to claim one transfer
      // for two works or wallets. A concurrent duplicate claim is idempotent.
      if (insertError.code === '23505') {
        const { data: recorded } = await supabase.from('creator_work_entitlements')
          .select('work_id, buyer_wallet').eq('payment_signature', signature).maybeSingle();
        if (recorded?.work_id === workId && recorded.buyer_wallet === buyer) {
          return jsonResponse(200, { ok: true, already_owned: true }, cors);
        }
        return jsonResponse(409, { error: 'This transaction has already been used for another purchase.' }, cors);
      }
      throw insertError;
    }
    return jsonResponse(200, { ok: true, signature }, cors);
  } catch (error) {
    if (error instanceof TransferVerificationError) {
      return jsonResponse(error.failure === 'unverifiable' ? 409 : 422,
        { error: error.failure === 'unverifiable'
          ? 'Payment is still finalizing. Retry access with the same transaction in a moment.'
          : error.message }, cors);
    }
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'Purchase failed.' }, cors);
  }
});
