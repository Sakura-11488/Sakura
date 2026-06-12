import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { authorizePushRequest, jsonResponse, sendExpoPushBatch } from '../_shared/expo-push.ts';

const REMINDER_HOURS = 24;

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

  const now = Date.now();
  const windowEnd = new Date(now + REMINDER_HOURS * 60 * 60 * 1000).toISOString();
  const windowStart = new Date(now).toISOString();

  const { data: rows, error } = await supabase
    .from('push_tokens')
    .select('expo_push_token, wallet_address, pass_expires_at')
    .eq('enabled', true)
    .eq('notify_pass', true)
    .not('pass_expires_at', 'is', null)
    .gte('pass_expires_at', windowStart)
    .lte('pass_expires_at', windowEnd);

  if (error) return jsonResponse(500, { error: error.message });

  const tokens = [...new Set((rows ?? []).map((r) => r.expo_push_token as string))];
  if (!tokens.length) {
    return jsonResponse(200, { sent: 0, message: 'No pass reminders due' });
  }

  const messages = tokens.map((to) => ({
    to,
    title: 'Pass expiring soon ⏳',
    body: 'Your Sakura pass expires within 24 hours — renew to keep premium access.',
    data: { type: 'pass_reminder', id: 'pass' },
  }));

  try {
    const result = await sendExpoPushBatch(messages);
    return jsonResponse(200, { sent: tokens.length, result });
  } catch (e) {
    return jsonResponse(502, { error: e instanceof Error ? e.message : 'Push send failed' });
  }
});
