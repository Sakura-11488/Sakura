import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type UploadBody = {
  image_base64?: string;
  mime_type?: string;
};

const cors = corsHeaders();
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function decodeBase64Image(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function extForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'upload-profile-avatar');
    const body = (await req.json()) as UploadBody;
    const rawBase64 = body.image_base64?.trim();
    const mimeType = body.mime_type?.trim() || 'image/jpeg';

    if (!rawBase64) return jsonResponse(400, { error: 'image_base64 is required.' }, cors);
    if (!ALLOWED_MIME.has(mimeType)) {
      return jsonResponse(400, { error: 'Use a JPEG, PNG, or WebP image.' }, cors);
    }

    const bytes = decodeBase64Image(rawBase64);
    if (!bytes.length) return jsonResponse(400, { error: 'Image data is empty.' }, cors);
    if (bytes.length > MAX_BYTES) {
      return jsonResponse(400, { error: 'Image must be 4 MB or smaller.' }, cors);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: usernameRow } = await supabase
      .from('sakura_usernames')
      .select('username')
      .eq('wallet_address', walletAddress)
      .maybeSingle();

    if (!usernameRow) {
      return jsonResponse(403, { error: 'Creator profile required before uploading a photo.' }, cors);
    }

    const ext = extForMime(mimeType);
    const objectPath = `${walletAddress}/profile.${ext}`;
    const baseUrl = Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '');
    const avatarUrl = `${baseUrl}/storage/v1/object/public/user-avatars/${objectPath}`;

    const { error: uploadErr } = await supabase.storage.from('user-avatars').upload(objectPath, bytes, {
      contentType: mimeType,
      upsert: true,
      cacheControl: '3600',
    });
    if (uploadErr) return jsonResponse(500, { error: uploadErr.message }, cors);

    const now = new Date().toISOString();
    const { error: profileErr } = await supabase.from('user_profiles').upsert(
      {
        wallet_address: walletAddress,
        avatar_url: avatarUrl,
        avatar_seed: walletAddress.slice(0, 8),
        updated_at: now,
      },
      { onConflict: 'wallet_address' },
    );
    if (profileErr) return jsonResponse(500, { error: profileErr.message }, cors);

    return jsonResponse(200, { avatar_url: avatarUrl }, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Avatar upload failed.';
    const status =
      message.includes('wallet') || message.includes('signature') || message.includes('expired')
        ? 401
        : 500;
    return jsonResponse(status, { error: message }, cors);
  }
});
