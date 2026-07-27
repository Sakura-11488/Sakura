import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

const cors = corsHeaders();
const SESSION_TTL_SEC = 30 * 60;

/**
 * Mints the short-lived JWT that authenticates the realtime socket, so chat
 * subscriptions run as `authenticated` with a wallet_address claim that the
 * membership RLS policies read via jwt_wallet_address().
 *
 * This read used to be Deno.env.get('SUPABASE_JWT_SECRET'), which can never be
 * satisfied: Supabase does not inject that name into the edge runtime, and the
 * SUPABASE_ prefix is reserved so it cannot be set as a custom secret either.
 * The function therefore returned 500 on every call since the day it shipped,
 * ensureRealtimeAuth always threw, and the client silently fell back to polling
 * — so realtime chat has never once worked, and nobody noticed because the
 * fallback is invisible.
 *
 * Set it with: supabase secrets set REALTIME_JWT_SECRET=<project JWT secret>
 * (Dashboard → Project Settings → API → JWT Secret. It must be that exact value,
 * because Realtime verifies this token against the project's own secret.)
 *
 * The legacy name is still read as a fallback in case it is ever injected.
 */
function jwtSecret(): string | null {
  return (
    Deno.env.get('REALTIME_JWT_SECRET')?.trim() ||
    Deno.env.get('SUPABASE_JWT_SECRET')?.trim() ||
    null
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'realtime-session');
    const secret = jwtSecret();
    if (!secret) {
      return jsonResponse(
        500,
        { error: 'Realtime session unavailable: REALTIME_JWT_SECRET is not set on this project.' },
        cors,
      );
    }

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
