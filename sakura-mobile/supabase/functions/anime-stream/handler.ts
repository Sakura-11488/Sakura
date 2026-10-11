/** Browser-safe HLS relay. Only the numeric episode resolver may mint capabilities. */
export type EpisodeInput = { malId: string; episode: number; category: 'sub' | 'dub'; force?: boolean };
export type ResolvedEpisode = {
  url: string; isM3U8: true; embedUrl: string; category: 'sub' | 'dub';
  availableCategories?: ('sub' | 'dub')[];
  intro?: { start: number; end: number }; outro?: { start: number; end: number };
  subtitles?: { url: string; lang: string; label: string }[];
};
export type AnimeStreamDependencies = {
  signingSecret?: string;
  publicBaseUrl: string;
  resolveEpisode: (input: EpisodeInput, options?: { signal?: AbortSignal }) => Promise<ResolvedEpisode>;
  fetch?: typeof fetch;
  /** Milliseconds, like Date.now. */
  now?: () => number;
  /** Additional exact server-configured hosts; never read from a request. */
  allowedMediaHosts?: readonly string[];
};

type Kind = 'playlist' | 'subtitle-playlist' | 'media' | 'encrypted-media' | 'subtitle' | 'key';
type Capability = { v: 1; u: string; e: number; k: Kind; s: string };
const TTL_SECONDS = 2 * 60 * 60;
const MAX_PLAYLIST_BYTES = 512 * 1024;
const MAX_PLAYLIST_URLS = 2048;
const TIMEOUT_MS = 35_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, range, apikey, authorization, x-client-info',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Retry-After',
  'Access-Control-Max-Age': '600',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};
const PROVIDER_HEADERS = {
  Referer: 'https://megaplay.buzz/', Origin: 'https://megaplay.buzz',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Encoding': 'identity',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new RelayError(status, message); }
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json',
    'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(401, 'Invalid stream token.');
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)); }
  catch { return fail(401, 'Invalid stream token.'); }
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.length;
      if (length > limit) fail(413, 'Response is too large.');
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
function episodeInput(value: unknown): EpisodeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'An episode request is required.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['malId', 'episode', 'category', 'force'].includes(key)) ||
      typeof input.malId !== 'string' || !/^[1-9]\d{0,7}$/.test(input.malId) ||
      !Number.isInteger(input.episode) || Number(input.episode) < 1 || Number(input.episode) > 50_000 ||
      (input.category !== 'sub' && input.category !== 'dub') ||
      (input.force !== undefined && typeof input.force !== 'boolean')) {
    return fail(400, 'Use a numeric MAL ID, episode number, and sub or dub category.');
  }
  return input as EpisodeInput;
}
function validateRange(value: string | null): string | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return fail(400, 'Only a single byte range is supported.');
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end)) ||
      (start === null && end === 0) || (start !== null && end !== null && start > end)) {
    return fail(400, 'Invalid byte range.');
  }
  return value;
}
function mediaType(prefix: Uint8Array): string | null {
  // The provider disguises MPEG-TS segments with .jpg/.html/.js extensions and MIME types.
  for (let offset = 0; offset < Math.min(188, prefix.length - 376); offset++) {
    if (prefix[offset] === 0x47 && prefix[offset + 188] === 0x47 && prefix[offset + 376] === 0x47) return 'video/mp2t';
  }
  const box = decoder.decode(prefix.subarray(4, 8));
  if (['ftyp', 'styp', 'moof', 'sidx', 'mdat', 'moov'].includes(box)) return 'video/mp4';
  if (prefix[0] === 0xff && (prefix[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (decoder.decode(prefix.subarray(0, 3)) === 'ID3') return 'audio/aac';
  return null;
}
type HlsAttribute = { name: string; value: string; quoted: boolean };
function parseAttributes(line: string): HlsAttribute[] {
  const source = line.slice(line.indexOf(':') + 1);
  const attributes: HlsAttribute[] = [];
  const names = new Set<string>();
  let cursor = 0;
  while (cursor < source.length) {
    const match = /^\s*([A-Z][A-Z0-9-]*)\s*=\s*/.exec(source.slice(cursor));
    if (!match || names.has(match[1])) return fail(502, 'Invalid or duplicate playlist attribute.');
    cursor += match[0].length;
    const quoted = source[cursor] === '"';
    let value: string;
    if (quoted) {
      const end = source.indexOf('"', cursor + 1);
      if (end < 0) return fail(502, 'Invalid playlist attribute.');
      value = source.slice(cursor + 1, end); cursor = end + 1;
    } else {
      const end = source.indexOf(',', cursor);
      value = source.slice(cursor, end < 0 ? undefined : end).trim();
      cursor = end < 0 ? source.length : end;
      if (!value || value.includes('"')) return fail(502, 'Invalid playlist attribute.');
    }
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    if (cursor < source.length && source[cursor] !== ',') return fail(502, 'Invalid playlist attribute.');
    if (match[1] === 'URI' && (!quoted || !value.trim())) return fail(502, 'Playlist URLs must be quoted.');
    names.add(match[1]); attributes.push({ name: match[1], value, quoted });
    if (cursor < source.length && ++cursor === source.length) return fail(502, 'Invalid playlist attribute.');
  }
  return attributes;
}

export function createAnimeStreamHandler(deps: AnimeStreamDependencies): (request: Request) => Promise<Response> {
  const upstreamFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const extraHosts = new Set((deps.allowedMediaHosts ?? []).map(host => host.toLowerCase()));
  let validBase = false;
  try {
    const base = new URL(deps.publicBaseUrl);
    validBase = !base.username && !base.password && !base.search && !base.hash &&
      (base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)));
  } catch { /* Missing configuration fails closed below. */ }
  const configured = (deps.signingSecret?.length ?? 0) >= 32 && validBase;
  const key = configured ? crypto.subtle.importKey('raw', encoder.encode(deps.signingSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) : null;
  let active = 0;
  // Per-isolate protection is intentionally bounded. Production ingress should also set a
  // deployment-wide rate/bandwidth limit. Counts live only in this worker; they are
  // never logged or persisted.
  const buckets = new Map<string, { start: number; count: number }>();
  const globalBuckets = new Map<string, { start: number; count: number }>();
  function rateLimit(request: Request, resolver: boolean) {
    const timestamp = now();
    const ip = (request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').slice(0, 64);
    for (const [id, limit] of [[resolver ? 'resolve:global' : 'media:global', resolver ? 60 : 2400],
      [`${resolver ? 'resolve' : 'media'}:${ip}`, resolver ? 15 : 600]] as const) {
      const store = id.endsWith(':global') ? globalBuckets : buckets;
      let bucket = store.get(id);
      if (!bucket || timestamp - bucket.start >= 60_000) {
        if (store === buckets && buckets.size >= 512) buckets.delete(buckets.keys().next().value!);
        bucket = { start: timestamp, count: 0 };
        store.set(id, bucket);
      }
      if (++bucket.count > limit) fail(429, 'Too many stream requests. Try again shortly.');
    }
  }
  function allowedUrl(raw: string, base?: string, scope?: string): URL {
    let url: URL;
    try { url = new URL(raw, base); } catch { return fail(502, 'Unsupported media URL.'); }
    if (url.href.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.hash || /[{}]/.test(url.href) || /%(?:2e|2f|5c)/i.test(url.pathname) ||
      /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) {
      return fail(502, 'Unsupported media URL.');
    }
    const providerMedia = url.hostname === 'fetch.nexabloom.top' ||
      /^[a-z0-9]+\.(?:eclipseharbor|stellarfrontier|twilightharbor|oakhorizon)\.space$/.test(url.hostname);
    const providerSubtitle = /^[a-z0-9]+\.broforgotsave\.online$/.test(url.hostname) && /\/subtitles\/[a-zA-Z0-9_.-]+$/.test(url.pathname);
    const providerPath = /^\/anime\/[a-f0-9]{32}\/[a-f0-9]{32}\//i.test(url.pathname);
    if (!(providerMedia && providerPath) && !(providerSubtitle && providerPath) && !extraHosts.has(url.hostname)) {
      return fail(502, 'Media host or path is not allowed.');
    }
    if (scope && !url.pathname.startsWith(scope)) return fail(502, 'Media URL is outside this episode.');
    return url;
  }
  async function mint(url: string, kind: Kind, expires: number, scope: string): Promise<string> {
    const payload = base64url(encoder.encode(JSON.stringify({ v: 1, u: allowedUrl(url, undefined, scope).href, e: expires, k: kind, s: scope })));
    const signature = await crypto.subtle.sign('HMAC', await key!, encoder.encode(payload));
    const target = new URL(deps.publicBaseUrl);
    target.search = `?token=${payload}.${base64url(new Uint8Array(signature))}`;
    target.hash = '';
    return target.href;
  }
  async function verify(token: string | null): Promise<Capability> {
    if (!token || token.length > 8192 || token.split('.').length !== 2) return fail(401, 'A valid stream token is required.');
    const [payload, signature] = token.split('.');
    const signatureBytes = unbase64url(signature);
    if (signatureBytes.length !== 32 || !await crypto.subtle.verify('HMAC', await key!, signatureBytes, encoder.encode(payload))) {
      return fail(401, 'Invalid stream token.');
    }
    let value: Capability;
    try { value = JSON.parse(decoder.decode(unbase64url(payload))); } catch { return fail(401, 'Invalid stream token.'); }
    if (value.v !== 1 || typeof value.u !== 'string' || typeof value.s !== 'string' || !value.s.startsWith('/') ||
        !value.s.endsWith('/') || !Number.isSafeInteger(value.e) ||
        !['playlist', 'subtitle-playlist', 'media', 'encrypted-media', 'subtitle', 'key'].includes(value.k)) return fail(401, 'Invalid stream token.');
    if (value.e <= Math.floor(now() / 1000)) return fail(401, 'Stream expired. Retry this episode.');
    allowedUrl(value.u, undefined, value.s);
    return value;
  }
  async function rewritePlaylist(text: string, base: string, expires: number, scope: string, subtitlePlaylist: boolean): Promise<string> {
    if (!text.replace(/^\uFEFF/, '').startsWith('#EXTM3U')) return fail(502, 'The provider returned an invalid playlist.');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    let variant = false;
    let encrypted = false;
    let count = 0;
    const rewrite = async (raw: string, kind: Kind) => {
      if (!raw.trim()) return fail(502, 'The provider playlist contains an empty URL.');
      if (++count > MAX_PLAYLIST_URLS) return fail(502, 'The provider playlist has too many entries.');
      return mint(allowedUrl(raw, base, scope).href, kind, expires, scope);
    };
    const output: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { output.push(line); continue; }
      if (!trimmed.startsWith('#')) {
        output.push(await rewrite(trimmed, variant ? (subtitlePlaylist ? 'subtitle-playlist' : 'playlist')
          : encrypted ? 'encrypted-media' : subtitlePlaylist ? 'subtitle' : 'media'));
        variant = false;
        continue;
      }
      if (trimmed.startsWith('#EXT-X-STREAM-INF:')) variant = true;
      if (/^#EXT-X-(?:DEFINE|CONTENT-STEERING|SESSION-DATA):/.test(trimmed)) return fail(502, 'Unsupported playlist metadata.');
      if (/^#EXT-X-DATERANGE:/.test(trimmed) && /(?:X-ASSET-(?:URI|LIST)|com\.apple\.hls\.interstitial)/i.test(trimmed)) {
        return fail(502, 'Interstitial playlists are not supported.');
      }
      const keyTag = /^#EXT-X-(?:KEY|SESSION-KEY):/.test(trimmed);
      const attributes = keyTag || /\bURI\s*=/.test(trimmed) ? parseAttributes(trimmed) : [];
      if (keyTag) {
        const method = attributes.find(attribute => attribute.name === 'METHOD')?.value;
        const format = attributes.find(attribute => attribute.name === 'KEYFORMAT')?.value;
        if (!['AES-128', 'NONE'].includes(method ?? '') || (format && format !== 'identity')) {
          return fail(502, 'Unsupported playlist encryption.');
        }
        if (method === 'AES-128' && !attributes.some(attribute => attribute.name === 'URI')) fail(502, 'Missing playlist encryption key.');
        if (trimmed.startsWith('#EXT-X-KEY:')) encrypted = method === 'AES-128';
      }
      const attributeKind: Kind = /^#EXT-X-(?:I-FRAME-STREAM-INF|RENDITION-REPORT|IMAGE-STREAM-INF):/.test(trimmed) ? 'playlist'
        : /^#EXT-X-(?:KEY|SESSION-KEY):/.test(trimmed) ? 'key'
          : /^#EXT-X-MEDIA:/.test(trimmed) ? attributes.find(attribute => attribute.name === 'TYPE')?.value === 'SUBTITLES'
            ? 'subtitle-playlist' : 'playlist' : encrypted ? 'encrypted-media' : 'media';
      // URI attributes in keys, maps, alternate audio/subtitles, parts and preload hints.
      for (const attribute of attributes) {
        if (attribute.name === 'URI') attribute.value = await rewrite(attribute.value, attributeKind);
        if (attribute.name === 'SERVER-URI') fail(502, 'Unsupported playlist metadata.');
      }
      output.push(attributes.length ? trimmed.slice(0, trimmed.indexOf(':') + 1) +
        attributes.map(attribute => `${attribute.name}=${attribute.quoted ? `"${attribute.value}"` : attribute.value}`).join(',') : line);
    }
    return output.join('\n');
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!['POST', 'GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
    if (!configured || !deps.publicBaseUrl) return json({ error: 'Anime streaming is not configured.' }, 503);
    const controller = new AbortController();
    const onDisconnect = () => controller.abort(new Error('Client disconnected.'));
    request.signal.addEventListener('abort', onDisconnect, { once: true });
    if (request.signal.aborted) onDisconnect();
    const timer = setTimeout(() => controller.abort(new Error('Upstream request timed out.')), request.method === 'POST' ? 18_000 : TIMEOUT_MS);
    let streaming = false;
    let acquired = false;
    let finished = false;
    let streamAbort: (() => void) | undefined;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onDisconnect);
      if (streamAbort) controller.signal.removeEventListener('abort', streamAbort);
      if (acquired) active--;
    };
    try {
      rateLimit(request, request.method === 'POST');
      if (active >= 24) fail(503, 'Streaming is busy. Try again shortly.');
      active++; acquired = true;
      const signal = controller.signal;
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415, 'Send a JSON episode request.');
        if (Number(request.headers.get('content-length')) > 1024) fail(413, 'Episode request is too large.');
        const requestBytes = await readBounded(request.body, 1024, signal);
        let body: unknown;
        try { body = JSON.parse(decoder.decode(requestBytes)); }
        catch { return fail(400, 'Invalid JSON request.'); }
        const input = episodeInput(body);
        const resolved = await abortable(deps.resolveEpisode(input, { signal }), signal);
        const expires = Math.floor(now() / 1000) + TTL_SECONDS;
        const resolvedUrl = allowedUrl(resolved.url);
        const scope = resolvedUrl.pathname.match(/^\/anime\/[a-f0-9]{32}\/[a-f0-9]{32}\//i)?.[0] ??
          resolvedUrl.pathname.slice(0, resolvedUrl.pathname.lastIndexOf('/') + 1);
        const subtitles = resolved.subtitles ? await Promise.all(resolved.subtitles.slice(0, 30).map(async track => {
          // The numeric resolver may return shared captions for a dub from the sub's
          // directory. Each caption gets its own signed scope and cannot mint children.
          const captionUrl = allowedUrl(track.url);
          const captionScope = captionUrl.pathname.slice(0, captionUrl.pathname.lastIndexOf('/') + 1);
          return { url: await mint(captionUrl.href, 'subtitle', expires, captionScope), lang: track.lang, label: track.label };
        })) : undefined;
        return json({ url: await mint(resolved.url, 'playlist', expires, scope), isM3U8: true,
          embedUrl: resolved.embedUrl, category: resolved.category,
          availableCategories: resolved.availableCategories ?? [resolved.category],
          intro: resolved.intro, outro: resolved.outro, ...(subtitles ? { subtitles } : {}) });
      }

      const capability = await verify(new URL(request.url).searchParams.get('token'));
      const isPlaylist = capability.k === 'playlist' || capability.k === 'subtitle-playlist';
      const range = validateRange(request.headers.get('range'));
      if (range && isPlaylist) fail(400, 'Byte ranges are not supported for playlists.');
      const headers = new Headers(PROVIDER_HEADERS);
      if (range) headers.set('Range', range);
      let target = allowedUrl(capability.u, undefined, capability.s);
      let upstream: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects++) {
        upstream = await abortable(upstreamFetch(target.href, { method: request.method, headers, redirect: 'manual', signal }), signal);
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        const location = upstream.headers.get('location');
        void upstream.body?.cancel().catch(() => undefined);
        if (!location || redirects === 3) fail(502, 'Invalid media redirect.');
        target = allowedUrl(location, target.href, capability.s);
      }
      if (!upstream) fail(502, 'The stream is unavailable.');
      const outputHeaders = new Headers({ ...CORS, 'Cache-Control': 'private, no-store' });
      for (const name of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) outputHeaders.set(name, value);
      }
      if (upstream.status === 416) {
        outputHeaders.delete('content-length');
        void upstream.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 416, headers: outputHeaders });
      }
      if (upstream.status !== 200 && upstream.status !== 206) {
        void upstream.body?.cancel().catch(() => undefined);
        fail(502, 'The upstream stream is unavailable.');
      }
      if (upstream.status === 206 && (!range || !/^bytes \d+-\d+\/(?:\d+|\*)$/.test(upstream.headers.get('content-range') ?? ''))) {
        void upstream.body?.cancel().catch(() => undefined);
        fail(502, 'Invalid partial stream response.');
      }
      if (upstream.status !== 206) outputHeaders.delete('content-range');
      if (upstream.headers.get('content-encoding') && upstream.headers.get('content-encoding') !== 'identity') outputHeaders.delete('content-length');
      outputHeaders.set('Content-Type', isPlaylist ? 'application/vnd.apple.mpegurl'
        : capability.k === 'subtitle' ? 'text/vtt; charset=utf-8' : 'application/octet-stream');
      if (isPlaylist) {
        outputHeaders.delete('content-length'); outputHeaders.delete('etag');
        outputHeaders.delete('last-modified'); outputHeaders.delete('accept-ranges');
      }
      if (request.method === 'HEAD') {
        void upstream.body?.cancel().catch(() => undefined);
        return new Response(null, { status: upstream.status, headers: outputHeaders });
      }
      if (isPlaylist) {
        const text = decoder.decode(await readBounded(upstream.body, MAX_PLAYLIST_BYTES, signal));
        return new Response(await rewritePlaylist(text, target.href, capability.e, capability.s, capability.k === 'subtitle-playlist'), { headers: outputHeaders });
      }
      if (capability.k === 'key') {
        const bytes = await readBounded(upstream.body, 32, signal);
        if (bytes.length !== 16) fail(502, 'Invalid HLS encryption key.');
        return new Response(bytes, { status: upstream.status, headers: outputHeaders });
      }
      if (!upstream.body) fail(502, 'The provider returned an empty stream.');
      const reader = upstream.body.getReader();
      const prefetched: Uint8Array[] = [];
      const prefix = new Uint8Array(1024);
      let prefixLength = 0;
      try {
        while (prefixLength < prefix.length) {
          const { value, done } = await abortable(reader.read(), signal);
          if (done) break;
          prefetched.push(value);
          const portion = value.subarray(0, prefix.length - prefixLength);
          prefix.set(portion, prefixLength); prefixLength += portion.length;
        }
        const partialMidFile = upstream.status === 206 && !upstream.headers.get('content-range')!.startsWith('bytes 0-');
        const probe = prefix.subarray(0, prefixLength);
        if (capability.k === 'subtitle') {
          if (!partialMidFile && !/^\uFEFF?WEBVTT(?:\s|$)/.test(decoder.decode(probe))) fail(502, 'The provider returned invalid subtitles.');
        } else if (capability.k === 'encrypted-media') {
          if (!prefixLength || /^(?:<!doctype|<html|<script|<body)/i.test(decoder.decode(probe).trimStart())) fail(502, 'Invalid encrypted media.');
          outputHeaders.set('Content-Type', 'application/octet-stream');
        } else {
          const detected = mediaType(probe);
          if (!detected && !partialMidFile) fail(502, 'The provider returned unsupported media.');
          outputHeaders.set('Content-Type', detected ?? 'application/octet-stream');
        }
      } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
      streaming = true;
      let chunkIndex = 0;
      const responseBody = new ReadableStream<Uint8Array>({
        start(destination) {
          streamAbort = () => {
            void reader.cancel().catch(() => undefined); cleanup();
            try { destination.error(signal.reason); } catch { /* Already closed. */ }
          };
          signal.addEventListener('abort', streamAbort, { once: true });
          if (signal.aborted) streamAbort();
        },
        async pull(destination) {
          try {
            if (signal.aborted) throw signal.reason;
            if (chunkIndex < prefetched.length) { destination.enqueue(prefetched[chunkIndex++]); return; }
            const { value, done } = await abortable(reader.read(), signal);
            if (done) { cleanup(); destination.close(); } else destination.enqueue(value);
          } catch (error) {
            controller.abort(error); void reader.cancel().catch(() => undefined); cleanup(); destination.error(error);
          }
        },
        cancel() { controller.abort(new Error('Client cancelled stream.')); cleanup(); return reader.cancel(); },
      });
      return new Response(responseBody, { status: upstream.status, headers: outputHeaders });
    } catch (error) {
      return json({ error: error instanceof RelayError ? error.message : controller.signal.aborted
        ? 'The stream request timed out or was cancelled.' : 'The stream is temporarily unavailable.' },
      error instanceof RelayError ? error.status : controller.signal.aborted ? 504 : 502);
    } finally { if (!streaming) cleanup(); }
  };
}
