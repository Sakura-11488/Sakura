import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { authorizePushRequest, jsonResponse, sendExpoPushBatch } from '../_shared/expo-push.ts';

type NotifyCategory = 'episodes' | 'chapters' | 'pass' | 'marketing';

interface SendBody {
  title: string;
  body: string;
  data?: Record<string, string | number | boolean>;
  tokens?: string[];
  wallet_addresses?: string[];
  category?: NotifyCategory;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  const authClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  if (!(await authorizePushRequest(req, authClient))) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let body: SendBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const { title, body: messageBody, data, tokens, wallet_addresses, category } = body;
  if (!title?.trim() || !messageBody?.trim()) {
    return jsonResponse(400, { error: 'title and body are required' });
  }

  let targetTokens = [...(tokens ?? [])].filter(Boolean);

  if (wallet_addresses?.length) {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let query = supabase
      .from('push_tokens')
      .select('expo_push_token')
      .eq('enabled', true)
      .in('wallet_address', wallet_addresses);

    if (category === 'episodes') query = query.eq('notify_episodes', true);
    if (category === 'chapters') query = query.eq('notify_chapters', true);
    if (category === 'pass') query = query.eq('notify_pass', true);
    if (category === 'marketing') query = query.eq('notify_marketing', true);

    const { data: rows, error } = await query;
    if (error) return jsonResponse(500, { error: error.message });
    targetTokens.push(...(rows ?? []).map((r) => r.expo_push_token as string));
  }

  targetTokens = [...new Set(targetTokens)];
  if (!targetTokens.length) {
    return jsonResponse(200, { sent: 0, message: 'No tokens matched' });
  }

  const messages = targetTokens.map((to) => ({
    to,
    title,
    body: messageBody,
    data,
  }));

  try {
    const result = await sendExpoPushBatch(messages);
    return jsonResponse(200, { sent: targetTokens.length, result });
  } catch (e) {
    return jsonResponse(502, { error: e instanceof Error ? e.message : 'Push send failed' });
  }
});
