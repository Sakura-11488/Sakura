import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { PUSH_NOTIFICATION_SOUND, sendExpoPushBatch } from '../_shared/expo-push.ts';
import { corsHeaders, jsonResponse, verifyWalletHeaders } from '../_shared/wallet-auth.ts';

type PublishBody = { work_id?: string };

const cors = corsHeaders();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  let walletAddress: string;
  try {
    ({ walletAddress } = verifyWalletHeaders(req.headers, 'creator-publish-work'));
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : 'Unauthorized.' }, cors);
  }

  try {
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

    // The RPC locks the work, validates every draft release's content, and
    // publishes work + releases atomically. A retry returns already_published
    // and must never notify followers a second time.
    const { data: published, error: publishErr } = await supabase.rpc(
      'publish_creator_work_checked',
      { p_work_id: body.work_id, p_wallet: walletAddress },
    );
    if (publishErr) return jsonResponse(422, { error: publishErr.message }, cors);
    if (published?.already_published) {
      return jsonResponse(200, {
        ok: true, work_id: body.work_id, already_published: true,
        releases_published: 0, followers_notified: 0, pushes_sent: 0,
      }, cors);
    }

    // Notifications are secondary to publication. A push outage must not make
    // the already-published work look like a failed upload to the creator.
    let notified = 0;
    let pushed = 0;
    try {
      const { data: follows, error: followsErr } = await supabase
      .from('creator_follows')
      .select('follower_wallet')
      .eq('creator_wallet', walletAddress)
      .eq('notify_new_works', true);
      if (followsErr) throw followsErr;

      const followerWallets = [...new Set((follows ?? []).map((row) => row.follower_wallet).filter(Boolean))];
      if (followerWallets.length) {
      const isNewRelease = published?.new_release === true;
      const releaseCount = Number(published?.releases_published) || 0;
      const title = isNewRelease
        ? `${releaseCount} new ${work.kind === 'anime' ? 'episode' : 'chapter'}${releaseCount === 1 ? '' : 's'}`
        : 'New Sakura creator work';
      const bodyText = isNewRelease
        ? `${work.title} has new content.`
        : `${work.title} is now live.`;
      const route = `/work/${body.work_id}`;

      const { error: notifyErr } = await supabase.from('creator_notifications').insert(
        followerWallets.map((recipient_wallet) => ({
          recipient_wallet,
          actor_wallet: walletAddress,
          creator_wallet: walletAddress,
          notification_type: isNewRelease ? 'creator_new_release' : 'creator_new_work',
          title,
          body: bodyText,
          route,
          work_id: body.work_id,
          release_id: published?.first_release_id ?? null,
          metadata: { kind: work.kind, releaseCount },
        })),
      );
      if (notifyErr) throw notifyErr;
      notified = followerWallets.length;

      const { data: tokens, error: tokenErr } = await supabase
        .from('push_tokens')
        .select('expo_push_token')
        .in('wallet_address', followerWallets)
        .eq('enabled', true);
      if (tokenErr) throw tokenErr;

      const messages = (tokens ?? [])
        .filter((row) => row.expo_push_token)
        .map((row) => ({
          to: row.expo_push_token,
          title,
          body: bodyText,
          sound: PUSH_NOTIFICATION_SOUND,
          data: { type: isNewRelease ? 'creator_new_release' : 'creator_new_work', creatorWallet: walletAddress, workId: body.work_id ?? '', route },
        }));
      if (messages.length) {
        await sendExpoPushBatch(messages);
        pushed = messages.length;
      }
    }
    } catch (notificationError) {
      console.error('[publish-creator-work] published, notification failed:', notificationError);
    }

    return jsonResponse(200, {
      ok: true,
      work_id: body.work_id,
      releases_published: published?.releases_published ?? 0,
      followers_notified: notified,
      pushes_sent: pushed,
    }, cors);
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : 'Publish failed.' }, cors);
  }
});
