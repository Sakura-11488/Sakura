import { invokeContentProxy } from '@/lib/content-proxy-client';
import { atsuCatalogRequest, fetchCatalog } from '@/lib/catalog-client';

function splitPathAndQuery(path: string): { pathname: string; query?: Record<string, string> } {
  const normalized = path.startsWith('http')
    ? new URL(path).pathname + new URL(path).search
    : path.startsWith('/')
      ? path
      : `/${path}`;

  const qIndex = normalized.indexOf('?');
  const pathname = qIndex >= 0 ? normalized.slice(0, qIndex) : normalized;
  const search = qIndex >= 0 ? normalized.slice(qIndex + 1) : '';
  const query: Record<string, string> = {};
  if (search) {
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
  }
  return { pathname, query: Object.keys(query).length ? query : undefined };
}

export async function atsuFetch(
  path: string,
  init?: RequestInit & { query?: Record<string, string> },
): Promise<Response> {
  const { pathname, query: pathQuery } = splitPathAndQuery(path);
  const method = (init?.method || 'GET').toUpperCase() as 'GET' | 'POST';
  let body: unknown;
  if (init?.body && typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }

  const query = { ...pathQuery, ...init?.query };

  // Read-only catalogue requests try the same-origin, edge-cached route first
  // (see lib/catalog-client.ts). Anything it does not cover, and any miss,
  // goes to the edge function exactly as before, so the Response below — and
  // the error a failed call throws — are what callers always got.
  const catalog = body === undefined ? atsuCatalogRequest(pathname, query, method) : null;
  if (catalog) {
    const hit = await fetchCatalog<unknown>(catalog);
    if (hit.ok) return jsonResponse(hit.data);
  }

  const data = await invokeContentProxy<unknown>({
    source: 'atsu',
    path: pathname,
    method,
    query: Object.keys(query).length ? query : undefined,
    body: method === 'POST' ? body : undefined,
  });

  return jsonResponse(data);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
