import React from 'react';
import type { ReaderImageProps } from './ReaderImage';
import { readerImageUrl } from '@/lib/reader-image-url';

/**
 * Keep the browser image mounted after errors and while the shared loading
 * deadline runs. Only an explicit retry changes its parent request key.
 */
export default function ReaderImage({
  source, isVisible, retryAttempt, onLoad, onError, accessibilityLabel,
}: ReaderImageProps) {
  const eager = isVisible || retryAttempt > 0;
  return (
    <img
      src={readerImageUrl(source.uri)}
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
      onError={() => onError?.({ error: 'The reader image could not load.' })}
    />
  );
}
