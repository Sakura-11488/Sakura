import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse } from '../_shared/wallet-auth.ts';

const cors = corsHeaders();
const TOKEN_RE = /^[0-9a-f-]{72}$/i;
const PATH_RE = /^\/media\/v1\/creator\/private\/[1-9A-HJ-NP-Za-km-z]{32,44}\/[0-9a-f-]{36}\/[a-f0-9-]{36}\.(mp4|mov|webm|m4v)$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);
  try {
    const body = (await req.json()) as { path?: string; token?: string };
    const path = body.path ?? '';
    const token = body.token ?? '';
    if (!PATH_RE.test(path) || !TOKEN_RE.test(token)) {
      return jsonResponse(403, { allowed: false }, cors);
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await supabase.from('creator_video_access')
      .select('video_path, expires_at').eq('token_hash', tokenHash).maybeSingle();
    if (error) throw error;
    if (!data || data.video_path !== path || Date.parse(data.expires_at) <= Date.now()) {
      return jsonResponse(403, { allowed: false }, cors);
    }
    return jsonResponse(200, { allowed: true }, cors);
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'Authorization failed.' }, cors);
  }
});
