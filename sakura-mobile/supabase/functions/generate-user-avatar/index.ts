import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { buildAvatarMetadata } from '../_shared/avatar-metadata.ts';
import { generateFluxImage } from '../_shared/flux.ts';
import { mintAvatarNft } from '../_shared/mint-avatar-nft.ts';
import { buildAvatarPrompt, sanitizeUserHint } from '../_shared/mappa-style.ts';
import { buildTasteSnapshot } from '../_shared/taste-profile.ts';
import {
  AvatarPaymentError,
  avatarMintPriceSakura,
  verifyAvatarSakuraPayment,
} from '../_shared/verify-sakura-payment.ts';
import { corsHeaders, isWallet, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type GenerateBody = {
  action?:
    | 'generate'
    | 'status'
    | 'quote'
    | 'eligibility'
    | 'list'
    | 'select'
    | 'grant-status'
    | 'grant-detail'
    | 'grant-ack';
  mode?: 'tastes' | 'general';
  hint?: string;
  generation_id?: string;
  payment_tx_signature?: string;
  recipient_wallet?: string;
  admin_test_secret?: string;
  nft_name?: string;
  /** grant-status only. Unauthenticated, so this is the wallet being asked about. */
  wallet_address?: string;
  /** grant-ack only. */
  resolution?: 'selected' | 'dismissed';
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MintContext = {
  walletAddress: string;
  paymentBypass: boolean;
};

function resolveMintContext(req: Request, body: GenerateBody): MintContext {
  const configuredSecret = Deno.env.get('AVATAR_ADMIN_TEST_SECRET')?.trim();
  const providedSecret =
    body.admin_test_secret?.trim() || req.headers.get('x-avatar-admin-test')?.trim() || '';
  const recipient = body.recipient_wallet?.trim();

  if (configuredSecret && providedSecret === configuredSecret && recipient && isWallet(recipient)) {
    return { walletAddress: recipient, paymentBypass: true };
  }

  const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
  return { walletAddress, paymentBypass: false };
}

const cors = corsHeaders();
const RATE_LIMIT_HOURS = Number(Deno.env.get('AVATAR_RATE_LIMIT_HOURS') || '24');
const MODEL = Deno.env.get('FAL_FLUX_MODEL')?.trim() || Deno.env.get('BFL_FLUX_MODEL')?.trim() || 'fal-ai/flux/dev';

/**
 * How long a credit slot may sit in `processing` before it is treated as a dead
 * isolate and handed back. Every generation that has ever completed on this
 * project took 5.3-8.6 seconds end to end, so fifteen minutes cannot catch a
 * request that is merely slow. A slot that got as far as SUBMITTING a mint
 * transaction is never reclaimed by this at any age -- see mint_submitted_at.
 */
const GRANT_CREDIT_STALE_MINUTES = Number(Deno.env.get('AVATAR_CREDIT_STALE_MINUTES') || '15');

/**
 * Distinct looks for the granted avatars, indexed by credit slot. The same
 * prompt run four times comes out near-identical, and "here are your four
 * avatars" landing as four copies of one face is its own small insult. Chosen
 * SERVER-side so the four differ even from a client that sends no hint -- and
 * server-chosen text only: nft_name stays gated on paymentBypass, because a
 * signed caller must never get to inscribe arbitrary words into an NFT we mint
 * and pay the SOL for.
 */
const GRANT_SLOT_HINTS = [
  'moonlit rooftop, cool silver tones, calm',
  'cool blue night city, quiet confidence',
  'warm sunset gold, gentle smile',
  'deep violet starfield, sharp gaze',
  'soft dawn pink, hopeful',
  'emerald forest dusk, watchful',
];

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function avatarNftName(mode: string): string {
  return mode === 'tastes' ? 'Sakura Taste Avatar' : 'Sakura Anime Avatar';
}

async function listReadyMints(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  activeGenerationId?: string | null,
) {
  const { data, error } = await supabase
    .from('user_avatar_generations')
    .select('id, mint_address, public_url, mode, created_at')
    .eq('wallet_address', walletAddress)
    .eq('status', 'ready')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    mint_address: row.mint_address ?? null,
    public_url: row.public_url ?? null,
    mode: row.mode as string,
    created_at: row.created_at as string,
    is_active: Boolean(activeGenerationId && row.id === activeGenerationId),
  }));
}

async function buildEligibility(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  mintPrice: number,
) {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('avatar_mint_address, avatar_url, avatar_generation_id')
    .eq('wallet_address', walletAddress)
    .maybeSingle();

  // `.gt('payment_amount_sakura', 0)` restricts the 24h clock to mints that took
  // money. Without it a wallet that forges four free apology avatars is locked
  // out of BUYING a fifth for a day -- and since the client pays before it calls
  // generate, that 429 would arrive with the SAKURA already gone. Free rows
  // cannot be farmed to dodge the limit: a zero-amount row can only come from
  // the admin bypass or from a credit slot capped by avatar_count on a
  // service-role-only grant row this function never writes to.
  const { data: recent } = await supabase
    .from('user_avatar_generations')
    .select('created_at, status')
    .eq('wallet_address', walletAddress)
    .in('status', ['queued', 'processing', 'ready'])
    .gt('payment_amount_sakura', 0)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let retryAfterHours = 0;
  if (recent?.created_at) {
    const elapsed = hoursSince(recent.created_at);
    if (elapsed < RATE_LIMIT_HOURS) {
      retryAfterHours = Math.max(1, Math.ceil(RATE_LIMIT_HOURS - elapsed));
    }
  }

  // ADVISORY, and fail-closed on purpose. `eligibility` and `list` are the same
  // payload, and `list` runs immediately after a PAID mint succeeds. If a broken
  // grants read threw here, that refresh would throw, the client would report a
  // successful forge as a failure, and the user would pay a second time. Failing
  // to 0 free credits is exactly v18 behaviour: he is asked to pay, which is
  // what he already expects.
  let freeCredits = 0;
  try {
    const creditState = await loadGrantCreditState(supabase, walletAddress);
    freeCredits = creditState?.remaining ?? 0;
  } catch (creditError) {
    console.error(
      '[avatar] credit lookup failed in eligibility (treating as 0 free):',
      creditError instanceof Error ? creditError.message : creditError,
    );
  }

  const mints = await listReadyMints(supabase, walletAddress, profile?.avatar_generation_id ?? null);

  return {
    price_sakura: mintPrice,
    currency: 'SAKURA',
    rate_limit_hours: RATE_LIMIT_HOURS,
    // A wallet we owe free avatars can always forge: a credit is exempt from the
    // 24h limit server-side. The client MUST read free_credits and skip
    // sendSakura, or it charges 100,000 SAKURA for an avatar we are giving away.
    can_mint: retryAfterHours === 0 || freeCredits > 0,
    free_credits: freeCredits,
    already_minted: mints.length > 0,
    mint_count: mints.length,
    active_generation_id: profile?.avatar_generation_id ?? null,
    mint_address: profile?.avatar_mint_address ?? null,
    avatar_url: profile?.avatar_url ?? null,
    retry_after_hours: retryAfterHours,
    mints,
  };
}

/**
 * Persist the fact that a request carrying a REAL, attributable payment was
 * turned away.
 *
 * Both historic loss paths -- the 429 rate limit and the 402 verification
 * failure -- returned before the generation row was inserted, so a user whose
 * SAKURA had already left their wallet left zero trace in Postgres. Four wallets
 * lost 400,000 SAKURA that way and nobody knew for seven weeks.
 *
 * Two rules make this safe to write from an endpoint any keypair can reach:
 *
 *   1. It goes in avatar_payment_rejections, NOT user_avatar_generations. That
 *      table has a partial UNIQUE on payment_tx_signature, so an audit row there
 *      would occupy the signature's only slot and permanently brick the real
 *      payer with "Payment transaction already claimed."
 *   2. It is only ever called after the transaction has been read from chain and
 *      its fee payer proven equal to the authenticated caller (see
 *      AvatarPaymentError.attributable). A caller cannot manufacture a record
 *      about a signature that is not theirs, or about one that does not exist.
 *
 * Never throws: an audit failure must not change what the user is told.
 */
async function recordPaymentRejection(
  supabase: ReturnType<typeof createClient>,
  input: {
    walletAddress: string;
    paymentTxSignature: string;
    creditedSakura: number | null;
    expectedSakura: number;
    stage: 'rate_limited' | 'payment_verification';
    reason: string;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('avatar_payment_rejections').upsert(
      {
        wallet_address: input.walletAddress,
        payment_tx_signature: input.paymentTxSignature,
        credited_sakura: input.creditedSakura,
        expected_sakura: input.expectedSakura,
        stage: input.stage,
        reason: input.reason,
      },
      { onConflict: 'wallet_address,payment_tx_signature,stage' },
    );
    if (error) throw new Error(error.message);

    // Loud enough to alert on from the function logs, in addition to the row.
    console.error(
      `[avatar] CHARGED BUT REFUSED wallet=${input.walletAddress} sig=${input.paymentTxSignature} ` +
        `credited=${input.creditedSakura ?? 'unknown'} stage=${input.stage} reason=${input.reason}`,
    );
  } catch (auditError) {
    console.error(
      '[avatar] failed to record payment rejection:',
      auditError instanceof Error ? auditError.message : auditError,
    );
  }
}

// === apology grants =========================================================

/**
 * Latch the grant. `.is('resolved_at', null)` keeps the FIRST decision
 * authoritative, so double-taps, retries and races cannot rewrite history.
 * Returns true when this call is the one that latched it (or it was already
 * latched), false when the write genuinely failed.
 */
async function markApologyGrantResolved(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  resolution: 'selected' | 'dismissed',
  selectedGenerationId: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('avatar_apology_grants')
    .update({
      resolved_at: now,
      resolution,
      selected_generation_id: selectedGenerationId,
      updated_at: now,
    })
    .eq('wallet_address', walletAddress)
    .is('resolved_at', null);

  if (error) {
    console.error('[avatar] apology grant latch failed:', error.message);
    return false;
  }
  return true;
}

/**
 * Latch only when the chosen generation is one the grant actually handed out AND
 * the apology has already been shown.
 *
 * The shown_at gate is load-bearing. `select` is also the ordinary profile
 * picker, and the granted avatars appear there the instant they are minted
 * (listReadyMints filters on nothing but wallet + status='ready'). Without the
 * gate, a user who picked one of them before the apology card ever rendered --
 * because the app-open check timed out, say -- would have his grant marked
 * "decided" and would never be told he was wronged or made whole. The DB carries
 * the same rule as a CHECK constraint.
 */
async function resolveApologyGrantIfShown(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  generationId: string,
) {
  try {
    const { data: grant } = await supabase
      .from('avatar_apology_grants')
      .select(
        'avatar_count, credit_series, credits_locked, generation_ids, shown_at, resolved_at',
      )
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    if (!grant || grant.resolved_at || !grant.shown_at) return;

    // Derived from the slot prefix, not read out of generation_ids: mints land
    // one at a time now and a lost audit append must not stop a genuine pick
    // from latching.
    const state = await loadGrantCreditState(supabase, walletAddress, grant);
    if (!state || !grantedGenerationIds(state).includes(generationId)) return;

    // NEVER latch while avatars are still owed. `select` is also the ordinary
    // profile picker: without this, a user who forged two of four, closed the
    // card and later picked one from his profile would silently retire the
    // apology with half the make-good unclaimed and no surface left that
    // explains it. Only an explicit "no thanks" (grant-ack, resolution
    // 'dismissed') may close a grant that still owes something.
    if (state.remaining > 0 || state.reviewSlots.length > 0) return;

    await markApologyGrantResolved(supabase, walletAddress, 'selected', generationId);
  } catch (grantError) {
    // Never break the pick over bookkeeping.
    console.error(
      '[avatar] apology grant resolve failed:',
      grantError instanceof Error ? grantError.message : grantError,
    );
  }
}

// === apology credits ========================================================

/**
 * Every credit slot a wallet's grant can ever occupy shares this prefix:
 *
 *   apology:<wallet>:<credit_series>:<slot 1..avatar_count>
 *
 * The colons are the point. Base58 cannot produce a ':', so a credit slot can
 * never collide with, be mistaken for, or squat the UNIQUE slot of a real Solana
 * signature -- the exact attack the avatar_payment_rejections comment above
 * documents. It also makes the ledger self-describing: `payment_tx_signature
 * LIKE 'apology:%'` is the precise credit-mint filter.
 *
 * The wallet comes from verifyWalletHeaders, never from the body, so wallet B
 * cannot address wallet A's slot. The series comes from avatar_apology_grants,
 * which is service-role only and which this function never inserts into, so
 * nobody can issue himself a credit. Bumping credit_series is how an operator
 * re-grants a wallet that has already spent its slots -- the row is PK'd on
 * wallet_address, so a re-grant reuses it and the old slots would otherwise make
 * the new grant instantly empty.
 *
 * Contrast the bypass path's `dev-bypass-${crypto.randomUUID()}`: unique by
 * construction, so the UNIQUE index never fires and re-running a script mints
 * duplicates. That is exactly the spare row sitting under J4oXm today. Credits
 * are deterministic precisely so that cannot happen.
 */
function grantCreditPrefix(walletAddress: string, series: number): string {
  return `apology:${walletAddress}:${series}:`;
}

type GrantSlotRow = {
  id: string;
  slot: number;
  status: string;
  createdAt: string;
  mintSubmittedAt: string | null;
};

type GrantCreditState = {
  avatarCount: number;
  series: number;
  locked: boolean;
  prefix: string;
  recordedIds: string[];
  slots: GrantSlotRow[];
  /** Slot numbers with no row at all. */
  openSlots: number[];
  /** Failed BEFORE any mint went out. Reclaimable in place by the retry claim. */
  failedSlots: GrantSlotRow[];
  /** Dead isolates: still processing, old, and provably never submitted a mint. */
  staleSlots: GrantSlotRow[];
  /**
   * Slots whose mint transaction WAS submitted but never confirmed back to us.
   * Never reclaimed and never counted as spendable: the NFT may already be in
   * the user's wallet, and re-forging would mint a second one and spend a second
   * lot of SOL for a single credit.
   */
  reviewSlots: GrantSlotRow[];
  mintedIds: string[];
  /** Unspent slots ignoring credits_locked. */
  unspent: number;
  /** Free avatars this wallet may forge right now. */
  remaining: number;
};

/**
 * Everything the credit scheme knows about one wallet, from two reads. Pass
 * `grantRow` when the caller already fetched the grant so it is not read twice.
 */
async function loadGrantCreditState(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  // deno-lint-ignore no-explicit-any
  grantRow?: any,
): Promise<GrantCreditState | null> {
  let grant = grantRow;
  if (grant === undefined) {
    const { data, error } = await supabase
      .from('avatar_apology_grants')
      .select(
        'avatar_count, credit_series, credits_locked, generation_ids, shown_at, resolved_at',
      )
      .eq('wallet_address', walletAddress)
      .maybeSingle();
    if (error) throw new Error(error.message);
    grant = data;
  }
  if (!grant) return null;

  const avatarCount = Math.max(0, Math.trunc(Number(grant.avatar_count ?? 0)));
  const series = Math.max(1, Math.trunc(Number(grant.credit_series ?? 1)));
  const prefix = grantCreditPrefix(walletAddress, series);

  // Scoped to the wallet AND the prefix. A base58 address contains no '%' or
  // '_', so the LIKE pattern needs no escaping.
  const { data: rows, error: slotError } = await supabase
    .from('user_avatar_generations')
    .select('id, status, created_at, mint_submitted_at, payment_tx_signature')
    .eq('wallet_address', walletAddress)
    .like('payment_tx_signature', `${prefix}%`);
  if (slotError) throw new Error(slotError.message);

  const slots: GrantSlotRow[] = [];
  for (const row of rows ?? []) {
    const slot = Number(String(row.payment_tx_signature).slice(prefix.length));
    if (!Number.isInteger(slot) || slot < 1 || slot > avatarCount) continue;
    slots.push({
      id: String(row.id),
      slot,
      status: String(row.status),
      createdAt: String(row.created_at),
      mintSubmittedAt: (row.mint_submitted_at as string | null) ?? null,
    });
  }
  slots.sort((a, b) => a.slot - b.slot);

  const taken = new Set(slots.map((s) => s.slot));
  const openSlots: number[] = [];
  for (let slot = 1; slot <= avatarCount; slot += 1) {
    if (!taken.has(slot)) openSlots.push(slot);
  }

  const staleCutoff = Date.now() - GRANT_CREDIT_STALE_MINUTES * 60_000;
  const failedSlots = slots.filter((s) => s.status === 'failed' && !s.mintSubmittedAt);
  const reviewSlots = slots.filter((s) => s.status !== 'ready' && Boolean(s.mintSubmittedAt));
  const staleSlots = slots.filter(
    (s) =>
      (s.status === 'processing' || s.status === 'queued') &&
      !s.mintSubmittedAt &&
      new Date(s.createdAt).getTime() < staleCutoff,
  );

  const locked = Boolean(grant.credits_locked);
  const unspent = openSlots.length + failedSlots.length + staleSlots.length;

  return {
    avatarCount,
    series,
    locked,
    prefix,
    recordedIds: ((grant.generation_ids ?? []) as string[]).filter(Boolean),
    slots,
    openSlots,
    failedSlots,
    staleSlots,
    reviewSlots,
    mintedIds: slots.filter((s) => s.status === 'ready').map((s) => s.id),
    unspent,
    remaining: locked ? 0 : unspent,
  };
}

/**
 * Hand a dead isolate's slot back, atomically.
 *
 * The guarded UPDATE is the serialization point: `status in (processing,queued)`
 * AND `mint_submitted_at is null` AND the age cutoff together mean exactly one
 * caller can flip it, a request that is genuinely still running cannot have its
 * row pulled out from under it, and a request that already broadcast a mint is
 * untouchable at any age.
 */
async function reclaimStaleCreditSlot(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  row: GrantSlotRow,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - GRANT_CREDIT_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from('user_avatar_generations')
    .update({
      status: 'failed',
      error_message:
        `Abandoned: no result after ${GRANT_CREDIT_STALE_MINUTES} minutes and no mint was ever submitted.`,
      completed_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('wallet_address', walletAddress)
    .in('status', ['processing', 'queued'])
    .is('mint_submitted_at', null)
    .lt('created_at', cutoff)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[avatar] stale credit reclaim failed:', error.message);
    return false;
  }
  return Boolean(data);
}

type GrantCredit = {
  /** The deterministic slot signature. This IS the lock. */
  signature: string;
  slot: number;
  /** Set when the slot already owns a FAILED row the retry claim must reuse. */
  failedGenerationId: string | null;
  /** True when this slot already failed once, so the prompt is de-risked. */
  isRetry: boolean;
  /** Credits still unspent after this one. */
  remaining: number;
  /** Slots whose mint went out but never confirmed. Owed, not spendable. */
  inReview: number;
};

/**
 * Which free avatar, if any, this wallet may forge right now.
 *
 * The allocation is ADVISORY. The authority on "was this credit already spent"
 * is the partial UNIQUE index user_avatar_generations_payment_tx_unique, which
 * picks the winner at the INSERT below -- before generateFluxImage and before
 * mintAvatarNft, so the loser of a race has spent nothing at all.
 *
 * The count comes from the slot signatures and NEVER from
 * payment_amount_sakura = 0: J4oXm already carries a dev-bypass row with
 * payment_amount_sakura = 0 from 2026-06-14, and counting it would silently dock
 * him one of the four avatars he is owed.
 *
 * OPEN SLOTS ARE SERVED FIRST. Serving a failed slot ahead of an untouched one
 * is how a single poisoned prompt strands every remaining credit: the same slot
 * would come back forever and slots 3 and 4 would never be reachable. Row count
 * is capped by avatar_count either way, so this cannot over-issue.
 *
 * Deliberately does NOT check resolved_at. Resolution means the apology CARD was
 * decided; the avatars are owed either way, and a mis-tapped "no thanks" must not
 * destroy four avatars. They stay claimable from the ordinary forge path via
 * buildEligibility.free_credits. credits_locked is the operator's off switch.
 */
async function claimGrantCreditSlot(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
): Promise<GrantCredit | null> {
  const state = await loadGrantCreditState(supabase, walletAddress);
  if (!state || state.locked || state.remaining < 1) return null;

  const inReview = state.reviewSlots.length;

  const open = state.openSlots[0];
  if (open !== undefined) {
    return {
      signature: `${state.prefix}${open}`,
      slot: open,
      failedGenerationId: null,
      isRetry: false,
      remaining: state.remaining - 1,
      inReview,
    };
  }

  // A failed slot is NOT a spent credit: one Flux refusal must not burn an
  // avatar we owe. It is handed back so the existing atomic
  // failed -> processing claim reuses the row instead of inserting a second.
  const failed = state.failedSlots[0];
  if (failed) {
    return {
      signature: `${state.prefix}${failed.slot}`,
      slot: failed.slot,
      failedGenerationId: failed.id,
      isRetry: true,
      remaining: state.remaining - 1,
      inReview,
    };
  }

  const stale = state.staleSlots[0];
  if (stale && (await reclaimStaleCreditSlot(supabase, walletAddress, stale))) {
    return {
      signature: `${state.prefix}${stale.slot}`,
      slot: stale.slot,
      failedGenerationId: stale.id,
      isRetry: true,
      remaining: state.remaining - 1,
      inReview,
    };
  }

  return null;
}

/**
 * The granted generation ids, DERIVED from the slot signatures rather than read
 * out of avatar_apology_grants.generation_ids.
 *
 * Under batch pre-minting that column was filled in a single write. The mints
 * now arrive one at a time, and a lost append would silently hide an avatar the
 * user owns -- and stop a genuine pick from latching. The slot prefix is the
 * same column the UNIQUE index arbitrates, so it cannot disagree with what was
 * actually minted. The recorded column is unioned in so any batch-issued grant
 * keeps working, and remains useful as audit.
 */
function grantedGenerationIds(state: GrantCreditState): string[] {
  return [...new Set([...state.recordedIds, ...state.mintedIds])];
}

/** The granted avatars that have actually landed, oldest first. */
async function loadGrantedAvatars(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  ids: string[],
  activeGenerationId: string | null,
) {
  if (!ids.length) return [];
  const { data: rows, error } = await supabase
    .from('user_avatar_generations')
    .select('id, mint_address, public_url, mode, created_at')
    .in('id', ids)
    .eq('wallet_address', walletAddress)
    .eq('status', 'ready')
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);

  return (rows ?? []).map((row) => ({
    id: row.id as string,
    mint_address: row.mint_address ?? null,
    public_url: (row.public_url as string | null) ?? null,
    mode: row.mode as string,
    created_at: row.created_at as string,
    is_active: Boolean(activeGenerationId && row.id === activeGenerationId),
  }));
}

/**
 * UNAUTHENTICATED app-open check. Same shape as read-gamification, so launching
 * the app cannot raise a biometric/unlock prompt for the ~all users who have no
 * grant.
 *
 * Deliberately returns NO generation ids and performs NO writes. user_profiles
 * is world-writable by anon ("Public Access Profiles" FOR ALL TO public USING
 * true WITH CHECK true, plus stock anon DML grants), so an endpoint that handed
 * out the granted ids and then latched the grant on seeing one of them in
 * user_profiles.avatar_generation_id would let anyone holding the shipped anon
 * key burn the apology before he ever saw it. Image URLs are safe: public
 * storage objects, already world-readable.
 */
async function buildApologyGrantStatus(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
) {
  const { data: grant, error } = await supabase
    .from('avatar_apology_grants')
    .select(
      'incident, avatar_count, charged_sakura, refund_sakura, received_count, generation_ids, credit_series, credits_locked, granted_at, shown_at, resolved_at',
    )
    .eq('wallet_address', walletAddress)
    .maybeSingle();

  // A failed read must not be indistinguishable from "no grant" -- that is how a
  // missing migration would silently ship as a no-op feature.
  if (error) throw new Error(error.message);

  if (!grant) {
    return { has_grant: false, resolved: true, ready: false };
  }
  if (grant.resolved_at) {
    return { has_grant: true, resolved: true, ready: false };
  }

  const state = await loadGrantCreditState(supabase, walletAddress, grant);
  const ids = state ? grantedGenerationIds(state) : [];
  const avatars = await loadGrantedAvatars(supabase, walletAddress, ids, null);
  const expected = Number(grant.avatar_count ?? ids.length);
  const creditsRemaining = state?.remaining ?? 0;
  const creditsInReview = state?.reviewSlots.length ?? 0;
  const creditsPaused = state?.locked ? state.unspent : 0;

  return {
    has_grant: true,
    resolved: false,
    // `ready` now means THERE IS SOMETHING TO SHOW HIM, not "every promised
    // avatar has landed". Nothing is minted when the card must first appear
    // under the credit model, so the old test was false forever and the apology
    // would never have rendered at all.
    ready: avatars.length > 0 || creditsRemaining > 0 || creditsPaused > 0 || creditsInReview > 0,
    incident: (grant.incident as string) ?? 'charged_without_delivery',
    avatar_count: expected,
    minted_count: avatars.length,
    /** Free avatars he may forge right now. */
    credits_remaining: creditsRemaining,
    /** Mint went out, confirmation did not come back. Owed, not re-forgeable. */
    credits_in_review: creditsInReview,
    /** Unspent but switched off by the operator. Say so; do not vanish. */
    credits_paused: creditsPaused,
    charged_sakura: Number(grant.charged_sakura ?? 0),
    refund_sakura: Number(grant.refund_sakura ?? 0),
    received_count: Number(grant.received_count ?? 0),
    granted_at: (grant.granted_at as string) ?? null,
    already_shown: Boolean(grant.shown_at),
    // Public image URLs only. No ids.
    preview_urls: avatars.map((a) => a.public_url).filter(Boolean),
  };
}

/**
 * SIGNED detail fetch. Returns the granted avatars with their ids so the user can
 * pick one, and stamps shown_at -- this is the moment he is actually shown the
 * apology, and the only thing that unlocks resolution.
 */
async function buildApologyGrantDetail(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
) {
  const { data: grant, error } = await supabase
    .from('avatar_apology_grants')
    .select(
      'incident, avatar_count, charged_sakura, refund_sakura, received_count, generation_ids, credit_series, credits_locked, granted_at, shown_at, resolved_at',
    )
    .eq('wallet_address', walletAddress)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!grant) return { has_grant: false, resolved: true, ready: false, avatars: [] };
  if (grant.resolved_at) return { has_grant: true, resolved: true, ready: false, avatars: [] };

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('avatar_generation_id')
    .eq('wallet_address', walletAddress)
    .maybeSingle();
  const activeId = (profile?.avatar_generation_id as string | null) ?? null;

  const state = await loadGrantCreditState(supabase, walletAddress, grant);
  const ids = state ? grantedGenerationIds(state) : [];
  const avatars = await loadGrantedAvatars(supabase, walletAddress, ids, activeId);
  const expected = Number(grant.avatar_count ?? ids.length);
  const creditsRemaining = state?.remaining ?? 0;
  const creditsInReview = state?.reviewSlots.length ?? 0;
  const creditsPaused = state?.locked ? state.unspent : 0;

  if (!avatars.length && creditsRemaining <= 0 && creditsPaused <= 0 && creditsInReview <= 0) {
    // Nothing minted and nothing left to mint. Do not stamp shown_at for a card
    // we are not going to show. (This used to require EVERY promised avatar to
    // have landed, which under the credit model is never true at card time --
    // so shown_at was never stamped, and "no thanks" could never stick.)
    return {
      has_grant: true,
      resolved: false,
      ready: false,
      minted_count: 0,
      credits_remaining: 0,
      credits_in_review: 0,
      credits_paused: 0,
      avatar_count: expected,
      avatars: [],
    };
  }

  // Self-heal, on the SIGNED path only. If he is already wearing one of the
  // granted avatars and the grant was shown, he picked and the ack never landed
  // (app killed, offline, crash) -- latch it so the apology cannot reappear.
  // Gated on nothing being owed: latching while credits remain would quietly
  // retire the offer of the avatars he has not claimed yet.
  if (grant.shown_at && activeId && creditsRemaining <= 0 && creditsInReview <= 0 && ids.includes(activeId)) {
    await markApologyGrantResolved(supabase, walletAddress, 'selected', activeId);
    return { has_grant: true, resolved: true, ready: false, avatars: [] };
  }

  if (!grant.shown_at) {
    const now = new Date().toISOString();
    const { error: stampError } = await supabase
      .from('avatar_apology_grants')
      .update({ shown_at: now, updated_at: now })
      .eq('wallet_address', walletAddress)
      .is('shown_at', null);
    if (stampError) throw new Error(stampError.message);
  }

  return {
    has_grant: true,
    resolved: false,
    ready: true,
    incident: (grant.incident as string) ?? 'charged_without_delivery',
    avatar_count: expected,
    minted_count: avatars.length,
    credits_remaining: creditsRemaining,
    credits_in_review: creditsInReview,
    credits_paused: creditsPaused,
    charged_sakura: Number(grant.charged_sakura ?? 0),
    refund_sakura: Number(grant.refund_sakura ?? 0),
    received_count: Number(grant.received_count ?? 0),
    granted_at: (grant.granted_at as string) ?? null,
    already_shown: true,
    // Returned here too. The client merges this payload over the status it is
    // already holding, and a missing key would blank the thumbnails he can
    // currently see -- on the one card that must never claim more than it shows.
    preview_urls: avatars.map((a) => a.public_url).filter(Boolean),
    avatars,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const body = (await req.json()) as GenerateBody;
    const action = body.action ?? 'generate';
    const mintPrice = avatarMintPriceSakura();

    if (action === 'quote') {
      return jsonResponse(200, {
        price_sakura: mintPrice,
        currency: 'SAKURA',
        rate_limit_hours: RATE_LIMIT_HOURS,
      }, cors);
    }

    if (action === 'grant-status') {
      const wallet = String(body.wallet_address ?? '').trim();
      if (!isWallet(wallet)) {
        return jsonResponse(400, { error: 'Valid wallet_address required.' }, cors);
      }
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      return jsonResponse(200, await buildApologyGrantStatus(supabase, wallet), cors);
    }

    if (action === 'grant-detail') {
      const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      return jsonResponse(200, await buildApologyGrantDetail(supabase, walletAddress), cors);
    }

    if (action === 'grant-ack') {
      // Signed: only the owner may burn their own apology prompt.
      const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');

      if (body.resolution !== 'selected' && body.resolution !== 'dismissed') {
        return jsonResponse(400, { error: "resolution must be 'selected' or 'dismissed'." }, cors);
      }
      const resolution = body.resolution;
      const generationId = body.generation_id?.trim() || null;

      if (resolution === 'dismissed' && generationId) {
        return jsonResponse(400, { error: 'generation_id is not allowed when dismissing.' }, cors);
      }
      if (generationId && !UUID_RE.test(generationId)) {
        return jsonResponse(400, { error: 'generation_id must be a uuid.' }, cors);
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );

      const { data: grant, error: grantError } = await supabase
        .from('avatar_apology_grants')
        .select('generation_ids, shown_at, resolved_at')
        .eq('wallet_address', walletAddress)
        .maybeSingle();

      if (grantError) return jsonResponse(500, { error: grantError.message }, cors);
      // No grant, or already decided: nothing left to show. Idempotent, not an error.
      if (!grant || grant.resolved_at) return jsonResponse(200, { resolved: true }, cors);

      // Cannot resolve something that was never shown. The DB enforces this too.
      if (!grant.shown_at) {
        return jsonResponse(409, { error: 'Apology has not been shown yet.', resolved: false }, cors);
      }

      const state = await loadGrantCreditState(supabase, walletAddress);
      const ids = state ? grantedGenerationIds(state) : ((grant.generation_ids ?? []) as string[]);
      if (generationId && !ids.includes(generationId)) {
        return jsonResponse(400, { error: 'generation_id is not part of this grant.' }, cors);
      }

      // A pick cannot close a grant that still owes avatars -- he chose a
      // profile picture, he did not waive the rest. Only an explicit dismissal
      // may do that, and it deliberately does NOT forfeit the credits: they stay
      // claimable from the ordinary forge path.
      const owed = (state?.remaining ?? 0) + (state?.reviewSlots.length ?? 0);
      if (resolution === 'selected' && owed > 0) {
        return jsonResponse(200, {
          resolved: false,
          credits_remaining: state?.remaining ?? 0,
          credits_in_review: state?.reviewSlots.length ?? 0,
        }, cors);
      }

      const ok = await markApologyGrantResolved(supabase, walletAddress, resolution, generationId);
      if (!ok) return jsonResponse(500, { error: 'Could not save that. Try again.' }, cors);

      return jsonResponse(200, { resolved: true, resolution }, cors);
    }

    if (action === 'eligibility' || action === 'list') {
      const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const payload = await buildEligibility(supabase, walletAddress, mintPrice);
      return jsonResponse(200, payload, cors);
    }

    if (action === 'select') {
      const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
      const generationId = body.generation_id?.trim();
      if (!generationId) return jsonResponse(400, { error: 'generation_id is required.' }, cors);

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );

      const { data: generation, error } = await supabase
        .from('user_avatar_generations')
        .select('id, wallet_address, public_url, mint_address, status')
        .eq('id', generationId)
        .eq('wallet_address', walletAddress)
        .maybeSingle();

      if (error) return jsonResponse(500, { error: error.message }, cors);
      if (!generation || generation.status !== 'ready') {
        return jsonResponse(404, { error: 'Avatar mint not found.' }, cors);
      }

      const now = new Date().toISOString();
      await supabase.from('user_profiles').upsert(
        {
          wallet_address: walletAddress,
          avatar_url: generation.public_url,
          avatar_mint_address: generation.mint_address,
          avatar_generation_id: generation.id,
          avatar_seed: walletAddress.slice(0, 8),
          updated_at: now,
        },
        { onConflict: 'wallet_address' },
      );

      // Picking one of the GRANTED avatars IS the resolution. Doing it here as
      // well as in grant-ack means the apology cannot survive a successful pick,
      // even if the client dies before it can ack. Gated on shown_at so an
      // ordinary profile-picker use can never burn an apology he has not seen.
      await resolveApologyGrantIfShown(supabase, walletAddress, generation.id as string);

      return jsonResponse(200, {
        generation_id: generation.id,
        mint_address: generation.mint_address,
        public_url: generation.public_url,
      }, cors);
    }

    const { walletAddress, paymentBypass } = resolveMintContext(req, body);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (action === 'status') {
      const generationId = body.generation_id?.trim();
      if (!generationId) return jsonResponse(400, { error: 'generation_id is required.' }, cors);

      const { data, error } = await supabase
        .from('user_avatar_generations')
        .select(
          'id, status, public_url, metadata_uri, mint_address, mint_tx_signature, payment_tx_signature, payment_amount_sakura, error_message, taste_snapshot, mode, created_at, completed_at',
        )
        .eq('id', generationId)
        .eq('wallet_address', walletAddress)
        .maybeSingle();

      if (error) return jsonResponse(500, { error: error.message }, cors);
      if (!data) return jsonResponse(404, { error: 'Generation not found.' }, cors);

      return jsonResponse(200, data, cors);
    }

    let paymentTxSignature = body.payment_tx_signature?.trim();
    let chargedSakura = mintPrice;
    let grantCredit: GrantCredit | null = null;

    // A body-supplied signature is always an on-chain one. Credit slots are
    // server-derived and contain ':', which base58 cannot produce, so this shape
    // check is what stops a caller aiming the paid path at a credit slot.
    if (paymentTxSignature && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(paymentTxSignature)) {
      return jsonResponse(400, { error: 'Invalid payment signature.' }, cors);
    }

    if (paymentBypass) {
      paymentTxSignature = `dev-bypass-${crypto.randomUUID()}`;
      chargedSakura = 0;
    } else if (!paymentTxSignature) {
      // No payment -- and none is required if this wallet is owed free avatars.
      //
      // walletAddress came from verifyWalletHeaders, so nobody can spend another
      // wallet's credit. avatar_apology_grants is service-role only and this
      // function contains no INSERT or UPSERT into it anywhere, so nobody can
      // grant himself one. Both properties are load-bearing; do not add a write
      // path to that table from any user-reachable action.
      grantCredit = await claimGrantCreditSlot(supabase, walletAddress);
      if (!grantCredit) {
        // The 400 below is a demand for 100,000 SAKURA, and the apology card
        // renders whatever comes back verbatim. A wallet that HAS a grant must
        // never read it -- these four have been sent a bill for a free avatar
        // once already.
        const state = await loadGrantCreditState(supabase, walletAddress);
        if (state) {
          return jsonResponse(409, {
            error: state.locked
              ? 'Your free avatars are paused for a moment. Nothing was charged.'
              : state.reviewSlots.length > 0
              ? 'One of your free avatars is still being confirmed. Nothing was charged.'
              : 'You have forged all your free avatars.',
            code: 'no_credits_left',
            credits_remaining: 0,
            credits_in_review: state.reviewSlots.length,
          }, cors);
        }
        return jsonResponse(400, {
          error: `A confirmed SAKURA payment of ${mintPrice.toLocaleString()} is required.`,
          price_sakura: mintPrice,
        }, cors);
      }
      paymentTxSignature = grantCredit.signature;
      chargedSakura = 0;
    }

    // A slot that already failed once is retried with the most neutral prompt we
    // have: 'general' drops the taste snapshot, which interpolates the user's
    // own favourite titles into the prompt and is the likeliest thing to have
    // tripped an image filter. Re-running the identical prompt would fail
    // identically and burn the retry.
    const mode = grantCredit?.isRetry
      ? 'general'
      : body.mode === 'general'
      ? 'general'
      : 'tastes';

    // ORDER OF OPERATIONS, and why it changed.
    //
    //   1. payment lookup   2. payment verification   3. rate limit
    //
    // It used to be 3, 1, 2. Two things were wrong with that:
    //
    //   * A wallet resuming an already-paid mint got a 429 instead of its
    //     avatar. The client's "Resume avatar forge" path was therefore
    //     unreachable for 24h after the payment it was trying to resume -- and
    //     the copy it showed was "No SKR was charged", about a charge that had
    //     very much happened.
    //   * The 429 fired before we had read the chain, so a rate-limit refusal
    //     could not be recorded against a verified payment. Now verification
    //     runs first, which means every 429 we record is provably a real
    //     transfer from the caller. That is what makes the audit trustworthy
    //     rather than a wall of forgeable claims.
    //
    // A retry that already owns a row updates that row in place and can never
    // yield a second avatar, so it is exempt from the limit entirely.
    // deno-lint-ignore no-explicit-any
    let usedPayment: any = null;
    if (!paymentBypass) {
      const { data } = await supabase
        .from('user_avatar_generations')
        .select('id, wallet_address, status, public_url, metadata_uri, mint_address, mint_tx_signature, payment_tx_signature, payment_amount_sakura, taste_snapshot, mode')
        .eq('payment_tx_signature', paymentTxSignature)
        .maybeSingle();
      usedPayment = data;
    }

    let retryGenerationId: string | null = null;
    if (usedPayment) {
      if (usedPayment.wallet_address === walletAddress && usedPayment.status === 'ready') {
        return jsonResponse(200, {
          id: usedPayment.id,
          status: 'ready',
          public_url: usedPayment.public_url,
          metadata_uri: usedPayment.metadata_uri,
          mint_address: usedPayment.mint_address,
          mint_tx_signature: usedPayment.mint_tx_signature,
          payment_tx_signature: usedPayment.payment_tx_signature,
          payment_amount_sakura: usedPayment.payment_amount_sakura,
          taste_snapshot: usedPayment.taste_snapshot,
          mode: usedPayment.mode,
        }, cors);
      }
      if (usedPayment.wallet_address === walletAddress && usedPayment.status === 'failed') {
        retryGenerationId = usedPayment.id as string;
      } else if (usedPayment.wallet_address === walletAddress && (usedPayment.status === 'processing' || usedPayment.status === 'queued')) {
        return jsonResponse(409, { error: 'This avatar forge is already processing.', id: usedPayment.id }, cors);
      } else {
        // Another wallet's row owns this signature. Never silently swallowed:
        // this is either a real double-claim or a bug worth seeing.
        console.error(
          `[avatar] payment claimed by another wallet: sig=${paymentTxSignature} claimant=${walletAddress} owner=${usedPayment.wallet_address}`,
        );
        return jsonResponse(400, { error: 'Payment transaction already claimed.' }, cors);
      }
    }

    // A credit has no transaction to read. Left in, fetchConfirmedTransaction
    // would be handed 'apology:...', fail as unverifiable -- and unverifiable is
    // not `attributable`, so it would not even be audited -- and 402 a user who
    // owes nothing.
    let creditedSakura: number | null = null;
    if (!paymentBypass && !grantCredit) {
      try {
        const verified = await verifyAvatarSakuraPayment({
          signature: paymentTxSignature!,
          expectedPayer: walletAddress,
          minAmountSakura: mintPrice,
        });
        creditedSakura = verified.amount;
      } catch (paymentError) {
        const reason = paymentError instanceof Error ? paymentError.message : 'Payment verification failed.';

        // Only record refusals we can pin on a real transaction paid by this
        // wallet. "Transaction not found" and "signer does not match" are
        // exactly the cases a stranger could fabricate, so they log and stop.
        if (paymentError instanceof AvatarPaymentError && paymentError.attributable) {
          await recordPaymentRejection(supabase, {
            walletAddress,
            paymentTxSignature: paymentTxSignature!,
            creditedSakura: paymentError.creditedSakura,
            expectedSakura: mintPrice,
            stage: 'payment_verification',
            reason,
          });
        } else {
          console.warn(
            `[avatar] unattributable payment refusal wallet=${walletAddress} sig=${paymentTxSignature} reason=${reason}`,
          );
        }

        // Returned explicitly rather than thrown: the outer catch decides 402 by
        // string-matching the message, which is a heuristic, not a guarantee.
        return jsonResponse(402, { error: reason, payment_recorded: true }, cors);
      }
    }

    // Credits are exempt, on the same reasoning as the retry exemption: four
    // granted avatars forged back to back can never yield a fifth, because
    // avatar_count caps the slots. Leaving the limit in would 429 credits 2, 3
    // and 4 -- and worse, recordPaymentRejection below would then write
    // fabricated "charged 100,000 but refused" rows for payments that never
    // happened, into the one table whose entire value is that it cannot be
    // poisoned.
    if (!paymentBypass && !grantCredit && !retryGenerationId) {
      const { data: recent } = await supabase
        .from('user_avatar_generations')
        .select('created_at, status')
        .eq('wallet_address', walletAddress)
        .in('status', ['queued', 'processing', 'ready'])
        .gt('payment_amount_sakura', 0)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recent?.created_at) {
        const elapsed = hoursSince(recent.created_at);
        if (elapsed < RATE_LIMIT_HOURS) {
          const retryHours = Math.max(1, Math.ceil(RATE_LIMIT_HOURS - elapsed));
          await recordPaymentRejection(supabase, {
            walletAddress,
            paymentTxSignature: paymentTxSignature!,
            creditedSakura,
            expectedSakura: mintPrice,
            stage: 'rate_limited',
            reason:
              `Rate limited: last mint ${elapsed.toFixed(1)}h ago, limit ${RATE_LIMIT_HOURS}h. ` +
              `Payment confirmed on chain but not spent; the same signature still works after ~${retryHours}h.`,
          });
          return jsonResponse(429, {
            error:
              `You can mint again in about ${retryHours} hour(s). Your SAKURA is safe — ` +
              `this exact payment still works when you retry.`,
            retry_after_hours: retryHours,
            payment_recorded: true,
          }, cors);
        }
      }
    }

    // Server-chosen, keyed on the slot, so four granted avatars are four
    // different faces even though the client sends no hint. A retry gets no hint
    // at all, for the reason given at `mode` above.
    function hintForSlot(slot: number, isRetry: boolean): string {
      if (isRetry) return '';
      return GRANT_SLOT_HINTS[(slot - 1) % GRANT_SLOT_HINTS.length];
    }

    let userHint = sanitizeUserHint(body.hint);
    if (!userHint && grantCredit) {
      userHint = hintForSlot(grantCredit.slot, grantCredit.isRetry);
    }

    const taste = await buildTasteSnapshot(supabase, walletAddress);
    let prompt = buildAvatarPrompt({ mode, taste, userHint });

    const generationWrite = {
      wallet_address: walletAddress,
      mode,
      status: 'processing',
      taste_snapshot: taste,
      prompt_snapshot: prompt,
      model: MODEL,
      payment_tx_signature: paymentTxSignature,
      payment_amount_sakura: chargedSakura,
      error_message: null,
      completed_at: null,
    };

    // Retries CLAIM the row atomically: the `.eq('status','failed')` makes the
    // failed -> processing transition the thing that decides the winner. Two
    // concurrent retries of the same signature (double-tap, or a resume racing a
    // manual retry) would otherwise both pass the guards and both call
    // mintAvatarNft, minting two NFTs and paying two lots of SOL while the row
    // keeps only the second mint_address -- leaving an NFT in the user's wallet
    // that no query can see.
    const generationQuery = retryGenerationId
      ? supabase
          .from('user_avatar_generations')
          .update(generationWrite)
          .eq('id', retryGenerationId)
          .eq('wallet_address', walletAddress)
          .eq('status', 'failed')
          .select('id')
          .maybeSingle()
      : supabase
          .from('user_avatar_generations')
          .insert(generationWrite)
          .select('id')
          .maybeSingle();

    // `let`, because a lost credit race below re-allocates and inserts again.
    let { data: generation, error: insertError } = await generationQuery;

    // THE CREDIT LOCK, FIRING. The partial UNIQUE on payment_tx_signature is the
    // only thing that decides who spends a credit, and it decides it HERE --
    // before generateFluxImage and before mintAvatarNft. The loser of the race
    // has produced no image, no NFT and no SOL spend.
    //
    // A collision means a concurrent request took the slot we aimed at, so
    // re-allocate ONCE and try the next one: if the wallet is genuinely owed
    // another avatar he gets it with no visible error, and if he is not, the
    // second claim returns null and he falls through to the 409. Never loop, and
    // never retry into a slot that already owns a row -- that one belongs to the
    // update path.
    if (
      insertError &&
      (insertError as { code?: string }).code === '23505' &&
      grantCredit &&
      !retryGenerationId
    ) {
      const next = await claimGrantCreditSlot(supabase, walletAddress);
      if (next && !next.failedGenerationId && next.signature !== grantCredit.signature) {
        grantCredit = next;
        paymentTxSignature = next.signature;
        userHint = sanitizeUserHint(body.hint) || hintForSlot(next.slot, next.isRetry);
        prompt = buildAvatarPrompt({ mode, taste, userHint });
        generationWrite.payment_tx_signature = next.signature;
        generationWrite.prompt_snapshot = prompt;
        const retry = await supabase
          .from('user_avatar_generations')
          .insert(generationWrite)
          .select('id')
          .maybeSingle();
        generation = retry.data;
        insertError = retry.error;
      }
    }

    if (!insertError && !generation && retryGenerationId) {
      return jsonResponse(
        409,
        { error: 'This avatar forge is already processing.', id: retryGenerationId },
        cors,
      );
    }

    // Returned, never rethrown: the outer catch maps any message containing
    // 'signature' to 401, and PostgREST's 23505 detail string contains
    // 'payment_tx_signature'. Raw, it reaches the user as
    // 'duplicate key value violates unique constraint ...' in an alert box.
    if (insertError && (insertError as { code?: string }).code === '23505') {
      return jsonResponse(409, {
        error: grantCredit
          ? 'That free avatar is already being forged. Give it a moment, then open Sakura again.'
          : 'Payment transaction already claimed.',
        code: 'mint_in_flight',
      }, cors);
    }

    if (insertError || !generation) {
      return jsonResponse(500, { error: insertError?.message || 'Could not start mint.' }, cors);
    }

    const generationId = generation.id as string;
    const imagePath = `${walletAddress}/${generationId}.png`;
    const metadataPath = `${walletAddress}/${generationId}.json`;

    // The single most important flag in this function. mintAvatarNft ends in
    // sendAndConfirm, whose routine failure mode is "transaction landed, then
    // confirmation timed out" -- it throws with the NFT already in the user's
    // wallet and the SOL already spent. Marking such a row `failed` is what
    // hands the credit back, and handing it back mints a SECOND NFT for one
    // credit and leaves the first invisible to every query in the app. So: once
    // this is true, the row is never marked failed and never reclaimed.
    let mintSubmitted = false;

    try {
      const bytes = await generateFluxImage(prompt);
      const { error: uploadError } = await supabase.storage
        .from('user-avatars')
        .upload(imagePath, bytes, {
          contentType: 'image/png',
          upsert: true,
          cacheControl: '3600',
        });
      if (uploadError) throw new Error(uploadError.message);

      const { data: imagePublic } = supabase.storage.from('user-avatars').getPublicUrl(imagePath);
      const imageUrl = imagePublic.publicUrl;

      const nftDisplayName =
        paymentBypass && body.nft_name?.trim()
          ? body.nft_name.trim().slice(0, 32)
          : avatarNftName(mode);

      const metadata = buildAvatarMetadata({
        name: nftDisplayName,
        symbol: 'SKRAV',
        description:
          paymentBypass && body.nft_name?.trim()
            ? `${nftDisplayName} — MAPPA-style anime portrait minted on Sakura.`
            : 'MAPPA-style Jujutsu Kaisen-inspired anime portrait minted on Sakura. One wallet-bound collectible.',
        imageUrl,
        walletAddress,
        mode,
        vibe: taste.vibe ?? 'Sakura reader',
        topGenres: taste.top_genres,
      });

      const { error: metadataUploadError } = await supabase.storage
        .from('user-avatars')
        .upload(metadataPath, JSON.stringify(metadata), {
          contentType: 'application/json',
          upsert: true,
          cacheControl: '3600',
        });
      if (metadataUploadError) throw new Error(metadataUploadError.message);

      const { data: metadataPublic } = supabase.storage.from('user-avatars').getPublicUrl(metadataPath);
      const metadataUri = metadataPublic.publicUrl;

      // Written BEFORE the mint and awaited, so a request that dies inside
      // sendAndConfirm still leaves the marker behind. A row carrying it is
      // never auto-reclaimed by reclaimStaleCreditSlot at any age.
      const { error: markError } = await supabase
        .from('user_avatar_generations')
        .update({ mint_submitted_at: new Date().toISOString() })
        .eq('id', generationId);
      if (markError) throw new Error(markError.message);
      mintSubmitted = true;

      const minted = await mintAvatarNft({
        recipientWallet: walletAddress,
        metadataUri,
        name: nftDisplayName,
        symbol: metadata.symbol,
      });

      const completedAt = new Date().toISOString();
      await supabase
        .from('user_avatar_generations')
        .update({
          status: 'ready',
          storage_path: imagePath,
          public_url: imageUrl,
          metadata_uri: metadataUri,
          mint_address: minted.mintAddress,
          mint_tx_signature: minted.signature,
          completed_at: completedAt,
        })
        .eq('id', generationId);

      if (grantCredit) {
        // Audit only, and best-effort by design. Every read path derives the
        // granted set from the slot prefix (grantedGenerationIds), so a failure
        // here cannot lose an avatar -- it only leaves the ledger column thin.
        //
        // A read-modify-write from here would lose ids outright when two slots
        // land at once, hence a single-statement RPC. Wrapped, because the
        // enclosing catch marks the generation failed and returns 502, and the
        // NFT is already in his wallet by this point: a bookkeeping hiccup must
        // never be reported as a failed mint.
        try {
          const { error: appendError } = await supabase.rpc('avatar_grant_append_generation', {
            p_wallet: walletAddress,
            p_generation: generationId,
          });
          if (appendError) console.error('[avatar] grant append failed:', appendError.message);
        } catch (appendError) {
          console.error(
            '[avatar] grant append failed:',
            appendError instanceof Error ? appendError.message : appendError,
          );
        }
      }

      // A paid mint becomes the profile picture immediately -- that is what the
      // user just bought. A bypass or GRANTED mint must NOT: forging four
      // apology avatars back to back would silently install the fourth and
      // pre-empt the very choice the apology exists to offer. They land as
      // `ready` rows and the existing `select` action does the choosing.
      if (!paymentBypass && !grantCredit) {
        await supabase
          .from('user_profiles')
          .upsert(
            {
              wallet_address: walletAddress,
              avatar_url: imageUrl,
              avatar_generation_id: generationId,
              avatar_mint_address: minted.mintAddress,
              avatar_seed: walletAddress.slice(0, 8),
              updated_at: completedAt,
            },
            { onConflict: 'wallet_address' },
          );
      }

      return jsonResponse(
        200,
        {
          id: generationId,
          status: 'ready',
          public_url: imageUrl,
          metadata_uri: metadataUri,
          mint_address: minted.mintAddress,
          mint_tx_signature: minted.signature,
          payment_tx_signature: paymentTxSignature,
          payment_amount_sakura: chargedSakura,
          // So the client can say "free" without parsing the slot signature, and
          // knows how many are still owed without a second round trip.
          free_credit: Boolean(grantCredit),
          credits_remaining: grantCredit ? grantCredit.remaining : 0,
          credits_in_review: grantCredit ? grantCredit.inReview : 0,
          taste_snapshot: taste,
          mode,
        },
        cors,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Avatar mint failed.';

      if (mintSubmitted) {
        // The mint transaction went out. It may well have landed. Leave the row
        // non-terminal so nothing hands the credit back, record why, and shout
        // in the logs -- this is the one case that needs a human.
        await supabase
          .from('user_avatar_generations')
          .update({ error_message: `Mint submitted but not confirmed: ${message}` })
          .eq('id', generationId);
        console.error(
          `[avatar] MINT UNCONFIRMED -- NEEDS REVIEW wallet=${walletAddress} ` +
            `generation=${generationId} sig=${paymentTxSignature} reason=${message}`,
        );
        return jsonResponse(502, {
          error: grantCredit
            ? 'Your avatar may already have been minted — check your wallet in a few minutes. Nothing was charged either way, and we are looking into it.'
            : 'Your avatar may already have been minted — check your wallet in a few minutes. Your payment is recorded against this forge, so you will not be charged again.',
          id: generationId,
          code: 'mint_unconfirmed',
        }, cors);
      }

      await supabase
        .from('user_avatar_generations')
        .update({
          status: 'failed',
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', generationId);

      return jsonResponse(502, { error: message, id: generationId }, cors);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Avatar mint failed.';
    const status = message.includes('wallet') || message.includes('signature') || message.includes('expired')
      ? 401
      : message.includes('Payment') || message.includes('SAKURA') || message.includes('payment')
      ? 402
      : message.includes('not allowed') ? 400 : 500;
    return jsonResponse(status, { error: message }, cors);
  }
});
