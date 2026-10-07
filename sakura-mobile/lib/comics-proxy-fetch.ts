import { COMICS_PROXY_BASE } from '@/lib/comics';

export async function comicsProxyFetch<T>(path: string): Promise<T> {
  const url = `${COMICS_PROXY_BASE}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || 'Comics are temporarily unavailable. Please try again.');
  }
  return (await res.json()) as T;
}
