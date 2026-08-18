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

export function isSakuraMediaUrl(url: string): boolean {
  try {
    return isDropletHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
