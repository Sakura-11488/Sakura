import React from 'react';
import { WebView, type WebViewProps } from 'react-native-webview';

/**
 * Native embed player.
 *
 * A thin pass-through to `WebView`, existing only so that web can supply its own
 * implementation via `EmbedPlayer.web.tsx`. `react-native-webview` ships no web
 * build at all — it falls back to a stub that renders "React Native WebView does
 * not support this platform" and, critically, never fires `onLoadEnd`. Any
 * screen gating a loading overlay on that callback therefore hung forever on
 * web, which is exactly what happened here.
 */
export type EmbedPlayerProps = WebViewProps & {
  /** Called once the embed has loaded. Maps to `onLoadEnd` on native. */
  onReady?: () => void;
  /** Called when the embed fails to load. */
  onFailed?: () => void;
};

export function EmbedPlayer({ onReady, onFailed, ...props }: EmbedPlayerProps) {
  return (
    <WebView
      {...props}
      onLoadStart={(event) => {
        props.onLoadStart?.(event);
      }}
      onLoadEnd={(event) => {
        props.onLoadEnd?.(event);
        onReady?.();
      }}
      onError={(event) => {
        props.onError?.(event);
        onFailed?.();
      }}
    />
  );
}

export default EmbedPlayer;
