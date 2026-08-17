import { supabase } from './supabase';
import { getOrRefreshWalletAuthSession } from './wallet-auth-session';
import { unlockForAppSession } from './wallet/app-session';

/**
 * Writing your own profile.
 *
 * This used to be a direct `supabase.from('user_profiles').upsert(...)` with the
 * anon key, in four places. That worked because the table's only policy was
 * `FOR ALL TO public USING (true)` — which also meant anyone holding the anon
 * key could rewrite anybody's row, including `creator_verification_state`, which
 * `creator-coin-launch` reads as its authorization gate.
 *
 * The table is now service-role for writes and public for reads, so profile
 * edits go through the `upsert-profile` edge function, which takes the wallet
 * from an Ed25519 signature rather than from the payload and accepts only the
 * three fields a user is allowed to set.
 *
 * Reads are unchanged and still go direct — profiles are public by design.
 *
 * Lives in its own module rather than in `lib/supabase.ts` because the auth
 * session pulls in the realtime session, which imports `supabase` — putting
 * this there would close an import cycle at module-init time.
 */

/**
 * @param walletAddress Advisory only. The server uses the wallet it verified
 *   from the signature; passing someone else's address here does nothing.
 */
export async function upsertProfile(
  walletAddress: string,
  displayName: string | null,
  bio: string | null,
  _email?: string | null,
): Promise<void> {
  // unlockForAppSession, not getWalletWithBiometrics: editing a bio is not a
  // transaction, and a modal captioned "Confirm transaction" for one teaches
  // people to tap through confirmations without reading them.
  const headers = await getOrRefreshWalletAuthSession(unlockForAppSession, 'profile-upsert');

  const { data, error } = await supabase.functions.invoke('upsert-profile', {
    body: { display_name: displayName, bio, avatar_seed: walletAddress.slice(0, 8) },
    headers,
  });

  if (error) {
    // supabase-js hides the body on a non-2xx; dig out the server's own wording
    // so a 429 reads as "slow down" rather than a generic network failure.
    const res = (error as { context?: Response })?.context;
    if (res && typeof res.json === 'function') {
      try {
        const payload = await res.json();
        if (payload?.error) throw new Error(String(payload.error));
      } catch (inner) {
        if (inner instanceof Error && inner.message) throw inner;
      }
    }
    throw new Error(error.message || 'Could not save your profile.');
  }
  if (data?.error) throw new Error(String(data.error));
}
