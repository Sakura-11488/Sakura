import { supabase } from './supabase';
import {
  getCreatorProfile,
  isUsernameAvailable,
  validateUsername,
  type SakuraUsername,
} from './creator';

export type { SakuraUsername };

export async function getUsernameForWallet(walletAddress: string): Promise<SakuraUsername | null> {
  const { data, error } = await supabase
    .from('sakura_usernames')
    .select('*')
    .eq('wallet_address', walletAddress)
    .maybeSingle();
  if (error) throw error;
  return data as SakuraUsername | null;
}

export async function claimUsername(input: {
  walletAddress: string;
  username: string;
  displayName?: string;
}): Promise<SakuraUsername> {
  const usernameErr = validateUsername(input.username);
  if (usernameErr) throw new Error(usernameErr);

  const existing = await getUsernameForWallet(input.walletAddress);
  if (existing) throw new Error('You already have a Sakura username.');

  const available = await isUsernameAvailable(input.username);
  if (!available) throw new Error('That username is already taken.');

  const now = new Date().toISOString();
  const displayName = input.displayName?.trim() || input.username.trim();

  const { error: profileErr } = await supabase.from('user_profiles').upsert(
    {
      wallet_address: input.walletAddress,
      display_name: displayName,
      avatar_seed: input.walletAddress.slice(0, 8),
      updated_at: now,
    },
    { onConflict: 'wallet_address' },
  );
  if (profileErr) throw profileErr;

  const { data, error } = await supabase
    .from('sakura_usernames')
    .insert({
      wallet_address: input.walletAddress,
      username: input.username.trim(),
      display_name: displayName,
      updated_at: now,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data as SakuraUsername;
}

export { validateUsername, isUsernameAvailable, getCreatorProfile };
