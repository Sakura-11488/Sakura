import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders as sharedCors, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

/**
 * Shared CORS, not a local literal.
 *
 * The local object omitted x-wallet-address / x-signature / x-message, so a
 * browser preflight would have stripped exactly the headers this function now
 * requires — push registration would fail on web only, silently, while native
 * kept working.
 */
const corsHeaders = sharedCors();

type PushAction = 'upsert' | 'disable' | 'ping';

interface PushTokenBody {
  action?: PushAction;
  /** Ignored. Identity comes from the signature; kept out of the type on purpose. */
  expo_push_token?: string;
  platform?: 'ios' | 'android' | 'web' | 'unknown';
  notify_episodes?: boolean;
  notify_chapters?: boolean;
  notify_pass?: boolean;
  notify_marketing?: boolean;
  pass_expires_at?: string | null;
  enabled?: boolean;
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isValidExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(value);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });

  try {
    /**
     * Ownership, proved — not asserted.
     *
     * This was the only wallet-scoped function with no signature check. The
     * platform JWT is satisfied by the anon key that ships in the APK and the
     * PWA bundle, so anyone could bind their own device to any wallet and
     * receive that wallet's private DM previews and transfer notifications —
     * and victim addresses are trivially discoverable through search-users.
     *
     * The wallet now comes from the Ed25519 signature and the body is never
     * consulted for identity.
     */
    let walletAddress: string;
    try {
      ({ walletAddress } = verifyWalletHeaders(req.headers, 'push-token'));
    } catch {
      return jsonResponse(401, { error: 'Could not verify your wallet.' });
    }

    const body = (await req.json()) as PushTokenBody;
    const token = body.expo_push_token;
    if (!isValidExpoPushToken(token)) return jsonResponse(400, { error: 'Invalid Expo push token.' });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const now = new Date().toISOString();
    const action = body.action ?? 'upsert';

    if (action === 'disable') {
      const { error } = await supabase
        .from('push_tokens')
        .update({ enabled: false, updated_at: now })
        .eq('expo_push_token', token)
        // Scoped to the signer: a token alone is not proof of ownership.
        .eq('wallet_address', walletAddress);
      if (error) return jsonResponse(500, { error: error.message });
      return jsonResponse(200, { ok: true });
    }

    if (action === 'ping') {
      const { error } = await supabase
        .from('push_tokens')
        .update({ last_opened_at: now, updated_at: now })
        .eq('expo_push_token', token)
        .eq('wallet_address', walletAddress);
      if (error) return jsonResponse(500, { error: error.message });
      return jsonResponse(200, { ok: true });
    }

    const { error } = await supabase.from('push_tokens').upsert(
      {
        // From the signature. The body never decides whose device this is.
        wallet_address: walletAddress,
        expo_push_token: token,
        platform: body.platform ?? 'unknown',
        notify_episodes: body.notify_episodes ?? true,
        notify_chapters: body.notify_chapters ?? true,
        notify_pass: body.notify_pass ?? true,
        notify_marketing: body.notify_marketing ?? true,
        pass_expires_at: body.pass_expires_at ?? null,
        enabled: body.enabled ?? true,
        updated_at: now,
      },
      { onConflict: 'expo_push_token' },
    );

    if (error) return jsonResponse(500, { error: error.message });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : 'Push token sync failed.',
    });
  }
});
