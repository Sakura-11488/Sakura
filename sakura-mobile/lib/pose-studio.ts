import type { Keypair } from '@solana/web3.js';
import { supabase } from '@/lib/supabase';
import { buildWalletAuthHeaders, type WalletAuthHeaders } from '@/lib/wallet-auth';
import { prepareImageBase64 } from '@/lib/prepare-image';

/**
 * Client for Pose Studio — the image-to-image half of the fan-art edge function.
 * Uploads a photo, gets it restaged into a chosen pose and setting.
 */

export interface PosePreset {
  id: string;
  label: string;
  blurb: string;
}

export interface PoseQuote {
  price_sakura: number;
  currency: string;
  payment_wallet: string;
  poses: PosePreset[];
  max_upload_bytes: number;
}

export interface PoseResult {
  ok: boolean;
  id: string;
  status: string;
  public_url: string | null;
}

export function buildPoseAuthHeaders(keypair: Keypair): WalletAuthHeaders {
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

/** The pose fields ride on the shared fan-art quote. */
export async function fetchPoseQuote(headers: WalletAuthHeaders): Promise<PoseQuote> {
  const q = await invoke<{
    pose_price_sakura: number;
    currency: string;
    payment_wallet: string;
    poses: PosePreset[];
    max_upload_bytes: number;
  }>({ action: 'quote' }, headers);
  return {
    price_sakura: q.pose_price_sakura,
    currency: q.currency,
    payment_wallet: q.payment_wallet,
    poses: q.poses ?? [],
    max_upload_bytes: q.max_upload_bytes,
  };
}

/**
 * Downscale + encode the picked photo, then run the edit. The resize happens
 * client-side so a 12 MP camera roll shot doesn't hit the server's size cap —
 * Kontext gains nothing from the extra pixels anyway.
 */
export async function generatePose(
  input: {
    imageUri: string;
    poseId: string;
    hint?: string;
    paymentTxSignature?: string;
  },
  headers: WalletAuthHeaders,
): Promise<PoseResult> {
  const prepared = await prepareImageBase64(input.imageUri);
  return invoke<PoseResult>(
    {
      action: 'pose',
      image_base64: prepared.base64,
      image_content_type: prepared.mimeType,
      pose_id: input.poseId,
      hint: input.hint,
      payment_tx_signature: input.paymentTxSignature,
    },
    headers,
  );
}
