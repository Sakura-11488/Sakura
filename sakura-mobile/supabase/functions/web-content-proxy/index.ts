import { corsHeaders, jsonResponse } from '../_shared/wallet-auth.ts';

type ProxyBody = {
  source?: 'atsu' | 'comics' | 'hentai' | 'consumet' | 'novel' | 'upstream';
  path?: string;
  /** Full URL for upstream source (allowlisted hosts only). */
  url?: string;
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  /** For upstream: expected response shape. */
  responseFormat?: 'json' | 'html' | 'text';
};

const cors = corsHeaders('POST, OPTIONS');
const ATSU_BASE = 'https://atsu.moe';
// Droplet host duplicated here (Deno can't import app lib). Canonical:
// sakura-mobile/lib/content-hosts.ts. Override via COMICS_PROXY_BASE /
// HENTAI_PROXY_BASE / CONSUMET_BASE secrets.
const DEFAULT_COMICS_BASE = 'http://165.232.83.159/comics/v1';
const DEFAULT_HENTAI_BASE = 'http://165.232.83.159/hentai/v1';
const DEFAULT_CONSUMET_BASE = 'http://165-232-83-159.nip.io:3000';
const NOVEL_BASE = 'https://allnovel.org';

const UPSTREAM_ALLOWLIST = [
  'hianime.dk',
  'hianime.to',
  'megaplay.buzz',
  'megaplay.cc',
  'megacloud.blog',
  'rapid-cloud.co',
  'rabbitstream.net',
];

const NOVEL_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const HIANIME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function comicsBase(): string {
  return (Deno.env.get('COMICS_PROXY_BASE') || DEFAULT_COMICS_BASE).replace(/\/+$/, '');
}

function hentaiBase(): string {
  return (Deno.env.get('HENTAI_PROXY_BASE') || DEFAULT_HENTAI_BASE).replace(/\/+$/, '');
}

function consumetBase(): string {
  return (Deno.env.get('CONSUMET_URL') || DEFAULT_CONSUMET_BASE).replace(/\/+$/, '');
}

function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${normalized}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function isAllowedUpstream(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return UPSTREAM_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function resolveUpstreamUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid upstream URL protocol.');
  }
  if (!isAllowedUpstream(parsed.hostname)) {
    throw new Error(`Upstream host not allowlisted: ${parsed.hostname}`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, cors);

  try {
    const payload = (await req.json().catch(() => ({}))) as ProxyBody;
    const source = payload.source;

    if (!source) {
      return jsonResponse(400, { error: 'source is required.' }, cors);
    }

    const method = (payload.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
      return jsonResponse(400, { error: 'Only GET and POST are supported.' }, cors);
    }

    let targetUrl: string;
    let headers: Record<string, string> = { Accept: 'application/json' };

    if (source === 'atsu') {
      const path = payload.path?.trim() ?? '';
      if (!path.startsWith('/')) return jsonResponse(400, { error: 'path must start with /.' }, cors);
      targetUrl = buildUrl(ATSU_BASE, path, payload.query);
      headers = { ...headers, Referer: ATSU_BASE };
    } else if (source === 'comics') {
      const path = payload.path?.trim() ?? '';
      if (!path.startsWith('/')) return jsonResponse(400, { error: 'path must start with /.' }, cors);
      targetUrl = buildUrl(comicsBase(), path, payload.query);
    } else if (source === 'hentai') {
      const path = payload.path?.trim() ?? '';
      if (!path.startsWith('/')) return jsonResponse(400, { error: 'path must start with /.' }, cors);
      targetUrl = buildUrl(hentaiBase(), path, payload.query);
    } else if (source === 'consumet') {
      const path = payload.path?.trim() ?? '';
      if (!path.startsWith('/')) return jsonResponse(400, { error: 'path must start with /.' }, cors);
      targetUrl = buildUrl(consumetBase(), path, payload.query);
      headers = { Accept: 'application/json', 'User-Agent': 'Sakura/1.0' };
    } else if (source === 'novel') {
      const path = payload.path?.trim() ?? '';
      if (!path.startsWith('/')) return jsonResponse(400, { error: 'path must start with /.' }, cors);
      targetUrl = buildUrl(NOVEL_BASE, path, payload.query);
      headers = {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': NOVEL_UA,
        ...payload.headers,
      };
    } else if (source === 'upstream') {
      const rawUrl = payload.url?.trim();
      if (!rawUrl) return jsonResponse(400, { error: 'url is required for upstream.' }, cors);
      targetUrl = resolveUpstreamUrl(rawUrl).href;
      const format = payload.responseFormat || 'html';
      headers = {
        Accept: format === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': HIANIME_UA,
        ...payload.headers,
      };
    } else {
      return jsonResponse(400, { error: 'Invalid source.' }, cors);
    }

    const upstream = await fetch(targetUrl, {
      method,
      headers:
        method === 'POST'
          ? { ...headers, 'Content-Type': 'application/json' }
          : headers,
      body: method === 'POST' && payload.body != null ? JSON.stringify(payload.body) : undefined,
    });

    const text = await upstream.text();

    if (source === 'novel' || source === 'upstream') {
      const format = payload.responseFormat || (source === 'novel' ? 'html' : 'html');
      if (!upstream.ok) {
        return jsonResponse(upstream.status, { error: `Upstream HTTP ${upstream.status}`, raw: text.slice(0, 500) }, cors);
      }
      if (format === 'json') {
        try {
          return jsonResponse(200, JSON.parse(text), cors);
        } catch {
          return jsonResponse(502, { error: 'Upstream returned non-JSON.', raw: text.slice(0, 500) }, cors);
        }
      }
      return jsonResponse(200, { html: text }, cors);
    }

    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return jsonResponse(upstream.status, { error: 'Upstream returned non-JSON.', raw: text.slice(0, 500) }, cors);
    }

    if (!upstream.ok) {
      return jsonResponse(upstream.status, { error: `Upstream HTTP ${upstream.status}`, data }, cors);
    }

    return jsonResponse(200, data, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy failed.';
    return jsonResponse(500, { error: message }, cors);
  }
});
