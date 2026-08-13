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

  const { data: recent } = await supabase
    .from('user_avatar_generations')
    .select('created_at, status')
    .eq('wallet_address', walletAddress)
    .in('status', ['queued', 'processing', 'ready'])
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

  const mints = await listReadyMints(supabase, walletAddress, profile?.avatar_generation_id ?? null);

  return {
    price_sakura: mintPrice,
    currency: 'SAKURA',
    rate_limit_hours: RATE_LIMIT_HOURS,
    can_mint: retryAfterHours === 0,
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
      .select('generation_ids, shown_at, resolved_at')
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    if (!grant || grant.resolved_at || !grant.shown_at) return;
    const ids = (grant.generation_ids ?? []) as string[];
    if (!ids.includes(generationId)) return;

    await markApologyGrantResolved(supabase, walletAddress, 'selected', generationId);
  } catch (grantError) {
    // Never break the pick over bookkeeping.
    console.error(
      '[avatar] apology grant resolve failed:',
      grantError instanceof Error ? grantError.message : grantError,
    );
  }
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
      'incident, avatar_count, charged_sakura, received_count, generation_ids, granted_at, shown_at, resolved_at',
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

  const ids = ((grant.generation_ids ?? []) as string[]).filter(Boolean);
  const avatars = await loadGrantedAvatars(supabase, walletAddress, ids, null);
  const expected = Number(grant.avatar_count ?? ids.length);

  return {
    has_grant: true,
    resolved: false,
    // Every promised avatar must have landed before the card may claim them.
    // A partial mint would otherwise tell him he owns four when he owns two.
    ready: avatars.length > 0 && avatars.length >= expected,
    incident: (grant.incident as string) ?? 'charged_without_delivery',
    avatar_count: expected,
    minted_count: avatars.length,
    charged_sakura: Number(grant.charged_sakura ?? 0),
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
      'incident, avatar_count, charged_sakura, received_count, generation_ids, granted_at, shown_at, resolved_at',
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

  const ids = ((grant.generation_ids ?? []) as string[]).filter(Boolean);
  const avatars = await loadGrantedAvatars(supabase, walletAddress, ids, activeId);
  const expected = Number(grant.avatar_count ?? ids.length);

  if (!avatars.length || avatars.length < expected) {
    // Do not stamp shown_at for a card we are not going to show.
    return {
      has_grant: true,
      resolved: false,
      ready: false,
      minted_count: avatars.length,
      avatar_count: expected,
      avatars: [],
    };
  }

  // Self-heal, on the SIGNED path only. If he is already wearing one of the
  // granted avatars and the grant was shown, he picked and the ack never landed
  // (app killed, offline, crash) -- latch it so the apology cannot reappear.
  if (grant.shown_at && activeId && ids.includes(activeId)) {
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
    charged_sakura: Number(grant.charged_sakura ?? 0),
    received_count: Number(grant.received_count ?? 0),
    granted_at: (grant.granted_at as string) ?? null,
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

      const ids = (grant.generation_ids ?? []) as string[];
      if (generationId && !ids.includes(generationId)) {
        return jsonResponse(400, { error: 'generation_id is not part of this grant.' }, cors);
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

    if (paymentBypass) {
      paymentTxSignature = `dev-bypass-${crypto.randomUUID()}`;
      chargedSakura = 0;
    } else if (!paymentTxSignature) {
      return jsonResponse(400, {
        error: `A confirmed SAKURA payment of ${mintPrice.toLocaleString()} is required.`,
        price_sakura: mintPrice,
      }, cors);
    }

    const mode = body.mode === 'general' ? 'general' : 'tastes';

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

    let creditedSakura: number | null = null;
    if (!paymentBypass) {
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

    if (!paymentBypass && !retryGenerationId) {
      const { data: recent } = await supabase
        .from('user_avatar_generations')
        .select('created_at, status')
        .eq('wallet_address', walletAddress)
        .in('status', ['queued', 'processing', 'ready'])
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

    const userHint = sanitizeUserHint(body.hint);

    const taste = await buildTasteSnapshot(supabase, walletAddress);
    const prompt = buildAvatarPrompt({ mode, taste, userHint });

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

    const { data: generation, error: insertError } = await generationQuery;

    if (!insertError && !generation && retryGenerationId) {
      return jsonResponse(
        409,
        { error: 'This avatar forge is already processing.', id: retryGenerationId },
        cors,
      );
    }

    if (insertError || !generation) {
      return jsonResponse(500, { error: insertError?.message || 'Could not start mint.' }, cors);
    }

    const generationId = generation.id as string;
    const imagePath = `${walletAddress}/${generationId}.png`;
    const metadataPath = `${walletAddress}/${generationId}.json`;

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

      // A paid mint becomes the profile picture immediately -- that is what the
      // user just bought. A bypass mint must NOT: granting four apology avatars
      // back to back would silently install the fourth and pre-empt the very
      // choice the apology exists to offer. Bypass mints land as `ready` rows
      // and the existing `select` action does the choosing.
      if (!paymentBypass) {
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
          taste_snapshot: taste,
          mode,
        },
        cors,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Avatar mint failed.';
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
