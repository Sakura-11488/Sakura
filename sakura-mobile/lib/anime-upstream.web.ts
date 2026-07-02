import { invokeContentProxy } from '@/lib/content-proxy-client';

const HIANIME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const HIANIME_BASE = 'https://hianime.dk';

export function getAnimeUpstreamUserAgent(): string {
  return HIANIME_UA;
}

export async function fetchUpstreamText(url: string, referer?: string): Promise<string> {
  const data = await invokeContentProxy<{ html: string }>({
    source: 'upstream',
    url,
    responseFormat: 'html',
    headers: {
      Referer: referer || HIANIME_BASE + '/',
      'User-Agent': HIANIME_UA,
    },
  });
  if (!data?.html) throw new Error('Upstream proxy returned empty HTML.');
  return data.html;
}

export async function fetchUpstreamJson(
  url: string,
  referer?: string,
  origin?: string,
): Promise<Record<string, unknown>> {
  return invokeContentProxy<Record<string, unknown>>({
    source: 'upstream',
    url,
    responseFormat: 'json',
    headers: {
      Referer: referer || HIANIME_BASE + '/',
      Origin: origin || new URL(url).origin,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': HIANIME_UA,
    },
  });
}
