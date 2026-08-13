import { supabase } from './supabase';
import { buildWalletAuthHeaders, type WalletAuthHeaders } from './wallet-auth';
import { AVATAR_MINT_PRICE_SAKURA } from './wallet/config';

export type AvatarGenerationMode = 'tastes' | 'general';

export interface AvatarGenerationResult {
  id: string;
  status: 'ready' | 'failed' | 'processing' | 'queued' | 'rejected';
  public_url?: string | null;
  metadata_uri?: string | null;
  mint_address?: string | null;
  mint_tx_signature?: string | null;
  payment_tx_signature?: string | null;
  payment_amount_sakura?: number;
  taste_snapshot?: {
    top_genres?: string[];
    top_titles?: string[];
    content_mix?: string[];
    vibe?: string;
  };
  mode?: AvatarGenerationMode;
  error?: string;
}

export interface AvatarProfileFields {
  avatar_url?: string | null;
  avatar_seed?: string | null;
  avatar_mint_address?: string | null;
  wallet_address: string;
}

export interface AvatarMintQuote {
  price_sakura: number;
  currency: string;
  rate_limit_hours: number;
}

export interface AvatarMintItem {
  id: string;
  mint_address: string | null;
  public_url: string | null;
  mode: AvatarGenerationMode;
  created_at: string;
  is_active: boolean;
}

export interface AvatarMintEligibility extends AvatarMintQuote {
  can_mint: boolean;
  already_minted: boolean;
  mint_count: number;
  active_generation_id: string | null;
  mint_address: string | null;
  avatar_url: string | null;
  retry_after_hours: number;
  mints: AvatarMintItem[];
}

export function resolveAvatarUri(profile: AvatarProfileFields): string {
  if (profile.avatar_url?.trim()) return profile.avatar_url.trim();
  const seed = profile.wallet_address.trim() || profile.avatar_seed?.trim() || 'sakura';
  return `https://robohash.org/${encodeURIComponent(seed)}?set=set4&bgset=bg1`;
}

export function hasMintedAvatar(profile: AvatarProfileFields): boolean {
  return Boolean(profile.avatar_url?.trim() || profile.avatar_mint_address?.trim());
}

export function walletAccentColor(wallet: string): string {
  let hash = 0;
  for (let i = 0; i < wallet.length; i += 1) {
    hash = wallet.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 52%)`;
}

async function parseInvokeError(error: { message?: string; context?: Response }): Promise<string> {
  if (error.context) {
    try {
      const body = await error.context.json();
      if (body?.error) return String(body.error);
      if (body?.retry_after_hours) {
        return `${body.error ?? 'Rate limited.'} Try again in about ${body.retry_after_hours} hour(s).`;
      }
    } catch {
      // Fall through to generic message.
    }
  }
  return error.message || 'Avatar mint failed.';
}

export async function fetchAvatarMintEligibility(
  authHeaders: WalletAuthHeaders,
): Promise<AvatarMintEligibility> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'eligibility' },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return {
    price_sakura: Number(data?.price_sakura ?? AVATAR_MINT_PRICE_SAKURA),
    currency: String(data?.currency ?? 'SAKURA'),
    rate_limit_hours: Number(data?.rate_limit_hours ?? 24),
    can_mint: Boolean(data?.can_mint),
    already_minted: Boolean(data?.already_minted),
    mint_count: Number(data?.mint_count ?? 0),
    active_generation_id: data?.active_generation_id ?? null,
    mint_address: data?.mint_address ?? null,
    avatar_url: data?.avatar_url ?? null,
    retry_after_hours: Number(data?.retry_after_hours ?? 0),
    mints: Array.isArray(data?.mints) ? (data.mints as AvatarMintItem[]) : [],
  };
}

export async function listAvatarMints(authHeaders: WalletAuthHeaders): Promise<AvatarMintItem[]> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'list' },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return Array.isArray(data?.mints) ? (data.mints as AvatarMintItem[]) : [];
}

export async function selectAvatarMint(
  authHeaders: WalletAuthHeaders,
  generationId: string,
): Promise<{ mint_address: string | null; public_url: string | null; generation_id: string }> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'select', generation_id: generationId },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return {
    generation_id: String(data?.generation_id ?? generationId),
    mint_address: data?.mint_address ?? null,
    public_url: data?.public_url ?? null,
  };
}

export async function fetchAvatarMintQuote(): Promise<AvatarMintQuote> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'quote' },
  });
  if (error) throw new Error(await parseInvokeError(error));
  return {
    price_sakura: Number(data?.price_sakura ?? AVATAR_MINT_PRICE_SAKURA),
    currency: String(data?.currency ?? 'SAKURA'),
    rate_limit_hours: Number(data?.rate_limit_hours ?? 24),
  };
}

export async function generateUserAvatar(input: {
  mode: AvatarGenerationMode;
  paymentTxSignature: string;
  hint?: string;
  authHeaders: WalletAuthHeaders;
}): Promise<AvatarGenerationResult> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: {
      action: 'generate',
      mode: input.mode,
      hint: input.hint?.trim() || undefined,
      payment_tx_signature: input.paymentTxSignature,
    },
    headers: input.authHeaders,
  });

  if (error) {
    throw new Error(await parseInvokeError(error));
  }

  if (data?.error) {
    throw new Error(String(data.error));
  }

  return data as AvatarGenerationResult;
}

export async function fetchAvatarGenerationStatus(input: {
  generationId: string;
  authHeaders: WalletAuthHeaders;
}): Promise<AvatarGenerationResult> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: {
      action: 'status',
      generation_id: input.generationId,
    },
    headers: input.authHeaders,
  });

  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return data as AvatarGenerationResult;
}

export function buildAvatarAuthHeaders(keypair: Parameters<typeof buildWalletAuthHeaders>[0]) {
  return buildWalletAuthHeaders(keypair, 'generate-avatar');
}

/**
 * A one-time apology grant: free avatars minted to a wallet that paid SAKURA and
 * received nothing. `resolved` is the server-side latch — once true the prompt
 * must never be shown again, on any device, after any reinstall.
 *
 * The unauthenticated status call deliberately carries NO generation ids, only
 * public image URLs, and performs no writes. Ids and the ability to resolve the
 * grant both require a wallet signature.
 */
export type AvatarApologyIncident = 'charged_without_delivery' | 'charged_twice_delivered_once';

export interface AvatarApologyGrantStatus {
  has_grant: boolean;
  resolved: boolean;
  /** False while the grant exists but its mints have not all landed yet. */
  ready: boolean;
  incident: AvatarApologyIncident;
  avatar_count: number;
  minted_count: number;
  /** What the user actually lost, in SAKURA. Drives the apology copy. */
  charged_sakura: number;
  /** SAKURA sent back manually. >0 changes the apology copy. */
  refund_sakura: number;
  /** How many avatars they DID receive for those payments. */
  received_count: number;
  granted_at: string | null;
  already_shown: boolean;
  preview_urls: string[];
}

export interface AvatarApologyGrantDetail extends AvatarApologyGrantStatus {
  avatars: AvatarMintItem[];
}

function normalizeGrant(data: Record<string, unknown> | null | undefined): AvatarApologyGrantStatus {
  const incident = data?.incident === 'charged_twice_delivered_once'
    ? 'charged_twice_delivered_once'
    : 'charged_without_delivery';
  return {
    has_grant: Boolean(data?.has_grant),
    resolved: Boolean(data?.resolved),
    ready: Boolean(data?.ready),
    incident,
    avatar_count: Number(data?.avatar_count ?? 0),
    minted_count: Number(data?.minted_count ?? 0),
    charged_sakura: Number(data?.charged_sakura ?? 0),
    refund_sakura: Number(data?.refund_sakura ?? 0),
    received_count: Number(data?.received_count ?? 0),
    granted_at: (data?.granted_at as string | null) ?? null,
    already_shown: Boolean(data?.already_shown),
    preview_urls: Array.isArray(data?.preview_urls) ? (data!.preview_urls as string[]) : [],
  };
}

/**
 * App-open check. Unauthenticated on purpose (same shape as
 * fetchGamificationState) so launching the app cannot raise an unlock prompt for
 * the overwhelming majority of users who have no grant. Swallows failures to
 * null: a background check must never throw into the UI.
 */
export async function fetchAvatarApologyGrantStatus(
  walletAddress: string,
): Promise<AvatarApologyGrantStatus | null> {
  try {
    const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
      body: { action: 'grant-status', wallet_address: walletAddress },
    });
    if (error || !data || (data as { error?: string }).error) return null;
    return normalizeGrant(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Signed fetch of the granted avatars. Calling this is what marks the apology as
 * SHOWN server-side, which is also what unlocks resolution — the grant cannot be
 * marked "decided" before this has happened.
 */
export async function fetchAvatarApologyGrantDetail(
  authHeaders: WalletAuthHeaders,
): Promise<AvatarApologyGrantDetail> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'grant-detail' },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return {
    ...normalizeGrant(data as Record<string, unknown>),
    avatars: Array.isArray(data?.avatars) ? (data.avatars as AvatarMintItem[]) : [],
  };
}

/**
 * Burn the apology prompt for good. Signed, so only the owner can dismiss their
 * own grant. Idempotent server-side: a second ack is a no-op and the first
 * resolution stays authoritative.
 */
export async function acknowledgeAvatarApologyGrant(
  authHeaders: WalletAuthHeaders,
  input: { resolution: 'selected' | 'dismissed'; generationId?: string | null },
): Promise<void> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: {
      action: 'grant-ack',
      resolution: input.resolution,
      ...(input.resolution === 'selected' && input.generationId
        ? { generation_id: input.generationId }
        : {}),
    },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
}
