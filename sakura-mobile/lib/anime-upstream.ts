const HIANIME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const HIANIME_BASE = 'https://hianime.dk';

export function getAnimeUpstreamUserAgent(): string {
  return HIANIME_UA;
}

export async function fetchUpstreamText(url: string, referer?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: referer || HIANIME_BASE + '/',
      'User-Agent': HIANIME_UA,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchUpstreamJson(
  url: string,
  referer?: string,
  origin?: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Referer: referer || HIANIME_BASE + '/',
      Origin: origin || new URL(url).origin,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': HIANIME_UA,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
