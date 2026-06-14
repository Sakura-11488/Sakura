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

export function resolveAvatarUri(profile: AvatarProfileFields): string {
  if (profile.avatar_url?.trim()) return profile.avatar_url.trim();
  const seed = profile.avatar_seed?.trim() || profile.wallet_address.slice(0, 8);
  return `https://robohash.org/${encodeURIComponent(seed)}?set=set4&bgset=bg1`;
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
