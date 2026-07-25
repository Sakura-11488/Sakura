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

export async function manhwaProxyFetch<T>(path: string): Promise<T> {
  const { pathname, query } = splitPathAndQuery(path);
  return invokeContentProxy<T>({
    source: 'manhwa',
    path: pathname,
    method: 'GET',
    query,
  });
}
