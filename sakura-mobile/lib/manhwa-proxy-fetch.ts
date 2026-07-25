import { MANHWA_PROXY_BASE } from '@/lib/manhwa';

export async function manhwaProxyFetch<T>(path: string): Promise<T> {
  const url = `${MANHWA_PROXY_BASE}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Manhwa proxy HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}
