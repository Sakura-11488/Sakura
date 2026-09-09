import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { fetchConfirmedTransaction } from '../_shared/solana-rpc.ts';

/**
 * Confirm that a creator coin launch really happened, and move it to `launched`.
 *
 * WHAT THIS USED TO DO, and why it had to be rewritten: it checked
 * `JSON.stringify(txResult).includes(value)` for the wallet and the mint. That
 * is a substring scan over the whole RPC blob — it proves those characters
 * appear somewhere, not that anything was created. A 1-lamport self-transfer
 * puts your own wallet in `accountKeys`, and a transfer of any existing token
 * puts that mint in the parsed instruction, so any confirmed transaction
 * mentioning both passed. `mint_address` came from the request body, and
 * `creator_coins.mint_address` is UNIQUE — so a false claim also permanently
 * locked out that mint's real owner.
 *
 * It also could not run at all. It read `SOLANA_RPC_URL`, while
 * edge-functions.env.example documents `SOLANA_RPC` and lists that name only as
 * a legacy alias. Under the documented configuration it threw, and because the
 * whole handler sat in one `try` returning 401, a config mistake surfaced as an
 * authentication failure.
 *
 * WHAT IT CHECKS NOW. The mint is read from the database, never from the
 * caller: `creator-coin-launch` records the address the builder reserved at
 * build time, so the server already knows which mint this coin may claim. On
 * top of that the transaction must actually invoke pump.fun's `create_v2` with
 * that mint, and the creator must have paid for it.
 */

type VerifyBody = {
  coin_id?: string;
  launch_request_id?: string;
  signature?: string;
  /** Accepted for compatibility, then checked against the server's record. */
  mint_address?: string;
};

const cors = corsHeaders();

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/**
 * sha256("global:create_v2")[0..8]. NOT `create` (181ec828051c0777), which is a
 * different, older instruction still present on the same program. Derived from
 * mainnet — see docs/pumpfun-create-v2.md.
 */
const CREATE_V2_DISCRIMINATOR = 'd6904cec5f8b31b4';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Just enough base58 to read an instruction's leading discriminator. */
function base58ToHexPrefix(value: string, bytes: number): string {
  let n = 0n;
  for (const ch of value) {
    const i = B58.indexOf(ch);
    if (i < 0) return '';
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of value) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return out
    .slice(0, bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type Ix = { programId?: string; data?: string; accounts?: string[] };
type ParsedTx = {
  transaction?: { message?: { accountKeys?: Array<{ pubkey?: string }>; instructions?: Ix[] } };
  meta?: { innerInstructions?: Array<{ instructions?: Ix[] }> };
};

/**
 * The real check: this transaction invoked pump.fun's create_v2, the new mint
 * was the first account of that instruction, and the creator paid for it.
 */
function provesLaunch(tx: ParsedTx, creatorWallet: string, mintAddress: string): string | null {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  if (keys.length === 0) return 'Transaction has no account keys.';

  // accountKeys[0] is always the fee payer. That is what ties the launch to
  // this creator, rather than "the wallet appears somewhere in the blob".
  if (keys[0]?.pubkey !== creatorWallet) {
    return 'The creator did not pay for this transaction.';
  }

  const top = tx.transaction?.message?.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  for (const ix of [...top, ...inner]) {
    if (ix.programId !== PUMP_FUN_PROGRAM || !ix.data) continue;
    if (base58ToHexPrefix(ix.data, 8) !== CREATE_V2_DISCRIMINATOR) continue;
    // Account 0 of create_v2 is the mint being created.
    if (ix.accounts?.[0] === mintAddress) return null;
  }
  return 'Transaction does not create this mint on pump.fun.';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  // Auth in its own try, so a database or RPC failure is never reported as an
  // authentication problem — which is exactly how the old 401 misled.
  let walletAddress: string;
  try {
    ({ walletAddress } = verifyWalletHeaders(req.headers, 'creator-coin-verify'));
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Unauthorized.' }, cors);
  }

  try {
    const body = (await req.json()) as VerifyBody;
    if (!body.coin_id || !body.signature) {
      return jsonResponse(400, { error: 'coin_id and signature are required.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: coin, error: coinErr } = await supabase
      .from('creator_coins')
      .select('id, creator_wallet, status, mint_address')
      .eq('id', body.coin_id)
      .maybeSingle();
    if (coinErr) return jsonResponse(500, { error: coinErr.message }, cors);
    if (!coin) return jsonResponse(404, { error: 'Coin not found.' }, cors);
    if (coin.creator_wallet !== walletAddress) {
      return jsonResponse(403, { error: 'Not your creator coin.' }, cors);
    }

    // Idempotent: a retried verify after a successful one is not an error, and
    // a client that lost its response must be able to ask again.
    if (coin.status === 'launched') {
      return jsonResponse(200, { ok: true, status: 'launched', mint_address: coin.mint_address }, cors);
    }
    if (coin.status !== 'pending_signature') {
      return jsonResponse(
        409,
        { error: `This coin is ${coin.status}, so there is nothing to verify.`, status: coin.status },
        cors,
      );
    }

    // THE MINT COMES FROM THE SERVER. creator-coin-launch stored the address the
    // builder reserved, so the client cannot nominate a different one.
    const mintAddress = coin.mint_address;
    if (!mintAddress) {
      return jsonResponse(409, { error: 'No mint was issued for this coin.' }, cors);
    }
    if (body.mint_address && body.mint_address !== mintAddress) {
      return jsonResponse(400, { error: 'Mint address does not match the one issued for this coin.' }, cors);
    }

    // A launch request must belong to THIS coin, not merely to this wallet.
    if (body.launch_request_id) {
      const { data: reqRow, error: reqErr } = await supabase
        .from('creator_coin_launch_requests')
        .select('id, creator_coin_id')
        .eq('id', body.launch_request_id)
        .maybeSingle();
      if (reqErr) return jsonResponse(500, { error: reqErr.message }, cors);
      if (!reqRow || reqRow.creator_coin_id !== coin.id) {
        return jsonResponse(400, { error: 'That launch request is not for this coin.' }, cors);
      }
    }

    let tx: ParsedTx;
    try {
      tx = (await fetchConfirmedTransaction(body.signature)) as ParsedTx;
    } catch (error) {
      // "Not confirmed yet" is a state the client can act on, not a server fault.
      return jsonResponse(
        409,
        { error: error instanceof Error ? error.message : 'Transaction is not confirmed.' },
        cors,
      );
    }

    const failure = provesLaunch(tx, walletAddress, mintAddress);
    if (failure) return jsonResponse(400, { error: failure }, cors);

    const now = new Date().toISOString();
    const { error: txErr } = await supabase.from('creator_coin_launch_transactions').upsert(
      {
        creator_coin_id: coin.id,
        creator_wallet: walletAddress,
        signature: body.signature,
        transaction_type: 'launch',
        status: 'confirmed',
        verified_at: now,
        metadata: { mint_address: mintAddress, launch_request_id: body.launch_request_id ?? null },
      },
      { onConflict: 'signature' },
    );
    if (txErr) return jsonResponse(500, { error: txErr.message }, cors);

    const { error: updateErr } = await supabase
      .from('creator_coins')
      .update({
        launch_signature: body.signature,
        status: 'launched',
        launched_at: now,
        updated_at: now,
      })
      .eq('id', coin.id)
      // Only from pending_signature, so two concurrent verifies cannot both
      // believe they were the one that launched it.
      .eq('status', 'pending_signature');
    if (updateErr) return jsonResponse(500, { error: updateErr.message }, cors);

    // Spend the vanity mint. Until this runs the pool row is still `reserved`
    // and could be released back into circulation while the coin exists on
    // chain — handing a second creator an address that is already taken.
    const { error: mintErr } = await supabase.rpc('mark_vanity_mint_consumed', {
      p_public_key: mintAddress,
      p_signature: body.signature,
    });
    if (mintErr) {
      // Not fatal — the coin genuinely launched — but it must not pass silently.
      console.error(
        JSON.stringify({ event: 'vanity-consume-failed', mint: mintAddress, detail: mintErr.message }),
      );
    }

    if (body.launch_request_id) {
      await supabase
        .from('creator_coin_launch_requests')
        .update({ status: 'verified', updated_at: now })
        .eq('id', body.launch_request_id)
        .eq('creator_wallet', walletAddress);
    }

    return jsonResponse(200, { ok: true, status: 'launched', mint_address: mintAddress }, cors);
  } catch (error) {
    return jsonResponse(
      500,
      { error: error instanceof Error ? error.message : 'Coin verification failed.' },
      cors,
    );
  }
});
