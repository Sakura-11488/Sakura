import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import type { CoverImageProps } from './CoverImage';
import { coverThumbnailUrl } from '@/lib/cover-thumbnail';

function RemoteCover({ uri, ...props }: CoverImageProps & { uri: string }) {
  const { style, accessibilityLabel, contentFit, contentPosition, priority, loading, thumbnailWidth = 256, onLoad, onLoadEnd, onError } = props;
  const thumbnail = coverThumbnailUrl(uri, thumbnailWidth);
  const eager = loading === 'eager' || (loading !== 'lazy' && priority === 'high');
  const containerRef = useRef<View>(null);
  const [visible, setVisible] = useState(eager);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = fallback ? uri : thumbnail;

  useEffect(() => {
    if (visible) return;
    if (eager || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const element = containerRef.current as unknown as Element | null;
    if (!element) return;
    // Browser loading="lazy" can fetch several screens ahead. Only attach a
    // source near the visible viewport, including clipped horizontal shelves.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px', threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, visible]);

  return (
    <View ref={containerRef} style={[{ overflow: 'hidden' }, style]}>
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
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: contentFit === 'contain' ? 'contain' : 'cover', objectPosition: typeof contentPosition === 'string' ? contentPosition : undefined }}
          onLoad={event => {
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
