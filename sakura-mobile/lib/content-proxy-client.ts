import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { isDropletHost } from './content-hosts';

export type ContentProxySource =
  | 'atsu'
  | 'comics'
  | 'hentai'
  | 'manhwa'
  | 'consumet'
  | 'novel'
  | 'upstream';

export type ContentProxyRequest = {
  source: ContentProxySource;
  path?: string;
  url?: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  responseFormat?: 'json' | 'html' | 'text';
};

async function parseInvokeError(error: { message?: string; context?: Response }): Promise<string> {
  if (error.context) {
    try {
      const body = await error.context.json();
      if (body && typeof body === 'object' && 'error' in body && body.error) {
        return String(body.error);
      }
    } catch {
      // ignore JSON parse failures
    }
  }

  const message = error.message || '';
  if (message.includes('non-2xx') || message.includes('404')) {
    return 'Content proxy is not available. Deploy the web-content-proxy Supabase edge function.';
  }

  return message || 'Content proxy request failed.';
}

/** Invoke Supabase edge function so the browser never hits upstream APIs directly. */
export async function invokeContentProxy<T>(req: ContentProxyRequest): Promise<T> {
  const { data, error } = await supabase.functions.invoke('web-content-proxy', {
    body: req,
  });

  if (error) {
    throw new Error(await parseInvokeError(error));
  }

  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error));
  }

  return data as T;
}

/** Rewrite Sakura media-server HTTP URLs to an HTTPS media proxy (web only). */
export function getWebMediaProxyUrl(mediaPathOrUrl: string): string {
  /**
   * Idempotent. This is load-bearing, not defensive tidiness.
   *
   * The scraper adapters already return a proxied URL on web —
   * comics.ts:75, manhwa.ts:86 and hentai.ts:83 all end
   * `Platform.OS === 'web' ? getWebMediaProxyUrl(proxied) : proxied`. Wrapping
   * that a second time produced `/api/media-proxy/?path=%2Fapi%2Fmedia-proxy…`,
   * because a relative input skips the http(s) branch below and falls through
   * to the encoder. No pattern in sakura-web/api/media-proxy.js ALLOWED_PATHS
   * matches a path starting `/api/`, so it 400s "Invalid Sakura media path".
   *
   * Verified against production: the single-wrapped form reaches the droplet
   * and returns a genuine upstream status, the double-wrapped form is rejected
   * at the allowlist. Every comics, manhwa and 18+ page download on web failed
   * on 100% of pages because of this, and the resulting message —
   * "Pages could not be downloaded in the browser" — blamed the browser, which
   * is why it was never reported as a bug.
   *
   * Purely additive: every input caught here 400s today, so there is no working
   * behaviour to regress.
   */
  if (
    mediaPathOrUrl.startsWith('/api/media-proxy/') ||
    mediaPathOrUrl.includes('/functions/v1/web-media-proxy')
  ) {
    return mediaPathOrUrl;
  }

  const sameOriginProxy = typeof window !== 'undefined' ? '/api/media-proxy/' : '';

  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  if (!supabaseUrl && !sameOriginProxy) return mediaPathOrUrl;

  let path = mediaPathOrUrl;
  if (mediaPathOrUrl.startsWith('http://') || mediaPathOrUrl.startsWith('https://')) {
    try {
      const parsed = new URL(mediaPathOrUrl);
      if (isDropletHost(parsed.hostname)) {
        path = parsed.pathname + parsed.search;
      } else {
        return mediaPathOrUrl;
      }
    } catch {
      return mediaPathOrUrl;
    }
  }

  if (!path.startsWith('/')) path = `/${path}`;
  if (sameOriginProxy) return `${sameOriginProxy}?path=${encodeURIComponent(path)}`;
  return `${supabaseUrl}/functions/v1/web-media-proxy?path=${encodeURIComponent(path)}`;
}

/**
 * atsu chapter pages, and how a browser gets at them.
 *
 * atsu moved its page images to the CDN host: https://atsu.moe/static/pages/…
 * now answers 410 Gone with an HTML body, which broke the reader on every
 * platform and made the web reader show "Page 1 could not load" for every atsu
 * chapter. https://cdn.atsu.moe/static/pages/… serves them, but only to clients
 * that look like servers: it 403s the Sec-Fetch headers a browser <img> sends
 * and returns no Access-Control-Allow-Origin to fetch(). Native sends neither,
 * so native uses the CDN URL directly; web has to go through a same-origin
 * proxy.
 */
const ATSU_PAGE_HOSTS = new Set(['atsu.moe', 'www.atsu.moe', 'cdn.atsu.moe']);
const ATSU_PAGE_CDN = 'https://cdn.atsu.moe';

/**
 * Same-origin Vercel function in the hosting repo (api/manga-page.js). It
 * streams only cdn.atsu.moe/static/pages/… images, with
 * Access-Control-Allow-Origin * and immutable caching, so reading and
 * downloading atsu do not ride on the 1-worker droplet.
 */
const MANGA_PAGE_PROXY_PATH = '/api/manga-page/';

/**
 * The canonical CDN URL for an atsu chapter page, or null when `url` is not
 * one. Accepts the old atsu.moe host, protocol-relative URLs and the
 * /api/manga-page/ wrapper, so URLs cached or persisted by earlier builds
 * normalise to the same thing. Query and fragment are dropped: page URLs carry
 * none, and the proxy refuses them.
 */
export function atsuPageCdnUrl(url: string): string | null {
  if (!url) return null;
  let candidate = url;
  if (candidate.startsWith(MANGA_PAGE_PROXY_PATH)) {
    const q = candidate.indexOf('?');
    const inner = q >= 0 ? new URLSearchParams(candidate.slice(q + 1)).get('u') : null;
    if (!inner || inner.startsWith(MANGA_PAGE_PROXY_PATH)) return null;
    candidate = inner;
  }
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (!ATSU_PAGE_HOSTS.has(parsed.hostname)) return null;
  if (!parsed.pathname.startsWith('/static/pages/')) return null;
  return `${ATSU_PAGE_CDN}${parsed.pathname}`;
}

/**
 * URL the browser should load an atsu page (or chapter thumbnail) from.
 *
 * Web only; native gets its input back, because native can load the CDN
 * directly. Idempotent, and anything that is not an atsu page URL — posters,
 * other sources, already-offline /app/__offline/ URLs — passes through
 * untouched.
 */
export function getWebMangaPageProxyUrl(url: string): string {
  if (Platform.OS !== 'web') return url;
  if (url.startsWith(MANGA_PAGE_PROXY_PATH)) return url;
  const cdn = atsuPageCdnUrl(url);
  return cdn ? `${MANGA_PAGE_PROXY_PATH}?u=${encodeURIComponent(cdn)}` : url;
}

/**
 * Second route to the same atsu page, for the web downloader only: the
 * droplet's manhwa image proxy behind /api/media-proxy/, which has served
 * cdn.atsu.moe pages since before /api/manga-page/ existed. It is a fallback
 * and not the primary because the droplet is one small worker shared by every
 * scraped source; the reader never uses it. Accepts raw or proxied page URLs;
 * returns the input unchanged for anything else, and on native.
 */
export function getWebMangaPageFallbackUrl(url: string): string {
  if (Platform.OS !== 'web') return url;
  const cdn = atsuPageCdnUrl(url);
  return cdn ? getWebMediaProxyUrl(`/manhwa/v1/img?u=${encodeURIComponent(cdn)}`) : url;
}

export function isSakuraMediaUrl(url: string): boolean {
  try {
    return isDropletHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
