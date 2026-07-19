import { HENTAI_PROXY_BASE } from '@/lib/hentai';

export async function hentaiProxyFetch<T>(path: string): Promise<T> {
  const url = `${HENTAI_PROXY_BASE}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Hentai proxy HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}
