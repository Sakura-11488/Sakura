/** Resolve the provider's public source response without running its player or scripts. */
export type EpisodeInput = {
  malId: string;
  episode: number;
  category: 'sub' | 'dub';
  force?: boolean;
};

export type ResolvedEpisode = {
  url: string;
  isM3U8: true;
  embedUrl: string;
  category: 'sub' | 'dub';
  availableCategories: ('sub' | 'dub')[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  subtitles?: Array<{ url: string; lang: string; label: string }>;
};

const ORIGIN = 'https://megaplay.buzz';
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_TEXT_BYTES = 512 * 1024;
const encoder = new TextEncoder();

type ProviderOptions = { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number };
type PublicEncoding = { key: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> };
let cachedEncoding: { expires: number; value: PublicEncoding; fetcher: typeof fetch } | undefined;

function providerUrl(raw: string): URL {
  const url = new URL(raw, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
      !/^\/(?:stream\/(?:mal\/\d+\/\d+\/(?:sub|dub)|s-\d+\/\d+\/(?:sub|dub)|getSources(?:New)?)|lib\/app\.main\.js)$/.test(url.pathname)) {
    throw new Error('Unsupported provider URL.');
  }
  return url;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) throw new Error('Empty provider response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TEXT_BYTES) throw new Error('Provider response is too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function getText(raw: string, options: ProviderOptions, referer = ORIGIN + '/'): Promise<string> {
  let url = providerUrl(raw);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  for (let hop = 0; hop < 4; hop++) {
    const response = await (options.fetch ?? fetch)(url.href, {
      redirect: 'manual', signal,
      headers: {
        'User-Agent': USER_AGENT, Referer: referer, Origin: ORIGIN,
        Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Missing provider redirect.');
      url = providerUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Provider returned HTTP ${response.status}.`);
    }
    return await readLimited(response);
  }
  throw new Error('Too many provider redirects.');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function findFile(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) {
      const file = findFile(entry, depth + 1);
      if (file) return file;
    }
    return null;
  }
  const row = record(value);
  if (!row) return null;
  for (const key of ['file', 'url', 'link', 'hls']) {
    if (typeof row[key] === 'string' && /^https:\/\//.test(row[key])) return row[key];
  }
  for (const key of ['sources', 'source', 'data', 'result']) {
    const file = findFile(row[key], depth + 1);
    if (file) return file;
  }
  return null;
}

function publicEncoding(script: string): PublicEncoding {
  // Parse two JSON string literals; never eval provider JavaScript. These are
  // public URL-obfuscation constants from app.main.js, not media/DRM keys.
  const literal = (name: string) => {
    const match = script.match(new RegExp(`\\b${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!match) throw new Error('Provider source encoding has changed.');
    const value: unknown = JSON.parse(match[1]);
    if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Invalid provider encoding.');
    return value;
  };
  const padded = (text: string, length: number) => {
    const bytes = new Uint8Array(length);
    bytes.set(encoder.encode(text).subarray(0, length));
    return bytes;
  };
  return { key: padded(literal('DOMAINS_ENC_KEY'), 32), iv: padded(literal('DOMAINS_ENC_IV'), 16) };
}

async function encodingFor(html: string, options: ProviderOptions, force: boolean): Promise<PublicEncoding> {
  const now = (options.now ?? Date.now)();
  const fetcher = options.fetch ?? fetch;
  if (!force && cachedEncoding && cachedEncoding.fetcher === fetcher && cachedEncoding.expires > now) return cachedEncoding.value;
  const script = html.match(/<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/lib\/app\.main\.js(?:\?[^"']*)?)["']/i)?.[1];
  if (!script) throw new Error('Provider source encoding is unavailable.');
  const source = await getText(script.replace(/&amp;/g, '&'), options);
  const value = publicEncoding(source);
  cachedEncoding = { value, expires: now + 10 * 60_000, fetcher };
  return value;
}

async function decodeSource(payload: Record<string, unknown>, html: string, options: ProviderOptions, force: boolean): Promise<Record<string, unknown>> {
  if (findFile(payload)) return payload;
  if (typeof payload.enc !== 'string' || !/^[A-Za-z0-9_+/=-]+$/.test(payload.enc) || payload.enc.length > MAX_TEXT_BYTES) {
    throw new Error('Provider returned no stream.');
  }
  const encoding = await encodingFor(html, options, force);
  let base64 = payload.enc.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - base64.length % 4) % 4);
  const encrypted = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', encoding.key, 'AES-CBC', false, ['decrypt']);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: encoding.iv }, key, encrypted);
  const decoded = record(JSON.parse(new TextDecoder().decode(bytes)));
  if (!decoded) throw new Error('Invalid provider source response.');
  return { ...payload, ...decoded };
}

function marker(value: unknown): { start: number; end: number } | undefined {
  const row = record(value);
  return row && typeof row.start === 'number' && typeof row.end === 'number' &&
    Number.isFinite(row.start) && Number.isFinite(row.end) && row.start >= 0 && row.end > row.start
    ? { start: row.start, end: row.end } : undefined;
}

function subtitles(payload: Record<string, unknown>): ResolvedEpisode['subtitles'] {
  const tracks = payload.tracks ?? record(payload.data)?.tracks;
  if (!Array.isArray(tracks)) return undefined;
  return tracks.slice(0, 40).flatMap((track) => {
    const row = record(track);
    if (!row || (row.kind !== 'captions' && row.kind !== 'subtitles')) return [];
    const url = row.file ?? row.url;
    if (typeof url !== 'string' || !url.startsWith('https://')) return [];
    const label = typeof row.label === 'string' ? row.label.slice(0, 80) : 'Subtitles';
    const lang = typeof row.srclang === 'string' ? row.srclang.slice(0, 20)
      : /^english/i.test(label) ? 'en' : 'und';
    return [{ url, lang, label }];
  });
}

export async function resolveEpisode(input: EpisodeInput, options: ProviderOptions = {}): Promise<ResolvedEpisode> {
  if (!/^[1-9]\d{0,7}$/.test(input.malId) || !Number.isSafeInteger(input.episode) ||
      input.episode < 1 || input.episode > 50_000 || !['sub', 'dub'].includes(input.category)) {
    throw new Error('Invalid episode request.');
  }
  const embedUrl = `${ORIGIN}/stream/mal/${input.malId}/${input.episode}/${input.category}`;
  let playerUrl = embedUrl;
  let html = await getText(playerUrl, options, 'https://hianime.dk/');
  let dataId = html.match(/\bdata-id\s*=\s*["'](\d{1,12})["']/i)?.[1];
  if (!dataId) {
    const frames = [...html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)];
    const frame = frames.find((match) => /\/stream\/s-\d+\/\d+\/(?:sub|dub)/.test(match[1]));
    if (frame) {
      playerUrl = providerUrl(frame[1].replace(/&amp;/g, '&')).href;
      html = await getText(playerUrl, options, embedUrl);
      dataId = html.match(/\bdata-id\s*=\s*["'](\d{1,12})["']/i)?.[1];
    }
  }
  if (!dataId) throw new Error('Episode is unavailable from the provider.');

  let payload: Record<string, unknown> | null = null;
  for (const endpoint of ['getSourcesNew', 'getSources']) {
    try {
      const raw = record(JSON.parse(await getText(`${ORIGIN}/stream/${endpoint}?id=${dataId}`, options, playerUrl)));
      if (raw && (findFile(raw) || typeof raw.enc === 'string')) { payload = raw; break; }
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  if (!payload) throw new Error('Provider stream could not be resolved.');
  payload = await decodeSource(payload, html, options, !!input.force);
  const url = findFile(payload);
  if (!url || !new URL(url).pathname.endsWith('.m3u8')) throw new Error('Provider returned no supported HLS stream.');
  return {
    url, isM3U8: true, embedUrl, category: input.category,
    availableCategories: ['sub', 'dub'],
    intro: marker(payload.intro ?? record(payload.data)?.intro),
    outro: marker(payload.outro ?? record(payload.data)?.outro),
    subtitles: subtitles(payload),
  };
}
