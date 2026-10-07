import { invokeContentProxy } from '@/lib/content-proxy-client';

function splitPathAndQuery(path: string): { pathname: string; query?: Record<string, string> } {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const qIndex = normalized.indexOf('?');
  const pathname = qIndex >= 0 ? normalized.slice(0, qIndex) : normalized;
  const search = qIndex >= 0 ? normalized.slice(qIndex + 1) : '';
  const query: Record<string, string> = {};
  if (search) {
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
  }
  return { pathname, query: Object.keys(query).length ? query : undefined };
}

export async function comicsProxyFetch<T>(path: string): Promise<T> {
  const { pathname, query } = splitPathAndQuery(path);
  const id = query?.id || '';
  if (((pathname === '/popular' || pathname === '/search') && (!query?.source || query.source === 'archive')) || id.startsWith('ia-')) {
    const params = new URLSearchParams({ path: pathname, ...query });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28_000);
    try {
      const response = await fetch(`/api/public-domain-comics?${params.toString()}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Comics are temporarily unavailable. Please try again.');
      return data as T;
    } finally { clearTimeout(timeout); }
  }
  return invokeContentProxy<T>({
    source: 'comics',
    path: pathname,
    method: 'GET',
    query,
  });
}
