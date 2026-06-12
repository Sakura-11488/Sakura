import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { PUSH_NOTIFICATION_SOUND, sendExpoPushBatch } from '../_shared/expo-push.ts';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type PublishBody = { work_id?: string };

const cors = corsHeaders();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const { walletAddress } = verifyWalletHeaders(req.headers, 'creator-publish-work');
    const body = (await req.json()) as PublishBody;
    if (!body.work_id) return jsonResponse(400, { error: 'Missing work_id.' }, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: work, error: workFetchErr } = await supabase
      .from('creator_works')
      .select('id, creator_wallet, title, kind, publication_status')
      .eq('id', body.work_id)
      .maybeSingle();
    if (workFetchErr) return jsonResponse(500, { error: workFetchErr.message }, cors);
    if (!work) return jsonResponse(404, { error: 'Work not found.' }, cors);
    if (work.creator_wallet !== walletAddress) return jsonResponse(403, { error: 'Not your work.' }, cors);

    const now = new Date().toISOString();
    const { error: updateWorkErr } = await supabase
      .from('creator_works')
      .update({
        publication_status: 'published',
        visibility: 'public',
        published_at: now,
        updated_at: now,
      })
      .eq('id', body.work_id)
      .eq('creator_wallet', walletAddress);
    if (updateWorkErr) return jsonResponse(500, { error: updateWorkErr.message }, cors);

    const { data: releases, error: releaseErr } = await supabase
      .from('work_releases')
      .update({
        publication_status: 'published',
        visibility: 'public',
        published_at: now,
        updated_at: now,
      })
      .eq('work_id', body.work_id)
      .eq('publication_status', 'draft')
      .select('id, title');
    if (releaseErr) return jsonResponse(500, { error: releaseErr.message }, cors);

    const { data: follows, error: followsErr } = await supabase
      .from('creator_follows')
      .select('follower_wallet')
      .eq('creator_wallet', walletAddress)
      .eq('notify_new_works', true);
    if (followsErr) return jsonResponse(500, { error: followsErr.message }, cors);

    const followerWallets = [...new Set((follows ?? []).map((row) => row.follower_wallet).filter(Boolean))];
    let pushed = 0;
    if (followerWallets.length) {
      const firstRelease = releases?.[0];
      const title = 'New Sakura creator work';
      const bodyText = `${work.title} is now live.`;
      const route = `/creator/work/${body.work_id}`;

      const { error: notifyErr } = await supabase.from('creator_notifications').insert(
        followerWallets.map((recipient_wallet) => ({
          recipient_wallet,
          actor_wallet: walletAddress,
          creator_wallet: walletAddress,
          notification_type: firstRelease ? 'creator_new_release' : 'creator_new_work',
          title,
          body: bodyText,
          route,
          work_id: body.work_id,
          release_id: firstRelease?.id ?? null,
          metadata: { kind: work.kind, releaseCount: releases?.length ?? 0 },
        })),
      );
      if (notifyErr) return jsonResponse(500, { error: notifyErr.message }, cors);

      const { data: tokens, error: tokenErr } = await supabase
        .from('push_tokens')
        .select('expo_push_token')
        .in('wallet_address', followerWallets)
        .eq('enabled', true);
      if (tokenErr) return jsonResponse(500, { error: tokenErr.message }, cors);

      const messages = (tokens ?? [])
        .filter((row) => row.expo_push_token)
        .map((row) => ({
          to: row.expo_push_token,
          title,
          body: bodyText,
          sound: PUSH_NOTIFICATION_SOUND,
          data: { type: 'creator_new_work', creatorWallet: walletAddress, workId: body.work_id ?? '', route },
        }));
      if (messages.length) {
        await sendExpoPushBatch(messages);
        pushed = messages.length;
      }
    }

    return jsonResponse(200, {
      ok: true,
      work_id: body.work_id,
      releases_published: releases?.length ?? 0,
      followers_notified: followerWallets.length,
      pushes_sent: pushed,
    }, cors);
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Publish failed.' }, cors);
  }
});
