import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import type { CoverImageProps } from './CoverImage';
import { coverThumbnailUrl } from '@/lib/cover-thumbnail';

/**
 * Lookahead, as a margin around the scroller the cover sits in: how far
 * outside the visible area a cover starts loading.
 *
 * Measured fast-scrolling the browse grid on a phone profile (1,500 px/s, Fast
 * 4G), a fifth of the cards in view were still blank: covers only started
 * once they were on screen, and each took ~200 ms. On a phone 1.5 screens
 * below the view is about a second of scrolling, more than a cover's round
 * trip. Desktop scrolls a taller view and showed 3 % blank, so it looks ahead
 * less. Above the view matters little: a cover, once loaded, stays.
 */
const PHONE_LOOKAHEAD = '50% 0px 150% 0px';
const DESKTOP_LOOKAHEAD = '25% 0px 75% 0px';

function lookahead(): string {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return DESKTOP_LOOKAHEAD;
  return window.matchMedia('(pointer: coarse), (max-width: 700px)').matches ? PHONE_LOOKAHEAD : DESKTOP_LOOKAHEAD;
}

/**
 * One IntersectionObserver per scroller, shared by every cover in it, rather
 * than one per cover.
 *
 * The root matters. The web screens scroll an inner element (`overflow:auto`
 * on .manga-home-web, .browse-catalog-web), not the window, and an observer
 * rooted at the window applies its rootMargin to the window only: the
 * scroller's own edge still clips every cover below it, so the old '200px'
 * margin never let anything load early. A screen marks its scroller with
 * `data-cover-root`; covers anywhere else keep the window as root. Horizontal
 * rails inside the scroller still clip as before, so a rail does not load
 * covers it has not been scrolled to.
 *
 * Keyed weakly. A cover that has loaded stops observing and never runs a
 * cleanup again, so when every cover in a scroller had loaded, nothing was
 * left to notice the scroller leave the page: a Map kept each closed screen's
 * whole detached DOM tree alive, one more per browse page opened.
 */
const rootObservers = new WeakMap<Element, IntersectionObserver>();
let windowObserver: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, () => void>();

function observeNear(element: Element, onNear: () => void): () => void {
  const root = element.parentElement?.closest('[data-cover-root]') ?? null;
  let observer = root ? rootObservers.get(root) : windowObserver;
  if (!observer) {
    const created = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = callbacks.get(entry.target);
        callbacks.delete(entry.target);
        created.unobserve(entry.target);
        callback?.();
      }
    }, { root, rootMargin: lookahead(), threshold: 0 });
    if (root) rootObservers.set(root, created);
    else windowObserver = created;
    observer = created;
  }
  const active = observer;
  callbacks.set(element, onNear);
  active.observe(element);
  return () => {
    callbacks.delete(element);
    active.unobserve(element);
    // A scroller that has left the page keeps no observer behind.
    if (root && !root.isConnected) {
      active.disconnect();
      rootObservers.delete(root);
    }
  };
}

/** A remote URL the cover can show underneath while its own image loads. */
function placeholderUri(placeholder: CoverImageProps['placeholder']): string | null {
  if (typeof placeholder === 'string') return /^https?:\/\/|^\/api\//.test(placeholder) ? placeholder : null;
  if (placeholder && typeof placeholder === 'object' && !Array.isArray(placeholder) && 'uri' in placeholder) {
    const uri = (placeholder as { uri?: unknown }).uri;
    return typeof uri === 'string' && /^https?:\/\/|^\/api\//.test(uri) ? uri : null;
  }
  return null;
}

/** Neutral on both themes; shown only until the image has loaded. */
const LOADING_TINT = 'rgba(128,128,128,0.12)';

function RemoteCover({ uri, ...props }: CoverImageProps & { uri: string }) {
  const { style, accessibilityLabel, contentFit, contentPosition, priority, loading, thumbnailWidth = 256, onLoad, onLoadEnd, onError, placeholder } = props;
  const thumbnail = coverThumbnailUrl(uri, thumbnailWidth);
  const eager = loading === 'eager' || (loading !== 'lazy' && priority === 'high');
  const containerRef = useRef<View>(null);
  const [visible, setVisible] = useState(eager);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = fallback ? uri : thumbnail;
  // Usually the card's own cover, already in the HTTP cache at the card size
  // (256), drawn under the larger image until that one arrives: a title page
  // shows the cover it was opened from instead of an empty frame.
  const under = placeholderUri(placeholder);
  const underSrc = under ? coverThumbnailUrl(under, 256) : null;

  useEffect(() => {
    if (visible) return;
    if (eager || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const element = containerRef.current as unknown as Element | null;
    if (!element) return;
    return observeNear(element, () => setVisible(true));
  }, [eager, visible]);

  const fit = contentFit === 'contain' ? 'contain' : 'cover';
  const position = typeof contentPosition === 'string' ? contentPosition : undefined;

  return (
    <View ref={containerRef} style={[{ overflow: 'hidden' }, !loaded && !failed && !underSrc ? { backgroundColor: LOADING_TINT } : null, style]}>
      {underSrc && !loaded && !failed && underSrc !== src ? (
        <img src={underSrc} alt="" aria-hidden="true" decoding="async" draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, objectPosition: position }} />
      ) : null}
      {failed ? (
        <div role="img" aria-label={accessibilityLabel ? `${accessibilityLabel}: cover unavailable` : 'Cover unavailable'}
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(128,128,128,0.12)', color: '#999' }}>
          <svg width="32" height="40" viewBox="0 0 24 30" fill="none" aria-hidden="true">
            <rect x="3" y="2" width="18" height="26" rx="3" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 2v26M11 9h6M11 14h6" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      ) : visible ? (
        <img key={src} src={src} alt={accessibilityLabel || ''}
          loading="eager"
          fetchPriority={priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'auto'}
          decoding="async" draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, objectPosition: position }}
          onLoad={event => {
            setLoaded(true);
            onLoad?.({ cacheType: 'none', source: { url: src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight, mediaType: 'image' } });
            onLoadEnd?.();
          }}
          onError={() => {
            if (!fallback && thumbnail !== uri) setFallback(true);
            else {
              setFailed(true);
              onError?.({ error: 'The cover image could not be loaded.' });
              onLoadEnd?.();
            }
          }}
        />
      ) : null}
    </View>
  );
}

/** A stable browser image avoids transition layers removing failed cover nodes. */
export default function CoverImage(props: CoverImageProps) {
  const { source, thumbnailWidth: _width, ...imageProps } = props;
  const uri = typeof source === 'string' ? source : source && typeof source === 'object' && !Array.isArray(source) && 'uri' in source ? source.uri : undefined;
  if (uri && /^https?:\/\/|^\/api\//.test(uri)) return <RemoteCover key={uri} {...props} uri={uri} />;
  // Bundled assets are optimized during web export; preserve Expo's asset resolution.
  return <Image {...imageProps} source={source} />;
}
