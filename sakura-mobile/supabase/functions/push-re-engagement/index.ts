import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  authorizePushRequest,
  jsonResponse,
  pickRandom,
  sendExpoPushBatch,
} from '../_shared/expo-push.ts';

const MS_DAY = 24 * 60 * 60 * 1000;

interface Campaign {
  kind: 're_engagement' | 'marketing';
  refKey: string;
  minInactiveDays: number;
  cooldownDays: number;
  title: string;
  body: string;
  routeType: 'home' | 'new_releases';
}

const CAMPAIGNS: Campaign[] = [
  {
    kind: 're_engagement',
    refKey: 'miss_you',
    minInactiveDays: 3,
    cooldownDays: 7,
    title: 'We miss you 🌸',
    body: 'Sakura saved your spot — fresh chapters and episodes are waiting.',
    routeType: 'home',
  },
  {
    kind: 're_engagement',
    refKey: 'come_back',
    minInactiveDays: 5,
    cooldownDays: 10,
    title: "It's been a minute...",
    body: 'Your watchlist is getting lonely. Come see what dropped while you were away.',
    routeType: 'home',
  },
  {
    kind: 're_engagement',
    refKey: 'saved_your_spot',
    minInactiveDays: 7,
    cooldownDays: 14,
    title: 'Still thinking about you',
    body: 'Pick up right where you left off — one tap back into Sakura.',
    routeType: 'home',
  },
  {
    kind: 'marketing',
    refKey: 'missing_out',
    minInactiveDays: 1,
    cooldownDays: 4,
    title: "You're missing out 👀",
    body: 'Hot new releases just landed. See what everyone is reading tonight.',
    routeType: 'new_releases',
  },
  {
    kind: 'marketing',
    refKey: 'trending_now',
    minInactiveDays: 2,
    cooldownDays: 5,
    title: '🔥 Trending on Sakura',
    body: 'New manga chapters and anime episodes — tap before your friends spoil it.',
    routeType: 'new_releases',
  },
  {
    kind: 'marketing',
    refKey: 'fresh_drops',
    minInactiveDays: 1,
    cooldownDays: 3,
    title: 'Fresh drops alert',
    body: "Don't sleep on this week's releases. Your next obsession might be one tap away.",
    routeType: 'new_releases',
  },
];

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_DAY).toISOString();
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  if (!authorizePushRequest(req)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const campaign = pickRandom(CAMPAIGNS);
  const inactiveBefore = daysAgo(campaign.minInactiveDays);
  const cooldownBefore = daysAgo(campaign.cooldownDays);

  const { data: rows, error } = await supabase
    .from('push_tokens')
    .select('expo_push_token, last_opened_at, created_at')
    .eq('enabled', true)
    .eq('notify_marketing', true);

  if (error) return jsonResponse(500, { error: error.message });

  const candidates = (rows ?? []).filter((row) => {
    const lastOpen = (row.last_opened_at as string | null) ?? (row.created_at as string);
    return lastOpen <= inactiveBefore;
  });

  if (!candidates.length) {
    return jsonResponse(200, { sent: 0, campaign: campaign.refKey, message: 'No inactive users' });
  }

  const eligible: string[] = [];
  for (const row of candidates) {
    const token = row.expo_push_token as string;
    const { data: recent } = await supabase
      .from('push_delivery_log')
      .select('id')
      .eq('expo_push_token', token)
      .eq('kind', campaign.kind)
      .gte('sent_at', cooldownBefore)
      .limit(1);

    if (!recent?.length) eligible.push(token);
  }

  const uniqueTokens = [...new Set(eligible)];
  if (!uniqueTokens.length) {
    return jsonResponse(200, {
      sent: 0,
      campaign: campaign.refKey,
      message: 'All inactive users recently notified',
    });
  }

  const messages = uniqueTokens.map((to) => ({
    to,
    title: campaign.title,
    body: campaign.body,
    data: {
      type: campaign.routeType,
      id: campaign.routeType,
      pushKind: campaign.kind,
      campaign: campaign.refKey,
    },
  }));

  try {
    const result = await sendExpoPushBatch(messages);

    const logRows = uniqueTokens.map((expo_push_token) => ({
      expo_push_token,
      kind: campaign.kind,
      ref_key: `${campaign.refKey}:${new Date().toISOString().slice(0, 10)}`,
    }));
    await supabase.from('push_delivery_log').insert(logRows);

    return jsonResponse(200, {
      sent: messages.length,
      campaign: campaign.refKey,
      kind: campaign.kind,
      result,
    });
  } catch (e) {
    return jsonResponse(502, { error: e instanceof Error ? e.message : 'Push send failed' });
  }
});
