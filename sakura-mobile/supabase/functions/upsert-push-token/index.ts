import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PushAction = 'upsert' | 'disable' | 'ping';

interface PushTokenBody {
  action?: PushAction;
  wallet_address?: string;
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

function isValidWallet(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function isValidExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(value);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });

  try {
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
        .eq('expo_push_token', token);
      if (error) return jsonResponse(500, { error: error.message });
      return jsonResponse(200, { ok: true });
    }

    if (action === 'ping') {
      const { error } = await supabase
        .from('push_tokens')
        .update({ last_opened_at: now, updated_at: now })
        .eq('expo_push_token', token);
      if (error) return jsonResponse(500, { error: error.message });
      return jsonResponse(200, { ok: true });
    }

    if (!isValidWallet(body.wallet_address)) {
      return jsonResponse(400, { error: 'Invalid wallet address.' });
    }

    const { error } = await supabase.from('push_tokens').upsert(
      {
        wallet_address: body.wallet_address,
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
