import React, { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import type { CoverImageProps } from './CoverImage';
import { coverThumbnailUrl } from '@/lib/cover-thumbnail';

function RemoteCover({ uri, ...props }: CoverImageProps & { uri: string }) {
  const { style, accessibilityLabel, contentFit, priority, loading, thumbnailWidth = 256 } = props;
  const thumbnail = coverThumbnailUrl(uri, thumbnailWidth);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = fallback ? uri : thumbnail;
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      {failed ? (
        <div role="img" aria-label={accessibilityLabel ? `${accessibilityLabel}: cover unavailable` : 'Cover unavailable'}
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(128,128,128,0.12)', color: '#999' }}>
          <svg width="32" height="40" viewBox="0 0 24 30" fill="none" aria-hidden="true">
            <rect x="3" y="2" width="18" height="26" rx="3" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 2v26M11 9h6M11 14h6" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      ) : (
        <img key={src} src={src} alt={accessibilityLabel || ''}
          loading={loading || (priority === 'high' ? 'eager' : 'lazy')}
          fetchPriority={priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'auto'}
          decoding="async" draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: contentFit === 'contain' ? 'contain' : 'cover' }}
          onError={() => {
            if (!fallback && thumbnail !== uri) setFallback(true);
            else setFailed(true);
          }}
        />
      )}
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
