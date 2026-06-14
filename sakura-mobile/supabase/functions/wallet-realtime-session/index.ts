import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

const cors = corsHeaders();
const SESSION_TTL_SEC = 30 * 60;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'realtime-session');
    const secret = Deno.env.get('SUPABASE_JWT_SECRET')?.trim();
    if (!secret) return jsonResponse(500, { error: 'JWT secret unavailable.' }, cors);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const jwt = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        aud: 'authenticated',
        exp: getNumericDate(SESSION_TTL_SEC),
        iat: getNumericDate(0),
        iss: 'supabase',
        role: 'authenticated',
        sub: walletAddress,
        wallet_address: walletAddress,
      },
      key,
    );

    const expiresAt = Date.now() + SESSION_TTL_SEC * 1000;
    return jsonResponse(200, { access_token: jwt, expires_at: expiresAt }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Session failed.' }, cors);
  }
});
