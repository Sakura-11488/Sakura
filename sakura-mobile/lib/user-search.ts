import { supabase } from './supabase';

export interface UserSearchResult {
  wallet_address: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  avatar_seed: string | null;
  follower_count: number;
  creator_verification_state: string | null;
  verified: boolean;
}

export async function searchUsers(query: string, limit = 20): Promise<UserSearchResult[]> {
  const q = query.trim().replace(/^@/, '');
  if (q.length < 2) return [];

  const { data, error } = await supabase.functions.invoke('search-users', {
    body: { query: q, limit },
  });

  if (error) throw new Error(error.message || 'User search failed.');
  if (data?.error) {
    const retry = data.retry_after_sec ? ` Try again in ${data.retry_after_sec}s.` : '';
    if (String(data.error).toLowerCase().includes('too many')) {
      throw new Error(`Search is temporarily limited.${retry}`);
    }
    throw new Error(String(data.error));
  }

  const users = (data?.users ?? []) as Array<Record<string, unknown>>;
  return users.map((row) => ({
    wallet_address: String(row.wallet_address),
    username: row.username ? String(row.username) : null,
    display_name: row.display_name ? String(row.display_name) : null,
    avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    avatar_seed: row.avatar_seed ? String(row.avatar_seed) : null,
    follower_count: Number(row.follower_count ?? 0),
    creator_verification_state: row.creator_verification_state
      ? String(row.creator_verification_state)
      : null,
    verified: row.creator_verification_state === 'verified',
  }));
}
