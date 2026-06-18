import type { Keypair } from '@solana/web3.js';
import { invokeCreatorFunction } from './creator-api';
import { supabase } from './supabase';

export interface FollowStatus {
  following: boolean;
  notify_new_works: boolean;
  follower_count: number;
  verified: boolean;
  creator_verified_at: string | null;
}

export async function getFollowStatus(
  keypair: Keypair,
  creatorWallet: string,
): Promise<FollowStatus> {
  return invokeCreatorFunction<FollowStatus>('follow-creator', 'creator-follow', keypair, {
    action: 'status',
    creator_wallet: creatorWallet,
  });
}

export async function followCreator(
  keypair: Keypair,
  creatorWallet: string,
  notifyNewWorks = true,
): Promise<FollowStatus> {
  return invokeCreatorFunction<FollowStatus>('follow-creator', 'creator-follow', keypair, {
    action: 'follow',
    creator_wallet: creatorWallet,
    notify_new_works: notifyNewWorks,
  });
}

export async function unfollowCreator(
  keypair: Keypair,
  creatorWallet: string,
): Promise<FollowStatus> {
  return invokeCreatorFunction<FollowStatus>('follow-creator', 'creator-follow', keypair, {
    action: 'unfollow',
    creator_wallet: creatorWallet,
  });
}

/** Read-only follow check — no Face ID / wallet signature required. */
export async function isFollowingCreator(
  followerWallet: string,
  creatorWallet: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('creator_follows')
    .select('follower_wallet')
    .eq('follower_wallet', followerWallet)
    .eq('creator_wallet', creatorWallet)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export async function getFollowerCount(creatorWallet: string): Promise<number> {
  const { count, error } = await supabase
    .from('creator_follows')
    .select('*', { count: 'exact', head: true })
    .eq('creator_wallet', creatorWallet);
  if (error) return 0;
  return count ?? 0;
}

export interface FollowedCreator {
  creator_wallet: string;
  username: string | null;
  display_name: string | null;
  avatar_seed: string | null;
  avatar_url: string | null;
  followed_at: string;
}

export async function getFollowingList(followerWallet: string, limit = 50): Promise<FollowedCreator[]> {
  const { data: follows, error } = await supabase
    .from('creator_follows')
    .select('creator_wallet, created_at')
    .eq('follower_wallet', followerWallet)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!follows?.length) return [];

  const wallets = follows.map((f) => f.creator_wallet);
  const [usernames, profiles] = await Promise.all([
    supabase.from('sakura_usernames').select('wallet_address, username, display_name').in('wallet_address', wallets),
    supabase.from('user_profiles').select('wallet_address, display_name, avatar_seed, avatar_url').in('wallet_address', wallets),
  ]);

  const usernameByWallet = new Map((usernames.data ?? []).map((u) => [u.wallet_address, u]));
  const profileByWallet = new Map((profiles.data ?? []).map((p) => [p.wallet_address, p]));

  return follows.map((f) => {
    const u = usernameByWallet.get(f.creator_wallet);
    const p = profileByWallet.get(f.creator_wallet);
    return {
      creator_wallet: f.creator_wallet,
      username: u?.username ?? null,
      display_name: p?.display_name ?? u?.display_name ?? null,
      avatar_seed: p?.avatar_seed ?? null,
      avatar_url: p?.avatar_url ?? null,
      followed_at: f.created_at,
    };
  });
}
