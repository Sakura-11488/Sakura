import { supabase } from './supabase';
import { upsertProfile } from './profile-write';
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
  // Validate locally for a fast, friendly error — but the server re-checks
  // everything. These checks used to BE the enforcement, which they cannot be:
  // sakura_usernames was INSERT/UPDATE-open to anon, so anyone could skip them.
  // The handle is now claimed inside upsert-profile against the verified wallet,
  // where the unique index on lower(username) settles races between two people
  // who both passed an availability check a moment earlier.
  const usernameErr = validateUsername(input.username);
  if (usernameErr) throw new Error(usernameErr);

  const existing = await getUsernameForWallet(input.walletAddress);
  if (existing) throw new Error('You already have a Sakura username.');

  const available = await isUsernameAvailable(input.username);
  if (!available) throw new Error('That username is already taken.');

  const displayName = input.displayName?.trim() || input.username.trim();
  await upsertProfile(input.walletAddress, displayName, null, null, input.username.trim());

  const claimed = await getUsernameForWallet(input.walletAddress);
  if (!claimed) throw new Error('Could not claim that username.');
  return claimed;
}

export { validateUsername, isUsernameAvailable, getCreatorProfile };
