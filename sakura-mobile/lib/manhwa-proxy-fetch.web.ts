import { invokeContentProxy } from '@/lib/content-proxy-client';
import { fetchCatalog, manhwaCatalogRequest } from '@/lib/catalog-client';

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
  // Edge-cached same-origin route first: it serves a stale copy while the
  // droplet re-scrapes, which is what made the Manhwa tab wait 1.5–3.5 s.
  // A miss of any kind falls through to the edge function, unchanged.
  const catalog = manhwaCatalogRequest(pathname, query);
  if (catalog) {
    const hit = await fetchCatalog<T>(catalog);
    if (hit.ok) return hit.data;
  }
  return invokeContentProxy<T>({
    source: 'manhwa',
    path: pathname,
    method: 'GET',
    query,
  });
}
