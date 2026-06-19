import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { buildAvatarMetadata } from '../_shared/avatar-metadata.ts';
import { generateFluxImage } from '../_shared/flux.ts';
import { mintAvatarNft } from '../_shared/mint-avatar-nft.ts';
import { buildAvatarPrompt, sanitizeUserHint } from '../_shared/mappa-style.ts';
import { buildTasteSnapshot } from '../_shared/taste-profile.ts';
import {
  avatarMintPriceSakura,
  verifyAvatarSakuraPayment,
} from '../_shared/verify-sakura-payment.ts';
import { corsHeaders, isWallet, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type GenerateBody = {
  action?: 'generate' | 'status' | 'quote' | 'eligibility' | 'list' | 'select';
  mode?: 'tastes' | 'general';
  hint?: string;
  generation_id?: string;
  payment_tx_signature?: string;
  recipient_wallet?: string;
  admin_test_secret?: string;
};

type MintContext = {
  walletAddress: string;
  paymentBypass: boolean;
};

function resolveMintContext(req: Request, body: GenerateBody): MintContext {
  const configuredSecret = Deno.env.get('AVATAR_ADMIN_TEST_SECRET')?.trim();
  const providedSecret =
    body.admin_test_secret?.trim() || req.headers.get('x-avatar-admin-test')?.trim() || '';
  const recipient = body.recipient_wallet?.trim();

  if (configuredSecret && providedSecret === configuredSecret && recipient && isWallet(recipient)) {
    return { walletAddress: recipient, paymentBypass: true };
  }

  const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
  return { walletAddress, paymentBypass: false };
}

const cors = corsHeaders();
const RATE_LIMIT_HOURS = Number(Deno.env.get('AVATAR_RATE_LIMIT_HOURS') || '24');
const MODEL = Deno.env.get('FAL_FLUX_MODEL')?.trim() || Deno.env.get('BFL_FLUX_MODEL')?.trim() || 'fal-ai/flux/dev';

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function avatarNftName(mode: string): string {
  return mode === 'tastes' ? 'Sakura Taste Avatar' : 'Sakura Anime Avatar';
}

async function listReadyMints(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  activeGenerationId?: string | null,
) {
  const { data, error } = await supabase
    .from('user_avatar_generations')
    .select('id, mint_address, public_url, mode, created_at')
    .eq('wallet_address', walletAddress)
    .eq('status', 'ready')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    mint_address: row.mint_address ?? null,
    public_url: row.public_url ?? null,
    mode: row.mode as string,
    created_at: row.created_at as string,
    is_active: Boolean(activeGenerationId && row.id === activeGenerationId),
  }));
}

async function buildEligibility(
  supabase: ReturnType<typeof createClient>,
  walletAddress: string,
  mintPrice: number,
) {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('avatar_mint_address, avatar_url, avatar_generation_id')
    .eq('wallet_address', walletAddress)
    .maybeSingle();

  const { data: recent } = await supabase
    .from('user_avatar_generations')
    .select('created_at, status')
    .eq('wallet_address', walletAddress)
    .in('status', ['queued', 'processing', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let retryAfterHours = 0;
  if (recent?.created_at) {
    const elapsed = hoursSince(recent.created_at);
    if (elapsed < RATE_LIMIT_HOURS) {
      retryAfterHours = Math.max(1, Math.ceil(RATE_LIMIT_HOURS - elapsed));
    }
  }

  const mints = await listReadyMints(supabase, walletAddress, profile?.avatar_generation_id ?? null);

  return {
    price_sakura: mintPrice,
    currency: 'SAKURA',
    rate_limit_hours: RATE_LIMIT_HOURS,
    can_mint: retryAfterHours === 0,
    already_minted: mints.length > 0,
    mint_count: mints.length,
    active_generation_id: profile?.avatar_generation_id ?? null,
    mint_address: profile?.avatar_mint_address ?? null,
    avatar_url: profile?.avatar_url ?? null,
    retry_after_hours: retryAfterHours,
    mints,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const body = (await req.json()) as GenerateBody;
    const action = body.action ?? 'generate';
    const mintPrice = avatarMintPriceSakura();

    if (action === 'quote') {
      return jsonResponse(200, {
        price_sakura: mintPrice,
        currency: 'SAKURA',
        rate_limit_hours: RATE_LIMIT_HOURS,
      }, cors);
    }

    if (action === 'eligibility' || action === 'list') {
      const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      const payload = await buildEligibility(supabase, walletAddress, mintPrice);
      return jsonResponse(200, payload, cors);
    }

    if (action === 'select') {
      const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-avatar');
      const generationId = body.generation_id?.trim();
      if (!generationId) return jsonResponse(400, { error: 'generation_id is required.' }, cors);

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );

      const { data: generation, error } = await supabase
        .from('user_avatar_generations')
        .select('id, wallet_address, public_url, mint_address, status')
        .eq('id', generationId)
        .eq('wallet_address', walletAddress)
        .maybeSingle();

      if (error) return jsonResponse(500, { error: error.message }, cors);
      if (!generation || generation.status !== 'ready') {
        return jsonResponse(404, { error: 'Avatar mint not found.' }, cors);
      }

      const now = new Date().toISOString();
      await supabase.from('user_profiles').upsert(
        {
          wallet_address: walletAddress,
          avatar_url: generation.public_url,
          avatar_mint_address: generation.mint_address,
          avatar_generation_id: generation.id,
          avatar_seed: walletAddress.slice(0, 8),
          updated_at: now,
        },
        { onConflict: 'wallet_address' },
      );

      return jsonResponse(200, {
        generation_id: generation.id,
        mint_address: generation.mint_address,
        public_url: generation.public_url,
      }, cors);
    }

    const { walletAddress, paymentBypass } = resolveMintContext(req, body);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (action === 'status') {
      const generationId = body.generation_id?.trim();
      if (!generationId) return jsonResponse(400, { error: 'generation_id is required.' }, cors);

      const { data, error } = await supabase
        .from('user_avatar_generations')
        .select(
          'id, status, public_url, metadata_uri, mint_address, mint_tx_signature, payment_tx_signature, payment_amount_sakura, error_message, taste_snapshot, mode, created_at, completed_at',
        )
        .eq('id', generationId)
        .eq('wallet_address', walletAddress)
        .maybeSingle();

      if (error) return jsonResponse(500, { error: error.message }, cors);
      if (!data) return jsonResponse(404, { error: 'Generation not found.' }, cors);

      return jsonResponse(200, data, cors);
    }

    let paymentTxSignature = body.payment_tx_signature?.trim();
    let chargedSakura = mintPrice;

    if (paymentBypass) {
      paymentTxSignature = `dev-bypass-${crypto.randomUUID()}`;
      chargedSakura = 0;
    } else if (!paymentTxSignature) {
      return jsonResponse(400, {
        error: `A confirmed SAKURA payment of ${mintPrice.toLocaleString()} is required.`,
        price_sakura: mintPrice,
      }, cors);
    }

    if (!paymentBypass) {
      const { data: recent } = await supabase
        .from('user_avatar_generations')
        .select('created_at, status')
        .eq('wallet_address', walletAddress)
        .in('status', ['queued', 'processing', 'ready'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recent?.created_at && hoursSince(recent.created_at) < RATE_LIMIT_HOURS) {
        const retryHours = Math.max(1, Math.ceil(RATE_LIMIT_HOURS - hoursSince(recent.created_at)));
        return jsonResponse(429, {
          error: `You can mint again in about ${retryHours} hour(s).`,
          retry_after_hours: retryHours,
        }, cors);
      }
    }

    const { data: usedPayment } = await supabase
      .from('user_avatar_generations')
      .select('id, wallet_address, status')
      .eq('payment_tx_signature', paymentTxSignature)
      .maybeSingle();

    if (usedPayment && !paymentBypass) {
      if (usedPayment.wallet_address === walletAddress && usedPayment.status === 'ready') {
        return jsonResponse(409, { error: 'This payment was already used for a mint.', id: usedPayment.id }, cors);
      }
      return jsonResponse(400, { error: 'Payment transaction already claimed.' }, cors);
    }

    if (!paymentBypass) {
      await verifyAvatarSakuraPayment({
        signature: paymentTxSignature!,
        expectedPayer: walletAddress,
        minAmountSakura: mintPrice,
      });
    }

    const mode = body.mode === 'general' ? 'general' : 'tastes';
    const userHint = sanitizeUserHint(body.hint);

    const taste = await buildTasteSnapshot(supabase, walletAddress);
    const prompt = buildAvatarPrompt({ mode, taste, userHint });

    const { data: generation, error: insertError } = await supabase
      .from('user_avatar_generations')
      .insert({
        wallet_address: walletAddress,
        mode,
        status: 'processing',
        taste_snapshot: taste,
        prompt_snapshot: prompt,
        model: MODEL,
        payment_tx_signature: paymentTxSignature,
        payment_amount_sakura: chargedSakura,
      })
      .select('id')
      .single();

    if (insertError || !generation) {
      return jsonResponse(500, { error: insertError?.message || 'Could not start mint.' }, cors);
    }

    const generationId = generation.id as string;
    const imagePath = `${walletAddress}/${generationId}.png`;
    const metadataPath = `${walletAddress}/${generationId}.json`;

    try {
      const bytes = await generateFluxImage(prompt);
      const { error: uploadError } = await supabase.storage
        .from('user-avatars')
        .upload(imagePath, bytes, {
          contentType: 'image/png',
          upsert: true,
          cacheControl: '3600',
        });
      if (uploadError) throw new Error(uploadError.message);

      const { data: imagePublic } = supabase.storage.from('user-avatars').getPublicUrl(imagePath);
      const imageUrl = imagePublic.publicUrl;

      const metadata = buildAvatarMetadata({
        name: avatarNftName(mode),
        symbol: 'SKRAV',
        description:
          'MAPPA-style Jujutsu Kaisen-inspired anime portrait minted on Sakura. One wallet-bound collectible.',
        imageUrl,
        walletAddress,
        mode,
        vibe: taste.vibe ?? 'Sakura reader',
        topGenres: taste.top_genres,
      });

      const { error: metadataUploadError } = await supabase.storage
        .from('user-avatars')
        .upload(metadataPath, JSON.stringify(metadata), {
          contentType: 'application/json',
          upsert: true,
          cacheControl: '3600',
        });
      if (metadataUploadError) throw new Error(metadataUploadError.message);

      const { data: metadataPublic } = supabase.storage.from('user-avatars').getPublicUrl(metadataPath);
      const metadataUri = metadataPublic.publicUrl;

      const minted = await mintAvatarNft({
        recipientWallet: walletAddress,
        metadataUri,
        name: metadata.name,
        symbol: metadata.symbol,
      });

      const completedAt = new Date().toISOString();
      await supabase
        .from('user_avatar_generations')
        .update({
          status: 'ready',
          storage_path: imagePath,
          public_url: imageUrl,
          metadata_uri: metadataUri,
          mint_address: minted.mintAddress,
          mint_tx_signature: minted.signature,
          completed_at: completedAt,
        })
        .eq('id', generationId);

      await supabase
        .from('user_profiles')
        .upsert(
          {
            wallet_address: walletAddress,
            avatar_url: imageUrl,
            avatar_generation_id: generationId,
            avatar_mint_address: minted.mintAddress,
            avatar_seed: walletAddress.slice(0, 8),
            updated_at: completedAt,
          },
          { onConflict: 'wallet_address' },
        );

      return jsonResponse(
        200,
        {
          id: generationId,
          status: 'ready',
          public_url: imageUrl,
          metadata_uri: metadataUri,
          mint_address: minted.mintAddress,
          mint_tx_signature: minted.signature,
          payment_tx_signature: paymentTxSignature,
          payment_amount_sakura: chargedSakura,
          taste_snapshot: taste,
          mode,
        },
        cors,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Avatar mint failed.';
      await supabase
        .from('user_avatar_generations')
        .update({
          status: 'failed',
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', generationId);

      return jsonResponse(502, { error: message, id: generationId }, cors);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Avatar mint failed.';
    const status = message.includes('wallet') || message.includes('signature') || message.includes('expired')
      ? 401
      : message.includes('Payment') || message.includes('SAKURA') || message.includes('payment')
      ? 402
      : message.includes('not allowed') ? 400 : 500;
    return jsonResponse(status, { error: message }, cors);
  }
});
