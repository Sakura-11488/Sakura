import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, isWallet, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { generateFluxImage, editFluxImage } from '../_shared/flux.ts';
import { verifyAvatarSakuraPayment, avatarPaymentWallet } from '../_shared/verify-sakura-payment.ts';
import { buildFanArtPrompt, STYLE_PRESETS, FAN_ART_SERIES } from '../_shared/fan-art-prompt.ts';
import { buildPosePrompt, listPosePresets, DEFAULT_POSE } from '../_shared/pose-prompt.ts';

/**
 * AI Fan-Art Studio. Generate FLUX art of a chosen series/character (or a
 * sanitized free prompt), keep a per-wallet gallery, and set a piece as the
 * profile avatar/banner. Paid in SAKURA. Prompt is validated + moderated BEFORE
 * payment is required so a rejected prompt never charges. (NFT minting reuses
 * the avatar mint pipeline and lands in a follow-up `mint` action.)
 */

const cors = corsHeaders();
const MODEL = Deno.env.get('FAL_FLUX_MODEL')?.trim() || 'fal-ai/flux/dev';
const POSE_MODEL = Deno.env.get('FAL_KONTEXT_MODEL')?.trim() || 'fal-ai/flux-pro/kontext';

/** Decoded upload ceiling. Kontext bills per call either way, but a huge
 *  base64 payload is the one part of this request that can fail slowly. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function fanArtPrice(): number {
  const raw = Deno.env.get('FAN_ART_PRICE_SAKURA')?.trim();
  const parsed = raw ? Number(raw) : 50_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50_000;
}

/** Kontext costs more per call than flux/dev, so it gets its own knob. */
function posePrice(): number {
  const raw = Deno.env.get('POSE_PRICE_SAKURA')?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fanArtPrice();
}

type Body = {
  action?: 'quote' | 'generate' | 'list' | 'set-avatar' | 'set-banner' | 'pose';
  subject_type?: 'series' | 'character' | 'free';
  series?: string;
  character?: string;
  free_prompt?: string;
  style_preset?: string;
  payment_tx_signature?: string;
  generation_id?: string;
  admin_test_secret?: string;
  recipient_wallet?: string;
  /** pose: the source photo, as a data URI or bare base64. */
  image_base64?: string;
  image_content_type?: string;
  pose_id?: string;
  hint?: string;
};

/**
 * Accepts `data:image/png;base64,AAAA…` or bare base64. Returns the decoded
 * bytes and the content type, preferring the one declared in the data URI.
 */
function decodeUpload(raw: string, declaredType?: string): { bytes: Uint8Array; contentType: string } {
  let payload = raw.trim();
  let contentType = (declaredType || '').trim().toLowerCase();

  const match = /^data:([a-z0-9/+.-]+);base64,(.*)$/is.exec(payload);
  if (match) {
    contentType = match[1].toLowerCase();
    payload = match[2];
  }
  payload = payload.replace(/\s/g, '');
  if (!payload) throw new Error('No image was provided.');

  if (!contentType) contentType = 'image/jpeg';
  if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
    throw new Error('Upload a JPEG, PNG or WebP image.');
  }

  // Reject on the encoded length first — decoding an oversized payload just to
  // measure it is the expensive way to find out.
  if ((payload.length * 3) / 4 > MAX_UPLOAD_BYTES) {
    throw new Error('That image is too large. Use one under 8 MB.');
  }

  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw new Error('That image could not be read.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length === 0) throw new Error('That image is empty.');

  return { bytes, contentType };
}

function resolveCtx(req: Request, body: Body): { walletAddress: string; paymentBypass: boolean } {
  const secret = Deno.env.get('FAN_ART_ADMIN_TEST_SECRET')?.trim();
  const provided = body.admin_test_secret?.trim() || req.headers.get('x-avatar-admin-test')?.trim() || '';
  const recipient = body.recipient_wallet?.trim();
  if (secret && provided === secret && recipient && isWallet(recipient)) {
    return { walletAddress: recipient, paymentBypass: true };
  }
  const { walletAddress } = verifyWalletHeaders(req.headers, 'generate-fan-art');
  return { walletAddress, paymentBypass: false };
}

/**
 * Runs `produce`, stores the PNG, and flips the row to ready/failed. Shared by
 * `generate` and `pose` so a paid row can never be left stuck in `processing`
 * by only one of the two paths handling its errors.
 */
async function completeGeneration(
  supabase: ReturnType<typeof createClient>,
  genId: string,
  walletAddress: string,
  produce: () => Promise<Uint8Array>,
): Promise<Response> {
  try {
    const bytes = await produce();
    const path = `${walletAddress}/${genId}.png`;
    const { error: upErr } = await supabase.storage
      .from('fan-art')
      .upload(path, bytes, { contentType: 'image/png', upsert: true, cacheControl: '3600' });
    if (upErr) throw new Error(upErr.message);
    const { data: pub } = supabase.storage.from('fan-art').getPublicUrl(path);

    await supabase
      .from('fan_art_generations')
      .update({
        status: 'ready',
        storage_path: path,
        public_url: pub.publicUrl,
        completed_at: new Date().toISOString(),
      })
      .eq('id', genId);

    return jsonResponse(200, { ok: true, id: genId, status: 'ready', public_url: pub.publicUrl }, cors);
  } catch (genErr) {
    const message = genErr instanceof Error ? genErr.message : 'Generation failed.';
    const rejected = /moderat|not allowed|rejected/i.test(message);
    await supabase
      .from('fan_art_generations')
      .update({ status: rejected ? 'rejected' : 'failed', error_message: message })
      .eq('id', genId);
    return jsonResponse(rejected ? 400 : 502, { error: message, id: genId }, cors);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action || 'generate';
    const { walletAddress, paymentBypass } = resolveCtx(req, body);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (action === 'quote') {
      return jsonResponse(
        200,
        {
          price_sakura: fanArtPrice(),
          currency: 'SAKURA',
          payment_wallet: avatarPaymentWallet(),
          styles: Object.keys(STYLE_PRESETS),
          series: FAN_ART_SERIES,
          pose_price_sakura: posePrice(),
          poses: listPosePresets(),
          max_upload_bytes: MAX_UPLOAD_BYTES,
        },
        cors,
      );
    }

    if (action === 'list') {
      const { data } = await supabase
        .from('fan_art_generations')
        .select('id, subject_type, series, character_name, style_preset, status, public_url, is_minted, created_at')
        .eq('wallet_address', walletAddress)
        .in('status', ['ready', 'processing'])
        .order('created_at', { ascending: false })
        .limit(60);
      return jsonResponse(200, { items: data ?? [] }, cors);
    }

    if (action === 'set-avatar' || action === 'set-banner') {
      const id = String(body.generation_id || '').trim();
      const { data: row } = await supabase
        .from('fan_art_generations')
        .select('id, public_url, status')
        .eq('id', id)
        .eq('wallet_address', walletAddress)
        .maybeSingle();
      if (!row || row.status !== 'ready' || !row.public_url) {
        return jsonResponse(404, { error: 'Artwork not found.' }, cors);
      }
      const patch =
        action === 'set-avatar'
          ? { wallet_address: walletAddress, avatar_url: row.public_url }
          : { wallet_address: walletAddress, banner_url: row.public_url, banner_fan_art_id: row.id };
      await supabase.from('user_profiles').upsert(patch, { onConflict: 'wallet_address' });
      return jsonResponse(200, { ok: true, public_url: row.public_url }, cors);
    }

    // ── action === 'pose' ── image-to-image: restage the user's own photo.
    if (action === 'pose') {
      // 1. Validate prompt + image BEFORE any charge, same ordering as generate.
      const posePrompt = buildPosePrompt({ poseId: body.pose_id, hint: body.hint });
      const poseId = body.pose_id || DEFAULT_POSE;
      if (!body.image_base64) return jsonResponse(400, { error: 'Upload a photo first.' }, cors);
      const upload = decodeUpload(body.image_base64, body.image_content_type);

      // 2. Rate limit — shares the daily bucket with fan art on purpose; this is
      //    the same wallet spending against the same image budget.
      const rl = await checkRateLimit(supabase, `fan-art:${walletAddress}`, 10, 86_400);
      if (!rl.allowed) {
        return jsonResponse(429, { error: 'Daily generation limit reached.', retryAfterSec: rl.retryAfterSec }, cors);
      }

      // 3. Payment.
      let chargedSakura = 0;
      const poseTx = body.payment_tx_signature?.trim() || null;
      if (!paymentBypass) {
        if (!poseTx) {
          return jsonResponse(402, { error: 'Payment required.', price_sakura: posePrice() }, cors);
        }
        const { data: used } = await supabase
          .from('fan_art_generations')
          .select('id')
          .eq('payment_tx_signature', poseTx)
          .maybeSingle();
        if (used) return jsonResponse(400, { error: 'This payment was already used.' }, cors);

        const verified = await verifyAvatarSakuraPayment({
          signature: poseTx,
          expectedPayer: walletAddress,
          minAmountSakura: posePrice(),
        });
        chargedSakura = verified.amount;
      }

      // 4. Insert processing row. The source photo is deliberately NOT stored —
      //    only the prompt and the result are kept.
      const { data: gen, error: insErr } = await supabase
        .from('fan_art_generations')
        .insert({
          wallet_address: walletAddress,
          subject_type: 'pose',
          free_prompt: body.hint ?? null,
          style_preset: poseId,
          status: 'processing',
          prompt_snapshot: posePrompt,
          model: POSE_MODEL,
          payment_tx_signature: poseTx,
          payment_amount_sakura: chargedSakura,
        })
        .select('id')
        .single();
      if (insErr || !gen) {
        return jsonResponse(500, { error: insErr?.message || 'Could not start generation.' }, cors);
      }

      return completeGeneration(supabase, gen.id as string, walletAddress, () =>
        editFluxImage(posePrompt, upload),
      );
    }

    // ── action === 'generate' ──
    // 1. Validate + build the prompt (throws on blocked/invalid) — no charge yet.
    const prompt = buildFanArtPrompt({
      subjectType: body.subject_type || 'free',
      series: body.series,
      character: body.character,
      freeText: body.free_prompt,
      stylePreset: body.style_preset,
    });

    // 2. Rate limit per wallet (+ generous IP backstop).
    const rl = await checkRateLimit(supabase, `fan-art:${walletAddress}`, 10, 86_400);
    if (!rl.allowed) {
      return jsonResponse(429, { error: 'Daily generation limit reached.', retryAfterSec: rl.retryAfterSec }, cors);
    }

    // 3. Payment (unless admin bypass).
    let chargedSakura = 0;
    const paymentTxSignature = body.payment_tx_signature?.trim() || null;
    if (!paymentBypass) {
      if (!paymentTxSignature) {
        return jsonResponse(402, { error: 'Payment required.', price_sakura: fanArtPrice() }, cors);
      }
      const { data: used } = await supabase
        .from('fan_art_generations')
        .select('id')
        .eq('payment_tx_signature', paymentTxSignature)
        .maybeSingle();
      if (used) return jsonResponse(400, { error: 'This payment was already used.' }, cors);

      const verified = await verifyAvatarSakuraPayment({
        signature: paymentTxSignature,
        expectedPayer: walletAddress,
        minAmountSakura: fanArtPrice(),
      });
      chargedSakura = verified.amount;
    }

    // 4. Insert processing row.
    const { data: gen, error: insErr } = await supabase
      .from('fan_art_generations')
      .insert({
        wallet_address: walletAddress,
        subject_type: body.subject_type || 'free',
        series: body.series ?? null,
        character_name: body.character ?? null,
        free_prompt: body.free_prompt ?? null,
        style_preset: body.style_preset || 'mappa',
        status: 'processing',
        prompt_snapshot: prompt,
        model: MODEL,
        payment_tx_signature: paymentTxSignature,
        payment_amount_sakura: chargedSakura,
      })
      .select('id')
      .single();
    if (insErr || !gen) {
      return jsonResponse(500, { error: insErr?.message || 'Could not start generation.' }, cors);
    }
    const genId = gen.id as string;

    // 5. Generate + upload.
    return completeGeneration(supabase, genId, walletAddress, () => generateFluxImage(prompt));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Request failed.';
    const status = /wallet|signature|expired/i.test(message) ? 401 : 400;
    return jsonResponse(status, { error: message }, cors);
  }
});
