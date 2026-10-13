import React, { useState } from 'react';
import type { ReaderImageProps } from './ReaderImage';
import {
  atsuPageCdnUrl,
  getWebMangaPageFallbackUrl,
  getWebMangaPageProxyUrl,
} from '@/lib/content-proxy-client';

/** Same-origin Vercel function (sakura-web api/media-proxy.js). */
const MEDIA_PROXY_PATH = '/api/media-proxy/';

/**
 * A retry has to reach the origin, not the copy of the failure the edge kept.
 *
 * /api/media-proxy/ has sent `public, max-age=3600` with every status,
 * errors included, so a manhwa / comics / 18+ page (or atsu fallback) whose
 * first load failed — droplet busy, scraper hiccup — failed again on every
 * Retry for the next hour, served from Vercel's edge or the browser cache.
 * Both key on the full URL, so a retry adds `r=<attempt>.<mount>`: media-proxy
 * reads only `path`, which is left untouched, so its allowlist sees what it
 * always did. Attempt 0 keeps the plain URL to share the cache with everyone
 * else.
 *
 * Not the attempt number alone: the edge cache is shared by every reader and
 * the browser cache outlives this page, so a bare `r=1` is itself a failure
 * someone cached an hour ago (live, a media-proxy 404 is an edge HIT on its
 * second request). `mount` is new each time ReaderPageImage remounts the image
 * for a retry; the attempt covers a retry that reuses the element.
 *
 * Only media-proxy URLs. /api/manga-page/ 400s any parameter other than `u`
 * (it keeps one edge entry per page) and never caches an error anyway, and
 * blob: / offline URLs have no cache to bypass.
 */
function withRetryCacheBust(url: string, retryAttempt: number, mount: string): string {
  if (retryAttempt <= 0 || !url.startsWith(MEDIA_PROXY_PATH)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}r=${retryAttempt}.${mount}`;
}

/**
 * Keep the browser image mounted after errors and while the shared loading
 * deadline runs. Only an explicit retry changes its parent request key.
 *
 * atsu pages get one quiet second route before a failure is reported: the
 * same CDN page through the droplet's image proxy (getWebMangaPageFallbackUrl),
 * which serves both atsu page-path shapes. /api/manga-page/ stays first because
 * the droplet is one small worker shared by every scraped source; the fallback
 * only carries the pages the primary could not. A retry starts again from the
 * primary — whatever broke it may well have cleared.
 */
export default function ReaderImage({
  source, isVisible, retryAttempt, onLoad, onError, accessibilityLabel,
}: ReaderImageProps) {
  // Which request fell back, rather than a bare flag, so a new attempt (or a
  // new page in a reused element) is back on the primary without an effect.
  const request = `${retryAttempt}:${source.uri}`;
  const [fallbackFor, setFallbackFor] = useState<string | null>(null);
  // Fixed for this mount, so the URL is stable across renders of one attempt.
  const [mount] = useState(() => Date.now().toString(36));
  const fallback = atsuPageCdnUrl(source.uri) ? getWebMangaPageFallbackUrl(source.uri) : null;
  const onFallback = fallback !== null && fallbackFor === request;
  const src = withRetryCacheBust(onFallback ? fallback : getWebMangaPageProxyUrl(source.uri), retryAttempt, mount);
  const eager = isVisible || retryAttempt > 0;
  return (
    <img
      src={src}
      alt={accessibilityLabel || ''}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'low'}
      decoding="async"
      draggable={false}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
      onLoad={(event) => {
        const image = event.currentTarget;
        onLoad?.({
          source: {
            url: image.currentSrc || source.uri,
            width: image.naturalWidth,
            height: image.naturalHeight,
            mediaType: null,
          },
          cacheType: 'none',
        });
      }}
      onError={() => {
        if (fallback !== null && !onFallback) setFallbackFor(request);
        else onError?.({ error: 'The reader image could not load.' });
      }}
    />
  );
}
