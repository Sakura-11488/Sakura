import { Buffer } from 'node:buffer';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
 * moves SOL or legacy SAKURA rewards. Refunds are issued ONLY for failures that provably happened
 * before a transaction was broadcast (or that landed on-chain and failed).
 * Anything ambiguous — a send or confirm that errored after broadcast — is left
 * as `processing` with its signature recorded, and the next run reconciles it
 * against the chain. Refunding on ambiguity is how a user ends up holding both
 * the payout and the returned XP.
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
 * Reclaim abandoned unsigned claims after this delay. A recorded signature
 * may already have landed even when the current RPC cannot find it, so signed
 * rows are never paid again based only on elapsed time.
 */
const RECYCLE_AFTER_MS = 10 * 60 * 1000;

function sakuraMint(): string {
  return Deno.env.get('SAKURA_MINT')?.trim() || DEFAULT_SAKURA_MINT;
}

type PayoutAsset = 'SOL' | 'SAKURA';

function loadPayoutAuthority(asset: PayoutAsset): Keypair {
  // Never reuse the token treasury key for native SOL implicitly.
  const secretName = asset === 'SOL' ? 'SOL_PAYOUT_SECRET' : 'SAKURA_PAYOUT_SECRET';
  const raw = Deno.env.get(secretName)?.trim();
  if (!raw) throw new Error(`${secretName} is not set.`);
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    try {
      const parsed = JSON.parse(raw) as number[];
      if (!Array.isArray(parsed) || parsed.length !== 64 ||
          parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error('Invalid key bytes.');
      }
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    } catch {
      throw new Error(`${secretName} is invalid.`);
    }
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
  payout_asset: PayoutAsset;
  sol_lamports: number | null;
  sakura_amount: number | null;
  tx_signature?: string | null;
  updated_at?: string;
};

// ── Minimal SPL Token primitives ─────────────────────────────────────────────
// @solana/spl-token's esm.sh build exceeds the edge worker's boot budget (the
// function died with WORKER_RESOURCE_LIMIT on every request), so the four
// primitives used here are implemented directly. The byte layouts are part of
// the SPL Token / ATA program interfaces, shared by classic and Token-2022, and
// have never changed; verified byte-identical to @solana/spl-token 0.4.9 output
// across the real pending recipients and amounts. The SAKURA mint carries no
// transfer-fee extension, so TransferChecked delivers full amounts.

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/**
 * The token program is a PARAMETER, detected from the mint account at runtime,
 * because the SAKURA mint is Token-2022 — its ATA derivation seeds and its
 * instruction target both differ from classic SPL. Assuming classic (as the
 * original code and spl-token's defaults both do) derives an account that
 * doesn't exist, and the treasury looks empty while fully funded.
 */

/** Associated token account PDA for owner+mint (canonical derivation). */
function ataFor(owner: PublicKey, mint: PublicKey, tokenProgramId: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
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
  tokenProgramId: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
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
  tokenProgramId: PublicKey,
): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgramId,
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Operator-only. Without this any caller could drive treasury spend timing.
  // Two accepted sources for the gate secret, both fail-closed:
  //  - XP_PAYOUT_ADMIN_SECRET env var — a human operator triggering manually.
  //  - the `xp-payout-gate` Vault secret, read via a service-role-only RPC —
  //    the pg_cron settlement job. Generated inside Postgres, never seen by a
  //    human, and shared by construction between the job and this check.
  const provided = req.headers.get('x-admin-secret')?.trim() ?? '';
  let authorized = false;
  if (provided) {
    const envSecret = Deno.env.get('XP_PAYOUT_ADMIN_SECRET')?.trim();
    if (envSecret) authorized = await secretsMatch(provided, envSecret);
    if (!authorized) {
      const { data: vaultSecret } = await supabase.rpc('xp_payout_gate_secret');
      if (typeof vaultSecret === 'string' && vaultSecret.trim()) {
        authorized = await secretsMatch(provided, vaultSecret.trim());
      }
    }
  }
  if (!authorized) {
    return jsonResponse(401, { error: 'Unauthorized.' }, cors);
  }

  const connection = new Connection(getSolanaRpcUrl(), 'confirmed');

  // Resolve the mint only for a legacy payout/probe. Native SOL payments and
  // reconciliation must not depend on the token mint, its RPC reads, or its key.
  let legacyMint: { mint: PublicKey; tokenProgramId: PublicKey } | undefined;
  const getLegacyMint = async () => {
    if (legacyMint) return legacyMint;
    const mint = new PublicKey(sakuraMint());
    const mintAcct = await connection.getAccountInfo(mint);
    if (!mintAcct) throw new Error('Could not read the SAKURA mint account.');
    const tokenProgramId = mintAcct.owner;
    if (!tokenProgramId.equals(TOKEN_PROGRAM_ID) && !tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error('Mint is not owned by a known token program.');
    }
    legacyMint = { mint, tokenProgramId };
    return legacyMint;
  };

  // Auth-gated treasury probe. Defaults to SOL and never claims a queue row.
  const reqBody = (await req.json().catch(() => ({}))) as { probe?: boolean; payout_asset?: string } | null;
  if (reqBody?.probe) {
    const asset = reqBody.payout_asset ?? 'SOL';
    if (asset !== 'SOL' && asset !== 'SAKURA') {
      return jsonResponse(400, { error: 'Unknown payout asset.' }, cors);
    }
    try {
      const authority = loadPayoutAuthority(asset);
      const sol = await connection.getBalance(authority.publicKey);
      const details: { payout_token_account?: string; sakura_balance?: string | null } = {};
      if (asset === 'SAKURA') {
        const { mint, tokenProgramId } = await getLegacyMint();
        const fromAta = ataFor(authority.publicKey, mint, tokenProgramId);
        details.payout_token_account = fromAta.toBase58();
        details.sakura_balance = await connection.getTokenAccountBalance(fromAta)
          .then((r) => r.value.uiAmountString ?? null)
          .catch(() => null);
      }
      return jsonResponse(200, {
        ok: true,
        probe: true,
        payout_asset: asset,
        authority: authority.publicKey.toBase58(),
        sol_balance: sol / 1e9,
        ...details,
      }, cors);
    } catch (err) {
      return jsonResponse(503, { error: err instanceof Error ? err.message : 'Unavailable.' }, cors);
    }
  }

  const results: { id: string; status: string; signature?: string; error?: string }[] = [];
  const now = () => new Date().toISOString();

  /**
   * Refund the XP and mark the row failed. Pre-broadcast (or confirmed
   * on-chain-failed) rows only.
   *
   * The database locks the matching status/signature and commits the failure
   * marker with its XP refund. Neither half can be lost to an interruption,
   * and overlapping runs or ambiguous-response retries can refund only once.
   */
  const refundAndFail = async (row: RedemptionRow, reason: string) => {
    const { data: refunded, error: rpcErr } = await supabase.rpc('fail_xp_redemption', {
      p_id: row.id,
      p_expected_signature: row.tx_signature ?? null,
      p_reason: reason.slice(0, 300),
    });
    if (rpcErr) {
      // Leave the transaction's outcome to the database. A lost response may
      // already have committed; a failed transaction leaves processing intact.
      results.push({ id: row.id, status: 'refund-pending', error: `${reason} (XP refund not confirmed: ${rpcErr.message})`.slice(0, 300) });
      return;
    }
    if (refunded !== true) {
      results.push({ id: row.id, status: 'refund-skipped', error: reason });
      return;
    }
    results.push({ id: row.id, status: 'failed', error: reason });
  };

  // ── Phase 0: reconcile rows a previous run left in flight ──────────────────
  // `processing` means a claim happened but the outcome was never recorded —
  // a crash, a confirm timeout, or an ambiguous send error. The chain, not the
  // database, knows what actually happened.
  const { data: inflight } = await supabase
    .from('xp_redemptions')
    .select('id, wallet_address, xp_spent, payout_asset, sol_lamports, sakura_amount, tx_signature, updated_at')
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
        if ((conf === 'confirmed' || conf === 'finalized') && st.value?.err) {
          // Landed and failed on-chain: no tokens moved, refunding is safe.
          await refundAndFail(row, `On-chain failure: ${JSON.stringify(st.value.err).slice(0, 120)}`);
          continue;
        }
        // Neither a missing history entry nor a merely processed transaction
        // proves non-delivery. Keep the recorded signature for reconciliation;
        // recycling it could pay a second time after an RPC lag/outage/fork.
        results.push({
          id: row.id,
          status: 'inflight',
          signature: row.tx_signature,
          error: 'Transaction outcome is not confirmed; awaiting reconciliation.',
        });
        continue;
      }
      // No signature was persisted, so this processor could not have sent a
      // transaction. The signature stamp is mandatory before every broadcast.
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

  // Insufficient treasury funding is an operational pause, not a failed reward.
  // No transaction has been signed or broadcast when this helper is called.
  async function deferUnfunded(row: RedemptionRow, reason: string) {
    const { data, error } = await supabase.from('xp_redemptions')
      .update({ status: 'pending', error: reason, updated_at: now() })
      .eq('id', row.id).eq('status', 'processing').is('tx_signature', null)
      .select('id');
    if (error) throw new Error('Could not pause the unfunded payout.');
    if (data?.length) results.push({ id: row.id, status: 'pending', error: reason });
  }

  // ── Phase 1: pay newly pending rows ─────────────────────────────────────────
  // Missing funding keys cannot prevent reconciliation or block the other
  // currency behind old queued rows. Configuration failures keep XP committed
  // and rows pending until the operator configures the matching treasury.
  const authorities: Partial<Record<PayoutAsset, Keypair>> = {};
  const assetErrors: Partial<Record<PayoutAsset, string>> = {};
  for (const asset of ['SOL', 'SAKURA'] as const) {
    try {
      authorities[asset] = loadPayoutAuthority(asset);
    } catch (err) {
      assetErrors[asset] = err instanceof Error ? err.message : 'Payout key unavailable.';
    }
  }
  const availableAssets = Object.keys(authorities) as PayoutAsset[];
  // Reserve part of the bounded batch for each configured currency. A backlog
  // whose mint or treasury is unavailable must not starve the other currency.
  const perAssetLimit = Math.floor(MAX_PER_RUN / Math.max(1, availableAssets.length));
  const batches = await Promise.all(availableAssets.map((asset) => supabase
    .from('xp_redemptions')
    .select('id, wallet_address, xp_spent, payout_asset, sol_lamports, sakura_amount, tx_signature')
    .eq('status', 'pending')
    .eq('payout_asset', asset)
    .order('created_at', { ascending: true })
    .limit(perAssetLimit)));
  if (batches.some((batch) => batch.error)) {
    return jsonResponse(500, { error: 'Could not read queued swaps.', results }, cors);
  }
  const pending = batches.flatMap((batch) => batch.data ?? []) as RedemptionRow[];

  for (const row of pending) {
    const authority = authorities[row.payout_asset];
    if (!authority || assetErrors[row.payout_asset]) continue;
    let tokenContext: { mint: PublicKey; tokenProgramId: PublicKey } | undefined;
    if (row.payout_asset === 'SAKURA') {
      try {
        tokenContext = await getLegacyMint();
      } catch (err) {
        assetErrors.SAKURA = err instanceof Error ? err.message : 'SAKURA mint unavailable.';
        continue;
      }
    }
    // Claim the row before touching funds. The status guard makes this a
    // compare-and-swap: of N concurrent invocations, exactly one proceeds.
    const { data: claimed } = await supabase
      .from('xp_redemptions')
      .update({ status: 'processing', updated_at: now() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id');
    if (!claimed?.length) continue;

    let broadcast = false;

    try {
      const recipient = new PublicKey(row.wallet_address);
      const tx = new Transaction();
      if (row.payout_asset === 'SOL') {
        if (!Number.isSafeInteger(row.sol_lamports) || row.sol_lamports! <= 0) {
          throw new Error('Invalid SOL payout amount.');
        }
        tx.add(SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: recipient,
          lamports: BigInt(row.sol_lamports!),
        }));
      } else {
        const { mint, tokenProgramId } = tokenContext!;
        const rawAmountNumber = Math.round(Number(row.sakura_amount) * 10 ** SAKURA_DECIMALS);
        if (!Number.isSafeInteger(rawAmountNumber) || rawAmountNumber <= 0) {
          throw new Error('Invalid SAKURA payout amount.');
        }
        const rawAmount = BigInt(rawAmountNumber);
        const fromAta = ataFor(authority.publicKey, mint, tokenProgramId);
        const fromBalance = await connection.getTokenAccountBalance(fromAta)
          .then((r) => BigInt(r.value.amount))
          .catch(() => null);
        if (fromBalance === null || fromBalance < rawAmount) {
          const reason = fromBalance === null
            ? 'Payout wallet holds no SAKURA account.' : 'Payout wallet balance too low.';
          await deferUnfunded(row, reason);
          assetErrors.SAKURA = reason;
          continue;
        }
        const toAta = ataFor(recipient, mint, tokenProgramId);
        // Idempotent creation handles concurrent payouts to a new recipient.
        const toInfo = await connection.getAccountInfo(toAta).catch(() => null);
        if (!toInfo) {
          tx.add(createAtaIdempotentIx(authority.publicKey, toAta, recipient, mint, tokenProgramId));
        }
        tx.add(transferCheckedIx(
          fromAta, mint, toAta, authority.publicKey, rawAmount, SAKURA_DECIMALS, tokenProgramId,
        ));
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = authority.publicKey;
      if (row.payout_asset === 'SOL') {
        const [balance, fee] = await Promise.all([
          connection.getBalance(authority.publicKey, 'confirmed'),
          connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
        ]);
        if (!Number.isSafeInteger(balance) || balance < 0 ||
            fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) {
          throw new Error('Could not estimate the SOL payout fee.');
        }
        if (BigInt(balance) < BigInt(row.sol_lamports!) + BigInt(fee.value)) {
          const reason = 'SOL payout wallet balance too low for the reward and transaction fee.';
          await deferUnfunded(row, reason);
          assetErrors.SOL = reason;
          continue;
        }
      }
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

      row.tx_signature = signature;

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
        .eq('status', 'processing')
        .eq('tx_signature', signature);
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
    { ok: true, processed: results.length, remaining_pending: remaining ?? 0, asset_errors: assetErrors, results },
    cors,
  );
});
