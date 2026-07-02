import { supabase } from '@/lib/supabase';

export type ContentProxySource = 'atsu' | 'comics' | 'consumet' | 'novel' | 'upstream';

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

const MEDIA_HOST = '165-232-83-159.nip.io';

/** Rewrite Sakura media-server HTTP URLs to an HTTPS media proxy (web only). */
export function getWebMediaProxyUrl(mediaPathOrUrl: string): string {
  const sameOriginProxy = typeof window !== 'undefined' ? '/api/media-proxy/' : '';

  const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  if (!supabaseUrl && !sameOriginProxy) return mediaPathOrUrl;

  let path = mediaPathOrUrl;
  if (mediaPathOrUrl.startsWith('http://') || mediaPathOrUrl.startsWith('https://')) {
    try {
      const parsed = new URL(mediaPathOrUrl);
      if (parsed.hostname === MEDIA_HOST || parsed.hostname === '165.232.83.159') {
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
    const host = new URL(url).hostname;
    return host === MEDIA_HOST || host === '165.232.83.159';
  } catch {
    return false;
  }
}
