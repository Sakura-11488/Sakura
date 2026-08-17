import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export const PUSH_NOTIFICATION_SOUND = 'notification.wav';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string | number | boolean>;
  sound?: string;
  channelId?: string;
}

export async function sendExpoPushBatch(messages: ExpoPushMessage[]) {
  if (!messages.length) return { data: [] };

  const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN')?.trim();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const payload = messages.map((m) => ({
    ...m,
    sound: m.sound ?? PUSH_NOTIFICATION_SOUND,
    channelId: m.channelId ?? 'default',
  }));

  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Expo push API error: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Gate for the push functions.
 *
 * The secret lives in Supabase Vault and is fetched through the
 * `push_send_secret()` RPC, which is SECURITY DEFINER and executable by
 * service_role only. It is deliberately NOT a function env var any more.
 *
 * Why: the three push cron jobs used to carry a copy of this secret as
 * plaintext inside `cron.job.command`. Anything with admin DB access could read
 * it — and something did. Rotating an env var would have meant copying the new
 * value through a terminal and a transcript to get it into both places, which
 * is the same exposure again. With Vault as the single source, cron composes the
 * header with a subquery and the functions verify against the same row; the
 * value never exists outside the database.
 *
 * The old cron jobs were also broken in two ways that hid each other: the header
 * was the bare secret with no "Bearer " prefix, so this check could never pass,
 * and the timeout was 1000ms, so the request aborted before the function
 * finished anyway. Push notifications had never fired.
 */
export async function authorizePushRequest(
  req: Request,
  supabase: SupabaseClient,
): Promise<boolean> {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (!presented) return false;

  const { data, error } = await supabase.rpc('push_send_secret');
  if (error) {
    console.error('[expo-push] could not read push secret', error.message);
    return false;
  }
  const expected = typeof data === 'string' ? data.trim() : '';
  return expected.length > 0 && presented === expected;
}

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
