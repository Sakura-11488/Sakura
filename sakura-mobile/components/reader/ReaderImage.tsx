import React from 'react';
import { Image, type ImageProps } from 'expo-image';

export type ReaderImageProps = Pick<ImageProps,
  'style' | 'contentFit' | 'transition' | 'recyclingKey' | 'onLoad' | 'onError' | 'accessibilityLabel'
> & {
  source: { uri: string };
  isVisible: boolean;
  retryAttempt: number;
};

/** Keep native image caching, sizing and callbacks unchanged. */
export default function ReaderImage({ isVisible: _visible, retryAttempt: _attempt, ...props }: ReaderImageProps) {
  return <Image {...props} />;
}
