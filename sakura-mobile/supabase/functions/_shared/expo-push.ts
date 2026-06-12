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

export function authorizePushRequest(req: Request): boolean {
  const secret = Deno.env.get('PUSH_SEND_SECRET')?.trim();
  if (!secret) return false;
  const header = req.headers.get('Authorization') ?? '';
  return header === `Bearer ${secret}`;
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
