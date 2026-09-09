import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

/**
 * Creator coin launch — records the request and returns an unsigned pump.fun
 * create-coin transaction for the creator's own wallet to sign. The backend
 * never holds creator keys, so it can only ever hand back something to sign.
 *
 * Eligibility is a follower threshold counted live from creator_follows, NOT
 * read from user_profiles.follower_count. That column is a display cache kept
 * by a trigger that updates by wallet_address, so it silently stays 0 for any
 * wallet with no user_profiles row — three of the four followed creators in
 * production are in exactly that state, one of them with seven real followers.
 * Authorising against the cache would lock them out permanently with no error
 * surfaced anywhere. Count the source of truth instead; it is one indexed
 * count against a table that is already the arbiter of who follows whom.
 *
 * What this replaced: a gate requiring creator_verification_state = 'verified'
 * AND a creator_revenue_eligibility row. Nothing in the codebase can set
 * either — there is no approve path, and that table has no writer at all — so
 * it returned 403 to every wallet on the platform, forever.
 *
 * Launching is irreversible and spends real SOL (pump.fun is mainnet-only, no
 * devnet), which is why there is a one-coin-per-creator guard and a daily rate
 * limit below.
 */

type LaunchBody = {
  name?: string;
  symbol?: string;
  description?: string;
  image_url?: string;
  metadata_uri?: string;
};

const cors = corsHeaders();
const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;

/**
 * Statuses that mean this creator already has a coin in play. 'draft', 'failed'
 * and 'disabled' do not block a fresh attempt.
 *
 * Only 'launched' is permanent. The other two are in-flight states, and they
 * MUST be reclaimable — see LAUNCH_STALE_AFTER_MS.
 */
const BLOCKING_COIN_STATUSES = ['requested', 'pending_signature', 'launched'];

/**
 * How long an unfinished attempt blocks a retry.
 *
 * The creator_coins row is inserted as 'requested' before the builder is even
 * called, and nothing in the codebase moves a row out of 'requested' or
 * 'pending_signature' except a successful on-chain verify. So every failure in
 * between — a builder timeout, a 500, a declined wallet signature, a closed app,
 * or simply running with PUMPFUN_UNSIGNED_TX_URL unset as it is today — strands a
 * row. Without reclaim, the one-coin guard below would read that row and refuse
 * the creator forever, with no admin path, no expiry job, and no way for them to
 * recover short of abandoning the wallet that holds their followers.
 *
 * Long enough to cover signing in a wallet; short enough that a crash does not
 * cost somebody their only slot.
 *
 * Known trade-off: if a creator signs, the transaction lands on chain, and
 * creator-coin-verify is never called, reclaim will free the slot and they could
 * launch a second real coin. Nothing calls verify today, so that gap closes when
 * the verify step is wired up — a resume check on any 'pending_signature' row
 * before reclaiming it. Chose this direction deliberately: a rare duplicate is
 * recoverable, a permanent lockout is not.
 */
const LAUNCH_STALE_AFTER_MS = 30 * 60 * 1000;

const LAUNCH_RATE_LIMIT = 5;
const LAUNCH_WINDOW_SEC = 86_400;

/**
 * Followers required before a creator may launch. Change without a redeploy via
 * `supabase secrets set CREATOR_COIN_MIN_FOLLOWERS=25`. Read per request rather
 * than into a module const, so it lands on the next call instead of the next
 * cold start.
 *
 * Set to 5 rather than the 10 originally planned: the most-followed creator on
 * the platform has 7 followers, so 10 would have refused literally everyone.
 * This is a low bar and it is not Sybil-resistant — follows are free, unlimited,
 * and need only a fresh keypair — so it gates convenience, not abuse. Raise it
 * before the launch path can actually mint.
 */
function minFollowers(): number {
  const raw = Number(Deno.env.get('CREATOR_COIN_MIN_FOLLOWERS') || '5');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  // Auth gets its own narrow try so that a database or provider failure further
  // down reports as a 500 instead of masquerading as a wallet problem.
  let walletAddress: string;
  try {
    ({ walletAddress } = verifyWalletHeaders(req.headers, 'creator-coin-launch'));
  } catch (err) {
    return jsonResponse(401, { error: err instanceof Error ? err.message : 'Unauthorized.' }, cors);
  }

  try {
    const body = (await req.json()) as LaunchBody;
    const name = (body.name ?? '').trim().slice(0, 80);
    const symbol = (body.symbol ?? '').trim().toUpperCase();
    const description = (body.description ?? '').trim().slice(0, 2000);

    if (name.length < 2) return jsonResponse(400, { error: 'Coin name is required.' }, cors);
    if (!SYMBOL_RE.test(symbol)) return jsonResponse(400, { error: 'Symbol must be 2-10 uppercase letters or numbers.' }, cors);
    if (!body.metadata_uri && !body.image_url) {
      return jsonResponse(400, { error: 'Add stable token metadata or an image before launch.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const rate = await checkRateLimit(
      supabase,
      `creator-coin-launch:${walletAddress}`,
      LAUNCH_RATE_LIMIT,
      LAUNCH_WINDOW_SEC,
    );
    if (!rate.allowed) {
      return jsonResponse(
        429,
        { error: 'Too many launch attempts today. Try again tomorrow.', retry_after_sec: rate.retryAfterSec ?? LAUNCH_WINDOW_SEC },
        cors,
      );
    }

    // Eligibility. Errors are checked rather than coalesced away — the old gate
    // destructured only `data`, so a failed query was indistinguishable from an
    // ineligible creator and both produced the same 403.
    // The "recognized work" half of the rule, and the reason this feature
    // exists at all: a coin is launched against work published on Sakura, not
    // against a follower count alone. Without this a wallet that has never
    // published anything could launch purely on follows.
    //
    // Keyed on publication_status, NOT visibility. The four Sakura Originals
    // are deliberately `unlisted` — their episodes live in droplet manifests,
    // so a public row would render a catalog card that opens an empty reader —
    // and they are precisely the works this has to recognize.
    const { count: workCount, error: workErr } = await supabase
      .from('creator_works')
      .select('*', { count: 'exact', head: true })
      .eq('creator_wallet', walletAddress)
      .eq('publication_status', 'published');
    if (workErr) return jsonResponse(500, { error: workErr.message }, cors);
    const publishedWorks = workCount ?? 0;
    if (publishedWorks < 1) {
      return jsonResponse(
        403,
        {
          error: 'Publish a work on Sakura before launching a coin.',
          published_works: publishedWorks,
          required_works: 1,
        },
        cors,
      );
    }
    const required = minFollowers();
    const { count: followerCount, error: followerErr } = await supabase
      .from('creator_follows')
      .select('*', { count: 'exact', head: true })
      .eq('creator_wallet', walletAddress);
    if (followerErr) return jsonResponse(500, { error: followerErr.message }, cors);

    const followers = followerCount ?? 0;
    if (followers < required) {
      return jsonResponse(
        403,
        {
          error: `You need ${required} followers to launch a coin.`,
          follower_count: followers,
          required,
        },
        cors,
      );
    }

    // Reclaim abandoned attempts before the guard reads them, so a stranded row
    // expires instead of locking the creator out permanently.
    //
    // THE TRAP THIS AVOIDS: if a creator signed, the transaction landed, and
    // verify never ran, a blind reclaim would free the slot and let them launch
    // a SECOND real coin — permanently, since a launch cannot be undone. So a
    // stale row is only failed when it has no mint assigned. Once
    // creator-coin-launch has recorded the mint the builder reserved, the coin
    // may already exist on chain, and the right move is to re-run verify rather
    // than reclaim. Those rows are left alone and reported below.
    const staleBefore = new Date(Date.now() - LAUNCH_STALE_AFTER_MS).toISOString();
    const { error: reclaimErr } = await supabase
      .from('creator_coins')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('creator_wallet', walletAddress)
      .in('status', ['requested', 'pending_signature'])
      .is('mint_address', null)
      .lt('created_at', staleBefore);
    if (reclaimErr) return jsonResponse(500, { error: reclaimErr.message }, cors);

    // One coin per creator. A launch cannot be undone, so a second request is
    // far more likely to be a double-tap or a retry than a genuine intent.
    const { data: existingCoin, error: existingErr } = await supabase
      .from('creator_coins')
      .select('id, symbol, status, mint_address')
      .eq('creator_wallet', walletAddress)
      .in('status', BLOCKING_COIN_STATUSES)
      .limit(1)
      .maybeSingle();
    if (existingErr) return jsonResponse(500, { error: existingErr.message }, cors);
    if (existingCoin) {
      const launched = existingCoin.status === 'launched';
      return jsonResponse(
        409,
        {
          error: launched
            ? `You already have a coin (${existingCoin.symbol}). Launching is permanent, so it is one per creator.`
            : existingCoin.mint_address
              ? 'A launch for this coin already reached the signing step. If you signed it, it may already be on chain — verify that attempt rather than starting a new one.'
              : 'A launch is already in progress. If it did not finish, you can try again in half an hour.',
          coin_id: existingCoin.id,
          status: existingCoin.status,
        },
        cors,
      );
    }

    const { data: coin, error: coinErr } = await supabase
      .from('creator_coins')
      .insert({
        creator_wallet: walletAddress,
        name,
        symbol,
        description,
        image_url: body.image_url ?? null,
        metadata_uri: body.metadata_uri ?? null,
        provider: 'pumpfun',
        status: 'requested',
      })
      .select('id')
      .single();
    if (coinErr) return jsonResponse(500, { error: coinErr.message }, cors);

    let providerResponse: Record<string, unknown> = {};
    let unsignedTransaction: string | null = null;
    // Hoisted so it can be returned to the client, which must assert the
    // transaction it is about to sign really carries this mint.
    let reservedMint: string | null = null;
    // Forwarded so the client can tell "expired" from "timed out". Refetching a
    // blockhash on the device would give a later deadline than the transaction
    // actually has.
    let lastValidBlockHeight: number | null = null;
    const builderUrl = Deno.env.get('PUMPFUN_UNSIGNED_TX_URL')?.trim();

    if (builderUrl) {
      // The builder holds vanity mint keys, so it refuses unauthenticated
      // callers — without this header every launch comes back 401. The secret
      // is shared with the builder service and never reaches the client.
      const builderSecret = Deno.env.get('PUMPFUN_BUILDER_SECRET')?.trim();
      if (!builderSecret) {
        await supabase.from('creator_coins').update({ status: 'failed' }).eq('id', coin.id);
        return jsonResponse(500, { error: 'Coin launch builder is not configured.' }, cors);
      }
      const response = await fetch(builderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-builder-secret': builderSecret },
        body: JSON.stringify({
          creatorWallet: walletAddress,
          name,
          symbol,
          description,
          imageUrl: body.image_url ?? null,
          metadataUri: body.metadata_uri ?? null,
        }),
      });
      providerResponse = await response.json().catch(() => ({ status: response.status }));
      if (!response.ok) {
        await supabase.from('creator_coins').update({ status: 'failed' }).eq('id', coin.id);
        return jsonResponse(502, { error: 'Coin launch provider failed.', providerResponse }, cors);
      }
      const maybeTx = providerResponse.unsignedTransaction ?? providerResponse.transaction;
      unsignedTransaction = typeof maybeTx === 'string' ? maybeTx : null;

      // Bind the mint the builder reserved to this coin, NOW.
      //
      // This is what lets verify stop trusting a client-supplied mint_address.
      // Without it the only record of which mint was issued lives on the
      // caller's device, so anyone could claim any confirmed transaction — and
      // because creator_coins.mint_address is UNIQUE, a false claim also
      // permanently locks out the real owner of that mint.
      const mintAddress = providerResponse.mintAddress;
      if (typeof mintAddress !== 'string' || !mintAddress) {
        await supabase.from('creator_coins').update({ status: 'failed' }).eq('id', coin.id);
        return jsonResponse(502, { error: 'Coin launch provider returned no mint address.' }, cors);
      }
      reservedMint = mintAddress;
      const height = providerResponse.lastValidBlockHeight;
      lastValidBlockHeight = typeof height === 'number' ? height : null;
      const { error: mintErr } = await supabase
        .from('creator_coins')
        .update({ mint_address: mintAddress })
        .eq('id', coin.id);
      if (mintErr) {
        await supabase.from('creator_coins').update({ status: 'failed' }).eq('id', coin.id);
        return jsonResponse(500, { error: mintErr.message }, cors);
      }
    }

    const { data: requestRow, error: requestErr } = await supabase
      .from('creator_coin_launch_requests')
      .insert({
        creator_wallet: walletAddress,
        creator_coin_id: coin.id,
        status: unsignedTransaction ? 'built' : 'submitted',
        requested_payload: {
          name,
          symbol,
          description,
          image_url: body.image_url ?? null,
          metadata_uri: body.metadata_uri ?? null,
        },
        unsigned_transaction: unsignedTransaction,
        provider_response: providerResponse,
      })
      .select('id, status')
      .single();
    if (requestErr) return jsonResponse(500, { error: requestErr.message }, cors);

    await supabase
      .from('creator_coins')
      .update({ status: unsignedTransaction ? 'pending_signature' : 'requested' })
      .eq('id', coin.id);

    return jsonResponse(
      200,
      {
        ok: true,
        coin_id: coin.id,
        launch_request_id: requestRow.id,
        status: requestRow.status,
        unsigned_transaction: unsignedTransaction,
        // The client validates the transaction against this before signing, so
        // a compromised builder cannot swap in a mint the server never issued.
        mint_address: reservedMint,
        last_valid_block_height: lastValidBlockHeight,
      },
      cors,
    );
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'Coin launch request failed.' }, cors);
  }
});
