const ATSU_BASE = 'https://atsu.moe';

const HEADERS = { Accept: 'application/json', Referer: ATSU_BASE };

export async function atsuFetch(
  path: string,
  init?: RequestInit & { query?: Record<string, string> },
): Promise<Response> {
  let url = path.startsWith('http') ? path : `${ATSU_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (init?.query) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(init.query)) u.searchParams.set(k, v);
    url = u.toString();
  }
  const { query: _q, ...rest } = init ?? {};
  return fetch(url, {
    ...rest,
    headers: { ...HEADERS, ...(rest.headers as Record<string, string> | undefined) },
  });
}
