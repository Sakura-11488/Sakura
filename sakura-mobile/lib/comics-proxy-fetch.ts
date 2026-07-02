import { COMICS_PROXY_BASE } from '@/lib/comics';

export async function comicsProxyFetch<T>(path: string): Promise<T> {
  const url = `${COMICS_PROXY_BASE}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Comics proxy HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}
