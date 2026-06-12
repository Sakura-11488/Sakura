import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { authorizePushRequest, PUSH_NOTIFICATION_SOUND, sendExpoPushBatch } from '../_shared/expo-push.ts';
import { corsHeaders, isWallet, jsonResponse } from '../_shared/wallet-auth.ts';

type NotifyBody = {
  creator_wallet?: string;
  notification_type?: 'creator_new_work' | 'creator_new_release' | 'creator_post' | 'creator_coin_launched';
  title?: string;
  body?: string;
  route?: string;
  work_id?: string | null;
  release_id?: string | null;
  post_id?: string | null;
  metadata?: Record<string, unknown>;
};

const cors = corsHeaders();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);
  if (!authorizePushRequest(req)) return jsonResponse(401, { error: 'Unauthorized.' }, cors);

  try {
    const body = (await req.json()) as NotifyBody;
    const creatorWallet = body.creator_wallet?.trim() ?? '';
    if (!isWallet(creatorWallet)) return jsonResponse(400, { error: 'Invalid creator wallet.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: follows, error: followsErr } = await supabase
      .from('creator_follows')
      .select('follower_wallet')
      .eq('creator_wallet', creatorWallet)
      .eq('notify_new_works', true);
    if (followsErr) return jsonResponse(500, { error: followsErr.message }, cors);

    const wallets = [...new Set((follows ?? []).map((row) => row.follower_wallet).filter(Boolean))];
    if (!wallets.length) return jsonResponse(200, { ok: true, notified: 0, pushed: 0 }, cors);

    const title = (body.title ?? 'New Sakura creator update').trim().slice(0, 120);
    const messageBody = (body.body ?? 'A creator you follow posted something new.').trim().slice(0, 240);
    const rows = wallets.map((recipient_wallet) => ({
      recipient_wallet,
      creator_wallet: creatorWallet,
      actor_wallet: creatorWallet,
      notification_type: body.notification_type ?? 'creator_new_work',
      title,
      body: messageBody,
      route: body.route ?? null,
      work_id: body.work_id ?? null,
      release_id: body.release_id ?? null,
      post_id: body.post_id ?? null,
      metadata: body.metadata ?? {},
    }));

    const { error: insertErr } = await supabase.from('creator_notifications').insert(rows);
    if (insertErr) return jsonResponse(500, { error: insertErr.message }, cors);

    const { data: tokens, error: tokenErr } = await supabase
      .from('push_tokens')
      .select('expo_push_token, wallet_address, notify_episodes, notify_chapters, notify_marketing, enabled')
      .in('wallet_address', wallets)
      .eq('enabled', true);
    if (tokenErr) return jsonResponse(500, { error: tokenErr.message }, cors);

    const messages = (tokens ?? [])
      .filter((token) => token.expo_push_token)
      .map((token) => ({
        to: token.expo_push_token,
        title,
        body: messageBody,
        sound: PUSH_NOTIFICATION_SOUND,
        data: {
          type: body.notification_type ?? 'creator_new_work',
          creatorWallet,
          route: body.route ?? '',
          workId: body.work_id ?? '',
          releaseId: body.release_id ?? '',
          postId: body.post_id ?? '',
        },
      }));

    if (messages.length) await sendExpoPushBatch(messages);

    return jsonResponse(200, { ok: true, notified: rows.length, pushed: messages.length }, cors);
  } catch (error) {
    return jsonResponse(
      500,
      { error: error instanceof Error ? error.message : 'Creator follower notification failed.' },
      cors,
    );
  }
});
