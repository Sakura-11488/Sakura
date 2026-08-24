import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse } from '../_shared/wallet-auth.ts';
import { checkRateLimit, clientIp } from '../_shared/rate-limit.ts';

/**
 * Public XP leaderboard.
 *
 * WHY THIS IS AN EDGE FUNCTION and not a client query: `user_xp_state` has RLS
 * enabled with a service_role-only policy — there is no anon read. So the
 * client physically cannot rank users itself, however the screen is written.
 * `sakura_usernames` and `user_profiles` DO allow public read, but joining them
 * client-side would still leave the XP unreachable.
 *
 * NO WALLET SIGNATURE REQUIRED. A leaderboard is public by nature and gating it
 * behind a signature would mean visitors without a wallet see an empty screen.
 * That does make this an open endpoint over everyone's XP, so it is rate limited
 * per IP, the page size is capped, and it returns only what a leaderboard needs.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN: xp_spent. Lifetime XP is a public score;
 * how much of it someone has cashed out for SAKURA is their financial activity
 * and none of a leaderboard's business. `select` below is explicit for exactly
 * that reason — `select('*')` here would leak it the moment a column is added.
 */

const cors = corsHeaders('POST, OPTIONS');

/** Matches the app's default page and the "show more" step. */
const DEFAULT_LIMIT = 100;
/**
 * Hard ceiling per request. Someone can page as deep as they like, but not pull
 * the whole table in one call — this is an unauthenticated endpoint.
 */
const MAX_LIMIT = 200;
const MAX_OFFSET = 10_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Keyed on IP because there is no wallet identity to key on. Generous:
    // scrolling the leaderboard should never trip it, scraping it should.
    // checkRateLimit returns { allowed, retryAfterSec } — NOT a boolean. Testing
    // the returned object directly is always truthy, which would leave this
    // endpoint unlimited while appearing guarded. Destructure it.
    const ip = clientIp(req);
    const { allowed, retryAfterSec } = await checkRateLimit(supabase, `xp-leaderboard:${ip}`, 120, 60);
    if (!allowed) {
      return jsonResponse(
        429,
        { error: 'Too many requests. Try again shortly.', retry_after_sec: retryAfterSec ?? 5 },
        cors,
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
      wallet_address?: string;
    };

    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(body.limit) || DEFAULT_LIMIT)));
    const offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(Number(body.offset) || 0)));

    // Explicit column list — see the note above about xp_spent.
    const { data: rows, error, count } = await supabase
      .from('user_xp_state')
      .select('wallet_address, xp, level, current_streak, longest_streak, last_active_day', {
        count: 'exact',
      })
      // wallet_address breaks ties deterministically, so paging cannot show the
      // same person twice or skip someone when several share an XP total.
      .order('xp', { ascending: false })
      .order('wallet_address', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const wallets = (rows ?? []).map((r) => r.wallet_address);

    // Display data comes from the publicly-readable tables. Two small queries
    // rather than a view, so this needs no schema change to ship.
    const [{ data: names }, { data: profiles }] = await Promise.all([
      supabase.from('sakura_usernames').select('wallet_address, username, display_name').in('wallet_address', wallets),
      supabase.from('user_profiles').select('wallet_address, display_name, avatar_seed, avatar_url').in('wallet_address', wallets),
    ]);

    const nameByWallet = new Map((names ?? []).map((n) => [n.wallet_address, n]));
    const profByWallet = new Map((profiles ?? []).map((p) => [p.wallet_address, p]));

    const entries = (rows ?? []).map((r, i) => {
      const n = nameByWallet.get(r.wallet_address);
      const p = profByWallet.get(r.wallet_address);
      return {
        // Rank is derived from the offset, so it stays correct across pages
        // instead of restarting at 1 on every request.
        rank: offset + i + 1,
        wallet_address: r.wallet_address,
        username: n?.username ?? null,
        display_name: n?.display_name ?? p?.display_name ?? null,
        avatar_seed: p?.avatar_seed ?? r.wallet_address.slice(0, 8),
        avatar_url: p?.avatar_url ?? null,
        xp: r.xp,
        level: r.level,
        current_streak: r.current_streak,
        longest_streak: r.longest_streak,
        last_active_day: r.last_active_day,
      };
    });

    /**
     * The caller's own standing, when they supplied a wallet.
     *
     * Resolved with a COUNT of higher scores rather than by searching the paged
     * list, so someone ranked 4,000th still learns their position without the
     * client paging through 40 requests to find themselves.
     */
    let self: { rank: number; xp: number; level: number } | null = null;
    const selfWallet = String(body.wallet_address ?? '').trim();
    if (isWallet(selfWallet)) {
      const { data: mine } = await supabase
        .from('user_xp_state')
        .select('xp, level')
        .eq('wallet_address', selfWallet)
        .maybeSingle();
      if (mine) {
        const { count: ahead } = await supabase
          .from('user_xp_state')
          .select('*', { count: 'exact', head: true })
          .gt('xp', mine.xp);
        self = { rank: (ahead ?? 0) + 1, xp: mine.xp, level: mine.level };
      }
    }

    return jsonResponse(
      200,
      {
        ok: true,
        entries,
        total: count ?? 0,
        limit,
        offset,
        has_more: offset + entries.length < (count ?? 0),
        self,
      },
      cors,
    );
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? e.message : 'Leaderboard read failed.' }, cors);
  }
});
