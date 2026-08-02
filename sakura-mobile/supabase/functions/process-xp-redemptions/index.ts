import { Buffer } from 'node:buffer';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from 'https://esm.sh/@solana/web3.js@1.98.4';
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
 * moves tokens. Refunds are issued ONLY for failures that provably happened
 * before a transaction was broadcast (or that landed on-chain and failed).
 * Anything ambiguous — a send or confirm that errored after broadcast — is left
 * as `processing` with its signature recorded, and the next run reconciles it
 * against the chain. Refunding on ambiguity is how a user ends up holding both
 * the SAKURA and the returned XP.
 *
 * Rows are claimed with a compare-and-swap on status before any transfer, so
 * two concurrent invocations cannot pay the same row twice.
 */

const cors = corsHeaders('POST, OPTIONS');
const DEFAULT_SAKURA_MINT = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const SAKURA_DECIMALS = 6;
/** Bounded so one invocation can't run past the function timeout mid-transfer. */
const MAX_PER_RUN = 10;
/**
 * How long a `processing` row must sit unresolved before it is recycled to
 * `pending`. A transaction is only valid while its blockhash is (~60-90s), so
 * after this window a not-found signature can no longer land and re-paying is
 * safe. Far above the blockhash lifetime on purpose.
 */
const RECYCLE_AFTER_MS = 10 * 60 * 1000;

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

/**
 * Compare via SHA-256 digests so timing reveals nothing about the secret. The
 * digest comparison itself needn't be constant-time: leaking prefix info about
 * an unpredictable hash gives an attacker nothing to iterate on, which is the
 * property a direct string compare lacks.
 */
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

type RedemptionRow = {
  id: string;
  wallet_address: string;
  xp_spent: number;
  sakura_amount: number;
  tx_signature?: string | null;
  updated_at?: string;
};

// ── Minimal SPL Token primitives ─────────────────────────────────────────────
// @solana/spl-token's esm.sh build exceeds the edge worker's boot budget (the
// function died with WORKER_RESOURCE_LIMIT on every request), so the four
// primitives used here are implemented directly. The byte layouts are part of
// the SPL Token / ATA program interfaces and have never changed.

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Associated token account PDA for owner+mint (canonical derivation). */
function ataFor(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

/** ATA program instruction 1 = CreateIdempotent: no-op if the account exists. */
function createAtaIdempotentIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** Token program instruction 12 = TransferChecked: [12, u64 amount LE, u8 decimals]. */
function transferCheckedIx(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  // Operator-only. Without this any caller could drive treasury spend timing.
  const expected = Deno.env.get('XP_PAYOUT_ADMIN_SECRET')?.trim();
  const provided = req.headers.get('x-admin-secret')?.trim() ?? '';
  if (!expected || !(await secretsMatch(provided, expected))) {
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

  const connection = new Connection(getSolanaRpcUrl(), 'confirmed');
  const mint = new PublicKey(sakuraMint());
  const fromAta = ataFor(authority.publicKey, mint);

  const results: { id: string; status: string; signature?: string; error?: string }[] = [];
  const now = () => new Date().toISOString();

  /**
   * Refund the XP and mark the row failed. Pre-broadcast (or confirmed
   * on-chain-failed) rows only.
   *
   * Order matters: the status flip is a compare-and-swap that GATES the refund.
   * Refund-first had two loss modes — overlapping runs refunding the same row
   * twice, and a crash between refund and update leaving a refunded row
   * `processing` that later recycled into a full payout. With claim-first, the
   * worst crash outcome is a `failed` row missing its refund: operator-visible
   * and correctable, never a double-pay.
   */
  const refundAndFail = async (row: RedemptionRow, reason: string) => {
    const { data: marked, error: markErr } = await supabase
      .from('xp_redemptions')
      .update({ status: 'failed', error: reason.slice(0, 300), updated_at: now() })
      .eq('id', row.id)
      .eq('status', 'processing')
      .select('id');
    if (markErr || !marked?.length) {
      // Another invocation owns this row now (or the write failed) — refunding
      // here is exactly the double-refund the CAS exists to prevent.
      results.push({ id: row.id, status: 'refund-skipped', error: reason });
      return;
    }
    const { error: rpcErr } = await supabase.rpc('debit_xp_for_redemption', {
      p_wallet: row.wallet_address,
      p_xp: -row.xp_spent,
    });
    if (rpcErr) {
      await supabase
        .from('xp_redemptions')
        .update({ error: `${reason} (XP refund failed: ${rpcErr.message})`.slice(0, 300) })
        .eq('id', row.id);
    }
    results.push({ id: row.id, status: 'failed', error: reason });
  };

  // ── Phase 0: reconcile rows a previous run left in flight ──────────────────
  // `processing` means a claim happened but the outcome was never recorded —
  // a crash, a confirm timeout, or an ambiguous send error. The chain, not the
  // database, knows what actually happened.
  const { data: inflight } = await supabase
    .from('xp_redemptions')
    .select('id, wallet_address, xp_spent, sakura_amount, tx_signature, updated_at')
    .eq('status', 'processing')
    .limit(50);

  for (const row of (inflight ?? []) as RedemptionRow[]) {
    try {
      if (row.tx_signature) {
        const st = await connection.getSignatureStatus(row.tx_signature, {
          searchTransactionHistory: true,
        });
        const conf = st.value?.confirmationStatus;
        if ((conf === 'confirmed' || conf === 'finalized') && !st.value?.err) {
          // Fenced on the signature we actually observed: a stale snapshot must
          // not mark a row 'sent' after another run recycled and re-stamped it.
          await supabase
            .from('xp_redemptions')
            .update({ status: 'sent', updated_at: now() })
            .eq('id', row.id)
            .eq('status', 'processing')
            .eq('tx_signature', row.tx_signature);
          results.push({ id: row.id, status: 'sent', signature: row.tx_signature });
          continue;
        }
        if (st.value?.err) {
          // Landed and failed on-chain: no tokens moved, refunding is safe.
          await refundAndFail(row, `On-chain failure: ${JSON.stringify(st.value.err).slice(0, 120)}`);
          continue;
        }
      }
      // Signature unknown to the chain (or none was recorded). Only recycle
      // once the blockhash lifetime is safely over — recycling early could
      // double-pay if the original transaction lands late.
      const ageMs = Date.now() - new Date(row.updated_at ?? 0).getTime();
      if (ageMs > RECYCLE_AFTER_MS) {
        // Fenced on the exact signature (or its absence) we observed, so a
        // stale snapshot can never null a live signature that another run
        // stamped after re-claiming this row.
        let recycle = supabase
          .from('xp_redemptions')
          .update({ status: 'pending', tx_signature: null, updated_at: now() })
          .eq('id', row.id)
          .eq('status', 'processing');
        recycle = row.tx_signature
          ? recycle.eq('tx_signature', row.tx_signature)
          : recycle.is('tx_signature', null);
        await recycle;
        results.push({ id: row.id, status: 'requeued' });
      } else {
        results.push({ id: row.id, status: 'inflight' });
      }
    } catch (err) {
      // Reconciliation must never flip state on an RPC error — leave the row
      // for the next run rather than guess.
      results.push({
        id: row.id,
        status: 'inflight',
        error: err instanceof Error ? err.message.slice(0, 120) : 'reconcile failed',
      });
    }
  }

  // ── Phase 1: pay newly pending rows ─────────────────────────────────────────
  const { data: pending } = await supabase
    .from('xp_redemptions')
    .select('id, wallet_address, xp_spent, sakura_amount')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  for (const row of (pending ?? []) as RedemptionRow[]) {
    // Claim the row before touching funds. The status guard makes this a
    // compare-and-swap: of N concurrent invocations, exactly one proceeds.
    const { data: claimed } = await supabase
      .from('xp_redemptions')
      .update({ status: 'processing', updated_at: now() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id');
    if (!claimed?.length) continue;

    const rawAmount = BigInt(Math.round(Number(row.sakura_amount) * 10 ** SAKURA_DECIMALS));
    let broadcast = false;

    try {
      const fromBalance = await connection
        .getTokenAccountBalance(fromAta)
        .then((r) => BigInt(r.value.amount))
        .catch(() => null);
      if (fromBalance === null) {
        await refundAndFail(row, 'Payout wallet holds no SAKURA account.');
        break; // pool is unusable; leave the rest queued rather than failing them all
      }
      if (fromBalance < rawAmount) {
        await refundAndFail(row, 'Payout wallet balance too low.');
        break;
      }

      const recipient = new PublicKey(row.wallet_address);
      const toAta = ataFor(recipient, mint);

      const tx = new Transaction();
      // First-time recipients have no SAKURA account yet; the payer creates it.
      // Idempotent variant: several pending rows share a recipient, and if an
      // earlier transfer's ATA creation is in flight but unconfirmed when this
      // row builds, the existence check still reports null — a plain create
      // would then fail the whole transfer on-chain.
      const toInfo = await connection.getAccountInfo(toAta).catch(() => null);
      if (!toInfo) {
        tx.add(createAtaIdempotentIx(authority.publicKey, toAta, recipient, mint));
      }
      tx.add(
        transferCheckedIx(fromAta, mint, toAta, authority.publicKey, rawAmount, SAKURA_DECIMALS),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = authority.publicKey;
      tx.sign(authority);

      // Record the signature BEFORE broadcasting. If we crash between send and
      // the status update, the next run finds `processing` + signature and asks
      // the chain — without this, a crash there would re-pay the row.
      // The stamp is a CAS whose result gates the send: broadcasting a tx whose
      // signature failed to persist would silently void that protection, and a
      // zero-row match means another run took the row — sending would double-pay.
      const sigBytes = tx.signatures[0]?.signature;
      if (!sigBytes) throw new Error('Signing produced no signature.');
      const signature = bs58.encode(sigBytes);
      const { data: stamped, error: stampErr } = await supabase
        .from('xp_redemptions')
        .update({ tx_signature: signature, updated_at: now() })
        .eq('id', row.id)
        .eq('status', 'processing')
        .is('tx_signature', null)
        .select('id');
      if (stampErr || !stamped?.length) {
        // Provably not broadcast, but do NOT refund: if the row is still ours it
        // recycles in 10 minutes; if it was re-claimed, the new owner pays it.
        results.push({ id: row.id, status: 'skipped', error: 'signature stamp not persisted; send aborted' });
        continue;
      }

      // Serialize BEFORE flipping the flag: a serialization throw is provably
      // pre-broadcast and may refund. From the send call onward the outcome is
      // ambiguous — a transport error (timeout, reset, gateway 5xx) can throw on
      // this side while the node still forwards the transaction to the leader.
      const wire = tx.serialize();
      broadcast = true;
      await connection.sendRawTransaction(wire, { maxRetries: 3 });
      const conf = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      // confirmTransaction resolves — does not throw — when the transaction
      // lands but fails on-chain. That outcome moved no tokens and is final, so
      // refunding is safe; without this check it would be recorded as 'sent'.
      if (conf.value.err) {
        await refundAndFail(row, `On-chain failure: ${JSON.stringify(conf.value.err).slice(0, 120)}`);
        continue;
      }

      await supabase
        .from('xp_redemptions')
        .update({ status: 'sent', updated_at: now() })
        .eq('id', row.id)
        .eq('status', 'processing');
      results.push({ id: row.id, status: 'sent', signature });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transfer failed.';
      if (!broadcast) {
        // Threw before the send call was ever made (balance read, blockhash
        // fetch, signing, serialization): the transfer provably did not happen,
        // refund is safe. Send-call errors flip `broadcast` first and land in
        // the other branch — a transport throw does not prove non-delivery.
        await refundAndFail(row, message);
      } else {
        // Broadcast but unconfirmed: the transfer may still land. Leave the
        // row `processing`; phase 0 of the next run settles it either way.
        results.push({ id: row.id, status: 'unconfirmed', error: message.slice(0, 200) });
      }
    }
  }

  const { count: remaining } = await supabase
    .from('xp_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  return jsonResponse(
    200,
    { ok: true, processed: results.length, remaining_pending: remaining ?? 0, results },
    cors,
  );
});
