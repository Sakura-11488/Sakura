import { supabase } from '@/lib/supabase';

/**
 * Client half of the XP leaderboard.
 *
 * Goes through the `xp-leaderboard` edge function rather than querying directly,
 * because `user_xp_state` has RLS with a service_role-only policy — there is no
 * anon read, so no client query can rank users however it is written. The
 * display tables (`sakura_usernames`, `user_profiles`) are publicly readable,
 * but the XP itself is not.
 *
 * No wallet signature is sent: the leaderboard is public, and requiring one
 * would show visitors without a wallet an empty screen. A wallet address is
 * passed when we have one, purely so the server can return that person's own
 * rank — resolved server-side by counting higher scores, so someone in 4,000th
 * place learns their position without paging there.
 */

export interface LeaderboardEntry {
  rank: number;
  wallet_address: string;
  username: string | null;
  display_name: string | null;
  avatar_seed: string;
  avatar_url: string | null;
  xp: number;
  level: number;
  current_streak: number;
  longest_streak: number;
  last_active_day: string | null;
}

export interface LeaderboardPage {
  entries: LeaderboardEntry[];
  total: number;
  hasMore: boolean;
  /** The requesting wallet's own standing, if it has any XP at all. */
  self: { rank: number; xp: number; level: number } | null;
}

/** The board opens on the top 100; "show more" pulls the next 100. */
export const LEADERBOARD_PAGE_SIZE = 100;

/** Below this a search matches almost everyone, so it is not worth a round trip. */
export const MIN_SEARCH_LENGTH = 2;

export async function fetchLeaderboard(opts?: {
  limit?: number;
  offset?: number;
  walletAddress?: string | null;
  /**
   * Searches the whole board, not just loaded rows. Ranks come back as true
   * global positions, so a hit at 4,000th reports 4,000. Results are a single
   * page — search is for finding someone, not for browsing.
   */
  query?: string;
}): Promise<LeaderboardPage> {
  const query = (opts?.query ?? '').trim();
  const { data, error } = await supabase.functions.invoke('xp-leaderboard', {
    body: {
      limit: opts?.limit ?? LEADERBOARD_PAGE_SIZE,
      offset: opts?.offset ?? 0,
      wallet_address: opts?.walletAddress || undefined,
      query: query.length >= MIN_SEARCH_LENGTH ? query : undefined,
    },
  });

  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.error) throw new Error(String(d.error));

  return {
    entries: Array.isArray(d.entries) ? (d.entries as LeaderboardEntry[]) : [],
    total: Number(d.total) || 0,
    hasMore: Boolean(d.has_more),
    self: (d.self as LeaderboardPage['self']) ?? null,
  };
}

/** Compact display for large scores: 1,234 / 12.3k / 1.2m. */
export function formatXp(xp: number): string {
  const n = Math.max(0, Math.floor(xp));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/**
 * A readable label for a wallet that never set a username.
 *
 * Falls back to a truncated address rather than "Anonymous", so every row
 * stays distinguishable — a leaderboard of identical placeholder names is
 * useless, and the address is public anyway.
 */
export function leaderboardName(e: LeaderboardEntry): string {
  const name = (e.display_name || e.username || '').trim();
  if (name) return name;
  return `${e.wallet_address.slice(0, 4)}…${e.wallet_address.slice(-4)}`;
}
