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

export interface ReadingHistory {
  wallet_address: string;
  content_id: string;
  content_type: 'anime' | 'manga' | 'novel';
  chapter_id: string;
  progress: number;
  updated_at: string;
}

export async function updateHistory(entry: Omit<ReadingHistory, 'updated_at'>): Promise<void> {
  const { error } = await supabase.from('reading_history').upsert({
    ...entry,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
