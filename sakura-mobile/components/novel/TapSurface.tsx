import React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

export interface TapSurfaceProps {
  /** x as a fraction of the window width (0 = left edge). */
  onTap: (xFraction: number) => void;
  windowWidth: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/**
 * The reading surface's tap target (native).
 *
 * The old reader toggled its bars from ScrollView.onTouchEnd, which also fires
 * at the end of every drag, so the bars flickered on and off while scrolling.
 * A Pressable inside a ScrollView only reports a press when the touch did not
 * become a scroll — the ScrollView takes the responder and cancels it.
 * accessible={false}: the chapter is prose, not one giant button.
 */
export default function TapSurface({ onTap, windowWidth, style, children }: TapSurfaceProps) {
  return (
    <Pressable
      accessible={false}
      style={style}
      onPress={(e) => {
        const x = e.nativeEvent.pageX ?? e.nativeEvent.locationX ?? windowWidth / 2;
        onTap(windowWidth > 0 ? x / windowWidth : 0.5);
      }}
    >
      {children}
    </Pressable>
  );
}
