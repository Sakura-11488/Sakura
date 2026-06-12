import { supabase } from './supabase';
import { getWalletWithBiometrics } from './wallet/storage';
import { buildWalletAuthHeaders } from './wallet-auth';

export const MINT_TYPES = ['collectible', 'supporter', 'limited_edition'] as const;
export type MintType = (typeof MINT_TYPES)[number];
export type MintScope = 'work' | 'release';
export type MintStatus =
  | 'disabled'
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'live'
  | 'paused'
  | 'sold_out'
  | 'ended';

export interface WorkMintRecord {
  id: string;
  work_id?: string | null;
  release_id?: string | null;
  creator_wallet: string;
  mint_scope: MintScope;
  mint_type: MintType;
  status: MintStatus;
  collection_address?: string | null;
  tree_address?: string | null;
  mint_address?: string | null;
  metadata_uri: string;
  max_supply?: number | null;
  minted_count: number;
  mint_price: number;
  currency: string;
  setup_tx_signature?: string | null;
  verified_at?: string | null;
  created_at: string;
  updated_at: string;
}

const PUBLIC_MINT_STATUSES: MintStatus[] = ['approved', 'live', 'sold_out', 'ended'];

/** Public read of mint records for a work or release (approved/live only). */
export async function getWorkMintRecords(input: {
  workId?: string;
  releaseId?: string;
  includeAllStatuses?: boolean;
}): Promise<WorkMintRecord[]> {
  let query = supabase.from('work_mints').select('*').order('updated_at', { ascending: false });

  if (input.releaseId) query = query.eq('release_id', input.releaseId);
  else if (input.workId) query = query.eq('work_id', input.workId);
  else return [];

  if (!input.includeAllStatuses) query = query.in('status', PUBLIC_MINT_STATUSES);

  const { data, error } = await query;
  if (error) {
    if (__DEV__) console.warn('[creator-mints] getWorkMintRecords:', error.message);
    return [];
  }
  return (data as WorkMintRecord[]) || [];
}

/** A work is collectible if it has at least one publicly-visible mint. */
export async function isWorkCollectible(workId: string): Promise<boolean> {
  const mints = await getWorkMintRecords({ workId });
  return mints.length > 0;
}

export interface VerifyMintIntentInput {
  workId?: string;
  releaseId?: string;
  mintScope: MintScope;
  mintType: MintType;
  metadataUri: string;
  txSignature: string;
  mintPrice?: number;
  maxSupply?: number | null;
  currency?: string;
  collectionAddress?: string;
  treeAddress?: string;
  mintAddress?: string;
}

export interface VerifyMintResult {
  success: boolean;
  mint?: WorkMintRecord;
  error?: string;
}

/**
 * Verify a creator mint setup transaction. Writes to `work_mints` are
 * server-mediated: the client never writes the privileged row directly. The
 * endpoint (Next.js API route or a future edge function) re-checks the on-chain
 * transaction with the service role before persisting.
 */
export async function verifyCreatorMint(
  input: VerifyMintIntentInput,
  walletAddress: string,
): Promise<VerifyMintResult> {
  const endpoint = process.env.EXPO_PUBLIC_MINTS_VERIFY_URL;
  if (!endpoint) {
    return {
      success: false,
      error: 'Mint verification service is not configured for this build.',
    };
  }
  try {
    const keypair = await getWalletWithBiometrics();
    if (!keypair) {
      return { success: false, error: 'Could not unlock wallet for mint verification.' };
    }
    if (keypair.publicKey.toBase58() !== walletAddress) {
      return { success: false, error: 'Unlocked wallet does not match the creator wallet.' };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildWalletAuthHeaders(keypair, 'creator-mint-verify'),
      },
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as { mint?: WorkMintRecord; error?: string };
    if (!res.ok) return { success: false, error: json.error || `Verification failed (${res.status})` };
    return { success: true, mint: json.mint };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Verification request failed' };
  }
}
