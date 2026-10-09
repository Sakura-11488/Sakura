import React from 'react';
import { Image, type ImageProps } from 'expo-image';

export type CoverImageProps = ImageProps & { thumbnailWidth?: 256 | 512 };

/** Native uses Expo's existing image cache and rendering. */
export default function CoverImage({ thumbnailWidth: _width, ...props }: CoverImageProps) {
  return <Image {...props} />;
}
