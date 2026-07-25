import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from 'https://esm.sh/@solana/web3.js@1.98.4';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from 'https://esm.sh/@solana/spl-token@0.4.9';
import bs58 from 'https://esm.sh/bs58@6.0.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/wallet-auth.ts';
import { getSolanaRpcUrl } from '../_shared/solana-rpc.ts';

/**
 * Settle queued XP swaps.
 *
 * Deliberately separate from redeem-xp: this is the only place the payout key
 * is loaded, and nothing a user can call reaches it. Intended to run on a cron
 * or be triggered by an operator, guarded by a shared secret.
 *
 * The XP was already debited when the swap was queued, so this function only
 * moves tokens. If a transfer fails the XP is returned and the row is marked
 * failed — a user is never charged for SAKURA that did not arrive.
 */

const cors = corsHeaders('POST, OPTIONS');
const DEFAULT_SAKURA_MINT = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const SAKURA_DECIMALS = 6;
/** Bounded so one invocation can't run past the function timeout mid-transfer. */
const MAX_PER_RUN = 10;

function sakuraMint(): string {
  return Deno.env.get('SAKURA_MINT')?.trim() || DEFAULT_SAKURA_MINT;
}

function loadPayoutAuthority(): Keypair {
  const raw = Deno.env.get('SAKURA_PAYOUT_SECRET')?.trim();
  if (!raw) throw new Error('SAKURA_PAYOUT_SECRET is not set.');
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    const parsed = JSON.parse(raw) as number[];
    if (!Array.isArray(parsed) || parsed.length < 64) {
      throw new Error('SAKURA_PAYOUT_SECRET is invalid.');
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  // Operator-only. Without this any caller could drive treasury spend timing.
  const expected = Deno.env.get('XP_PAYOUT_ADMIN_SECRET')?.trim();
  if (!expected || req.headers.get('x-admin-secret')?.trim() !== expected) {
    return jsonResponse(401, { error: 'Unauthorized.' }, cors);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let authority: Keypair;
  try {
    authority = loadPayoutAuthority();
  } catch (err) {
    return jsonResponse(503, { error: err instanceof Error ? err.message : 'Unavailable.' }, cors);
  }

  const { data: pending } = await supabase
    .from('xp_redemptions')
    .select('id, wallet_address, xp_spent, sakura_amount')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (!pending?.length) return jsonResponse(200, { ok: true, processed: 0 }, cors);

  const connection = new Connection(getSolanaRpcUrl(), 'confirmed');
  const mint = new PublicKey(sakuraMint());
  const fromAta = await getAssociatedTokenAddress(mint, authority.publicKey);

  const results: { id: string; status: string; signature?: string; error?: string }[] = [];

  for (const row of pending) {
    const rawAmount = BigInt(Math.round(Number(row.sakura_amount) * 10 ** SAKURA_DECIMALS));

    /** Return the XP; a user must never be charged for tokens that never landed. */
    const fail = async (reason: string) => {
      await supabase.rpc('debit_xp_for_redemption', {
        p_wallet: row.wallet_address,
        p_xp: -row.xp_spent,
      });
      await supabase
        .from('xp_redemptions')
        .update({ status: 'failed', error: reason.slice(0, 300), updated_at: new Date().toISOString() })
        .eq('id', row.id);
      results.push({ id: row.id, status: 'failed', error: reason });
    };

    try {
      const fromAccount = await getAccount(connection, fromAta).catch(() => null);
      if (!fromAccount) {
        await fail('Payout wallet holds no SAKURA account.');
        break; // pool is unusable; leave the rest queued rather than failing them all
      }
      if (fromAccount.amount < rawAmount) {
        await fail('Payout wallet balance too low.');
        break;
      }

      const recipient = new PublicKey(row.wallet_address);
      const toAta = await getAssociatedTokenAddress(mint, recipient);

      const tx = new Transaction();
      // First-time recipients have no SAKURA account yet; the payer creates it.
      const toAccount = await getAccount(connection, toAta).catch(() => null);
      if (!toAccount) {
        tx.add(createAssociatedTokenAccountInstruction(authority.publicKey, toAta, recipient, mint));
      }
      tx.add(
        createTransferCheckedInstruction(
          fromAta,
          mint,
          toAta,
          authority.publicKey,
          rawAmount,
          SAKURA_DECIMALS,
        ),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = authority.publicKey;
      tx.sign(authority);

      const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      await supabase
        .from('xp_redemptions')
        .update({ status: 'sent', tx_signature: signature, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      results.push({ id: row.id, status: 'sent', signature });
    } catch (err) {
      await fail(err instanceof Error ? err.message : 'Transfer failed.');
    }
  }

  return jsonResponse(200, { ok: true, processed: results.length, results }, cors);
});
