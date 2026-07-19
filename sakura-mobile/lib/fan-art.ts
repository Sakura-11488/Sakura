import type { Keypair } from '@solana/web3.js';
import { supabase } from '@/lib/supabase';
import { buildWalletAuthHeaders, type WalletAuthHeaders } from '@/lib/wallet-auth';

/** Client for the AI Fan-Art Studio (generate-fan-art edge function). */

export type FanArtSubjectType = 'series' | 'character' | 'free';

export interface FanArtQuote {
  price_sakura: number;
  currency: string;
  payment_wallet: string;
  styles: string[];
  series: string[];
}

export interface FanArtItem {
  id: string;
  subject_type: string;
  series: string | null;
  character_name: string | null;
  style_preset: string;
  status: string;
  public_url: string | null;
  is_minted: boolean;
  created_at: string;
}

export interface GenerateFanArtInput {
  subjectType: FanArtSubjectType;
  series?: string;
  character?: string;
  freePrompt?: string;
  stylePreset?: string;
  paymentTxSignature?: string;
}

export function buildFanArtAuthHeaders(keypair: Keypair): WalletAuthHeaders {
  return buildWalletAuthHeaders(keypair, 'generate-fan-art');
}

async function invoke<T>(body: Record<string, unknown>, headers: WalletAuthHeaders): Promise<T> {
  const { data, error } = await supabase.functions.invoke('generate-fan-art', { body, headers });
  if (error) {
    let message = error.message || 'Request failed.';
    try {
      const ctx = (error as { context?: Response }).context;
      const parsed = ctx ? await ctx.json() : null;
      if (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error) {
        message = String((parsed as { error: string }).error);
      }
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error));
  }
  return data as T;
}

export function fetchFanArtQuote(headers: WalletAuthHeaders): Promise<FanArtQuote> {
  return invoke<FanArtQuote>({ action: 'quote' }, headers);
}

export async function listFanArt(headers: WalletAuthHeaders): Promise<FanArtItem[]> {
  const data = await invoke<{ items: FanArtItem[] }>({ action: 'list' }, headers);
  return data.items ?? [];
}

export function generateFanArt(
  input: GenerateFanArtInput,
  headers: WalletAuthHeaders,
): Promise<{ id: string; status: string; public_url: string | null }> {
  return invoke(
    {
      action: 'generate',
      subject_type: input.subjectType,
      series: input.series,
      character: input.character,
      free_prompt: input.freePrompt,
      style_preset: input.stylePreset,
      payment_tx_signature: input.paymentTxSignature,
    },
    headers,
  );
}

export function setFanArtAsAvatar(id: string, headers: WalletAuthHeaders): Promise<{ ok: boolean; public_url: string }> {
  return invoke({ action: 'set-avatar', generation_id: id }, headers);
}

export function setFanArtAsBanner(id: string, headers: WalletAuthHeaders): Promise<{ ok: boolean; public_url: string }> {
  return invoke({ action: 'set-banner', generation_id: id }, headers);
}
