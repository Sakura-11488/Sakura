import { corsHeaders } from '../_shared/wallet-auth.ts';

const cors = corsHeaders('GET, HEAD, OPTIONS');
const MEDIA_BASE = 'http://165-232-83-159.nip.io';
const ALLOWED_HOSTS = new Set(['165-232-83-159.nip.io', '165.232.83.159']);

function mediaBase(): string {
  return (Deno.env.get('SAKURA_MEDIA_BASE') || MEDIA_BASE).replace(/\/+$/, '');
}

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.json')) return 'application/json';
  return 'video/mp4';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(req.url);
    const path = url.searchParams.get('path')?.trim() ?? '';
    if (!path || !path.startsWith('/')) {
      return new Response(JSON.stringify({ error: 'path query param required (must start with /).' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const target = new URL(`${mediaBase()}${path}`);
    if (!ALLOWED_HOSTS.has(target.hostname)) {
      return new Response(JSON.stringify({ error: 'Media host not allowlisted.' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const range = req.headers.get('range');
    const upstreamHeaders: Record<string, string> = {
      'User-Agent': 'Sakura-Media-Proxy/1.0',
    };
    if (range) upstreamHeaders['Range'] = range;

    const upstream = await fetch(target.href, {
      method: req.method,
      headers: upstreamHeaders,
    });

    const outHeaders: Record<string, string> = {
      ...cors,
      'Content-Type': upstream.headers.get('content-type') || contentTypeForPath(path),
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) outHeaders['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) outHeaders['Content-Range'] = contentRange;

    if (req.method === 'HEAD') {
      return new Response(null, { status: upstream.status, headers: outHeaders });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Media proxy failed.';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
