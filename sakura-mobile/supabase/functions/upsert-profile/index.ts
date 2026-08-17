import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

/**
 * The only way a user may write their own profile row.
 *
 * `user_profiles` was `FOR ALL TO public USING (true)` — anyone holding the
 * anon key, which ships inside every APK and the PWA bundle, could rewrite any
 * of the 85 rows. That is bad on its own, but it was not merely defacement:
 * `creator-coin-launch` reads this table as its **authorization gate**
 *
 *     const verified = profile?.creator_verification_state === 'verified';
 *     const eligible = eligibility?.eligible === true || profile?.revenue_enabled_at;
 *
 * so a caller could set their own row to `verified`, stamp `revenue_enabled_at`,
 * and walk straight through it. `request-creator-verification` — the intended
 * path, which only ever writes `'pending'` — was entirely bypassable.
 *
 * The fix is not "check the wallet". The fix is that this function cannot write
 * a privileged column even if someone later edits the client, because the
 * payload is built from an allowlist rather than filtered from the request:
 * every field is read out by name, and anything else the caller sends is never
 * looked at. Adding a column to the table does not silently make it writable.
 *
 * Privileged columns stay server-owned and keep their existing writers:
 *   creator_verification_state / creator_verified_at / creator_verified_by
 *                                    -> request-creator-verification, admin action
 *   revenue_enabled_at               -> the revenue-eligibility flow
 *   has_pass                         -> the pass purchase flow
 *   follower_count / following_count -> follow triggers
 *   avatar_url / avatar_mint_address / avatar_generation_id
 *                                    -> upload-profile-avatar, the avatar mint flow
 *   banner_url / banner_fan_art_id   -> the fan-art banner flow
 */

const cors = corsHeaders();

/** Everything a user is allowed to say about themselves. Nothing else. */
type SafeProfile = {
  display_name?: string | null;
  bio?: string | null;
  avatar_seed?: string;
};

/** Mirrors USERNAME_RE in lib/creator.ts. Enforced here because the client's
 *  copy is advisory — anyone can call this function directly. */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const MAX_DISPLAY_NAME = 40;
const MAX_BIO = 300;
const MAX_AVATAR_SEED = 64;

/**
 * Strip control characters and invisible/bidi formatting.
 *
 * Written as an explicit codepoint test rather than a regex character class
 * because the ranges matter and a mangled escape in a regex literal fails
 * silently — it still compiles, it just stops stripping anything.
 *
 * Bidi overrides are the load-bearing case: display names render inside other
 * users' comment threads and follower lists, and U+202E can make one name
 * render as another's wherever it appears.
 */
function stripUnsafe(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl = c < 0x20 || (c >= 0x7f && c <= 0x9f);
    const isInvisible =
      (c >= 0x200b && c <= 0x200f) || // zero-width + LTR/RTL marks
      (c >= 0x2028 && c <= 0x202e) || // line/para separators + bidi overrides
      (c >= 0x2066 && c <= 0x2069) || // bidi isolates
      c === 0xfeff; // BOM / zero-width no-break space
    if (!isControl && !isInvisible) out += ch;
  }
  return out;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripUnsafe(value).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  let wallet: string;
  try {
    wallet = verifyWalletHeaders(req.headers, 'profile-upsert').walletAddress;
  } catch {
    return jsonResponse(401, { error: 'Could not verify your wallet.' }, cors);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const rl = await checkRateLimit(supabase, `profile-upsert:${wallet}`, 20, 60);
    if (!rl.allowed) {
      return jsonResponse(429, { error: 'Slow down.', retryAfterSec: rl.retryAfterSec }, cors);
    }

    // Built by name from the allowlist — never spread from the request body, so
    // an unknown key cannot reach the table.
    const patch: SafeProfile & { wallet_address: string; updated_at: string } = {
      wallet_address: wallet, // the VERIFIED wallet; the body's is never consulted
      updated_at: new Date().toISOString(),
    };

    if ('display_name' in body) patch.display_name = text(body.display_name, MAX_DISPLAY_NAME);
    if ('bio' in body) patch.bio = text(body.bio, MAX_BIO);

    // Never null: the column is NOT NULL, and a wallet-derived default is what
    // every existing call site already passes.
    patch.avatar_seed = text(body.avatar_seed, MAX_AVATAR_SEED) ?? wallet.slice(0, 8);

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert(patch, { onConflict: 'wallet_address' })
      .select('wallet_address, display_name, bio, avatar_seed, avatar_url, updated_at')
      .single();

    if (error) {
      console.error('[upsert-profile] write failed', error.message);
      return jsonResponse(500, { error: 'Could not save your profile.' }, cors);
    }

    // ── Username ────────────────────────────────────────────────────────────
    //
    // A username is the wallet's public handle: /u/<name> and @mentions resolve
    // through it, so taking someone's name redirects their profile. Uniqueness
    // and one-per-wallet were enforced in the client, which is no enforcement at
    // all — the table was INSERT/UPDATE-open to anon, so the checks in
    // claimUsername were a formality anyone could skip.
    //
    // Claiming is once and irreversible here, matching what the client already
    // told users ("You already have a Sakura username"). Renaming would need a
    // redirect story for the old handle, so it stays unsupported rather than
    // half-supported.
    const { data: existing } = await supabase
      .from('sakura_usernames')
      .select('username')
      .eq('wallet_address', wallet)
      .maybeSingle();

    let username: string | null = (existing?.username as string) ?? null;

    const requested = typeof body.username === 'string' ? body.username.trim() : '';
    if (requested) {
      if (existing) {
        if (requested.toLowerCase() !== String(existing.username).toLowerCase()) {
          return jsonResponse(409, { error: 'You already have a Sakura username.' }, cors);
        }
      } else if (!USERNAME_RE.test(requested)) {
        return jsonResponse(400, { error: 'Use 3–20 letters, numbers, or underscores.' }, cors);
      } else {
        const { error: claimErr } = await supabase.from('sakura_usernames').insert({
          wallet_address: wallet,
          username: requested,
          display_name: patch.display_name ?? requested,
          updated_at: new Date().toISOString(),
        });
        if (claimErr) {
          // 23505 is the unique index doing the real work — two people racing for
          // the same handle both pass a prior availability check, and exactly one
          // of these inserts survives.
          const taken = (claimErr as { code?: string }).code === '23505';
          return jsonResponse(taken ? 409 : 500, {
            error: taken ? 'That username is already taken.' : 'Could not claim that username.',
          }, cors);
        }
        username = requested;
      }
    }

    // Keep the handle row's display_name in step with the profile.
    if (username && 'display_name' in body) {
      await supabase
        .from('sakura_usernames')
        .update({ display_name: patch.display_name ?? username, updated_at: new Date().toISOString() })
        .eq('wallet_address', wallet);
    }

    return jsonResponse(200, { ok: true, profile: data, username }, cors);
  } catch (e) {
    console.error('[upsert-profile] request failed', e instanceof Error ? e.message : e);
    return jsonResponse(500, { error: 'Could not save your profile.' }, cors);
  }
});
