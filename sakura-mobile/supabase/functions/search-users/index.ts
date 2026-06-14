import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse } from '../_shared/wallet-auth.ts';
import { checkRateLimit, clientIp } from '../_shared/rate-limit.ts';

type SearchBody = { query?: string; limit?: number };

const cors = corsHeaders();
const MAX_LIMIT = 20;
const MIN_QUERY_LEN = 2;
const SEARCH_RATE_LIMIT = 60;
const SEARCH_WINDOW_SEC = 60;

function normalizeQuery(raw: string): string {
  return raw.trim().replace(/^@/, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const ip = clientIp(req);
    const rate = await checkRateLimit(
      supabase,
      `search-users:ip:${ip}`,
      SEARCH_RATE_LIMIT,
      SEARCH_WINDOW_SEC,
    );
    if (!rate.allowed) {
      return jsonResponse(
        429,
        { error: 'Too many searches. Please wait a moment.', retry_after_sec: rate.retryAfterSec ?? SEARCH_WINDOW_SEC },
        cors,
      );
    }

    const body = (await req.json().catch(() => ({}))) as SearchBody;
    const query = normalizeQuery(body.query ?? '');
    const limit = Math.min(Math.max(body.limit ?? MAX_LIMIT, 1), MAX_LIMIT);

    if (query.length < MIN_QUERY_LEN) {
      return jsonResponse(400, { error: `Query must be at least ${MIN_QUERY_LEN} characters.` }, cors);
    }

    const pattern = `%${query}%`;
    const wallets = new Set<string>();
    const users: Array<Record<string, unknown>> = [];

    const pushUser = (row: Record<string, unknown>) => {
      const wallet = String(row.wallet_address ?? '');
      if (!wallet || wallets.has(wallet)) return;
      wallets.add(wallet);
      users.push(row);
    };

    if (isWallet(query)) {
      const { data: exactWallet } = await supabase
        .from('user_profiles')
        .select(
          'wallet_address, display_name, bio, avatar_url, avatar_seed, follower_count, creator_verification_state',
        )
        .eq('wallet_address', query)
        .maybeSingle();

      if (exactWallet) {
        const { data: usernameRow } = await supabase
          .from('sakura_usernames')
          .select('username, display_name')
          .eq('wallet_address', query)
          .maybeSingle();
        pushUser({
          ...exactWallet,
          username: usernameRow?.username ?? null,
          display_name: exactWallet.display_name ?? usernameRow?.display_name ?? null,
        });
      } else {
        const { data: usernameOnly } = await supabase
          .from('sakura_usernames')
          .select('wallet_address, username, display_name')
          .eq('wallet_address', query)
          .maybeSingle();
        if (usernameOnly) {
          pushUser({
            wallet_address: usernameOnly.wallet_address,
            username: usernameOnly.username,
            display_name: usernameOnly.display_name,
            avatar_url: null,
            avatar_seed: query.slice(0, 8),
            follower_count: 0,
            creator_verification_state: null,
          });
        }
      }
    }

    const { data: usernameMatches } = await supabase
      .from('sakura_usernames')
      .select('wallet_address, username, display_name')
      .ilike('username', `%${query}%`)
      .limit(limit);

    for (const row of usernameMatches ?? []) {
      if (users.length >= limit) break;
      const { data: profile } = await supabase
        .from('user_profiles')
        .select(
          'wallet_address, display_name, bio, avatar_url, avatar_seed, follower_count, creator_verification_state',
        )
        .eq('wallet_address', row.wallet_address)
        .maybeSingle();

      pushUser({
        wallet_address: row.wallet_address,
        username: row.username,
        display_name: profile?.display_name ?? row.display_name ?? null,
        avatar_url: profile?.avatar_url ?? null,
        avatar_seed: profile?.avatar_seed ?? String(row.wallet_address).slice(0, 8),
        follower_count: profile?.follower_count ?? 0,
        creator_verification_state: profile?.creator_verification_state ?? null,
      });
    }

    if (users.length < limit) {
      const { data: displayMatches } = await supabase
        .from('user_profiles')
        .select(
          'wallet_address, display_name, bio, avatar_url, avatar_seed, follower_count, creator_verification_state',
        )
        .ilike('display_name', pattern)
        .limit(limit);

      for (const profile of displayMatches ?? []) {
        if (users.length >= limit) break;
        if (wallets.has(profile.wallet_address)) continue;
        const { data: usernameRow } = await supabase
          .from('sakura_usernames')
          .select('username')
          .eq('wallet_address', profile.wallet_address)
          .maybeSingle();
        pushUser({
          ...profile,
          username: usernameRow?.username ?? null,
        });
      }
    }

    return jsonResponse(200, { users: users.slice(0, limit) }, cors);
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'Search failed.' }, cors);
  }
});
