import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Favorite {
  id: string;
  wallet_address: string;
  content_id: string;
  content_type: 'anime' | 'manga' | 'novel';
  title: string;
  cover_url: string;
  created_at: string;
}

export async function getFavorites(walletAddress: string): Promise<Favorite[]> {
  const { data, error } = await supabase
    .from('favorites')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function addFavorite(fav: Omit<Favorite, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('favorites').insert(fav);
  if (error) throw error;
}

export async function removeFavorite(walletAddress: string, contentId: string): Promise<void> {
  const { error } = await supabase
    .from('favorites')
    .delete()
    .eq('wallet_address', walletAddress)
    .eq('content_id', contentId);
  if (error) throw error;
}

export interface UserProfile {
  wallet_address: string;
  display_name: string | null;
  bio: string | null;
  email: string | null;
  avatar_url: string | null;
  avatar_seed: string | null;
  avatar_mint_address?: string | null;
  avatar_generation_id?: string | null;
  updated_at: string;
}

export async function getProfile(walletAddress: string): Promise<UserProfile | null> {
  const { data } = await supabase
    .from('user_profiles')
    .select('wallet_address, display_name, bio, avatar_url, avatar_seed, avatar_mint_address, avatar_generation_id, updated_at')
    .eq('wallet_address', walletAddress)
    .maybeSingle();
  if (!data) return null;
  return {
    wallet_address: data.wallet_address,
    display_name: data.display_name,
    bio: data.bio,
    email: null,
    avatar_url: data.avatar_url ?? null,
    avatar_seed: data.avatar_seed ?? walletAddress.slice(0, 8),
    avatar_mint_address: data.avatar_mint_address ?? null,
    avatar_generation_id: data.avatar_generation_id ?? null,
    updated_at: data.updated_at ?? new Date().toISOString(),
  };
}

// upsertProfile moved to lib/profile-write.ts — user_profiles is no longer
// writable with the anon key, so profile edits go through the upsert-profile
// edge function. Re-exported here so existing imports keep working.
export { upsertProfile } from './profile-write';

/**
 * Reading history lives in `lib/reading-history.ts`. Use that.
 *
 * A `ReadingHistory` interface and an `updateHistory()` helper used to sit here
 * and described a table that does not exist. It declared content_id,
 * content_type and progress; the actual `reading_history` table is
 * (id, wallet_address, manga_id, chapter_id, last_page, updated_at).
 *
 * It could never have worked, not merely written the wrong columns: `manga_id`
 * and `id` are both NOT NULL with no default and no sequence, so every call
 * would have thrown on the insert. Nothing ever called it — which is why the
 * breakage was invisible, and why the table sat at zero rows.
 *
 * Removed rather than repaired. A fixed-up version would still have had no
 * callers, and a plausible-looking helper next to the real one is how someone
 * ends up writing through the wrong path a year from now.
 *
 * Note for anyone reading a profile's `chaptersRead`: `lib/profile-stats.ts`
 * derives it from a bare row count on `reading_history`, so it reported 0 for
 * every user while that table was empty. It is schema-agnostic and was never
 * broken — just empty.
 */
