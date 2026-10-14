import React from 'react';
import { View } from 'react-native';
import type { TapSurfaceProps } from './TapSurface';
import { hasTextSelection } from './reader-platform';

/**
 * The reading surface's tap target (web).
 *
 * A plain click listener rather than Pressable: Pressable would make the whole
 * chapter a focusable, pointer-cursor "button" (tabIndex 0, cursor: pointer).
 * Clicks on real controls inside (the end-of-chapter card) and clicks that end
 * a text selection are ignored, so selecting a sentence to copy never turns
 * the page.
 */
export default function TapSurface({ onTap, windowWidth, style, children }: TapSurfaceProps) {
  const onClick = (event: { target: EventTarget | null; clientX: number }) => {
    const el = event.target as HTMLElement | null;
    if (el?.closest?.('button, a, input, select, textarea, [role="button"], [role="link"]')) return;
    if (hasTextSelection()) return;
    const width = windowWidth || window.innerWidth || 1;
    onTap(event.clientX / width);
  };
  // react-native-web forwards onClick to the DOM node; the RN View type lacks it.
  const webProps = { onClick } as unknown as Record<string, unknown>;
  return (
    <View style={style} {...webProps}>
      {children}
    </View>
  );
}
