import React, { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Web embed player.
 *
 * Renders a real `<iframe>`, because `react-native-webview` has **no web
 * build**. On web it resolves to a stub that renders "React Native WebView does
 * not support this platform" and never fires `onLoadEnd` — so the watch screen,
 * which keeps its loading overlay up until that callback arrives, showed an
 * opaque black sheet and a spinner forever. Every anime whose source resolved to
 * an embed URL was unplayable on web, and the symptom looked like a slow network
 * rather than a missing implementation.
 *
 * # What is deliberately not carried over from the native path
 *
 * The native `WebView` injects scripts to shield the player, drive the media
 * session, seek, and poll progress. None of that is possible against a
 * cross-origin iframe — the browser will not let the parent reach into it, which
 * is the same rule that protects users from a hostile embed reaching out. So on
 * web those features are simply absent rather than silently broken, and the
 * screen falls back to its own controls.
 *
 * `sandbox` does carry the native shield's intent across, though. Omitting
 * `allow-popups` and `allow-top-navigation` blocks the pop-under and redirect
 * behaviour these embed hosts are known for, which is what
 * `onShouldStartLoadWithRequest` does natively.
 */
export type EmbedPlayerProps = {
  source: { uri: string };
  style?: StyleProp<ViewStyle>;
  /** Called once the iframe reports it has loaded. */
  onReady?: () => void;
  /** Called if the iframe fails to load. */
  onFailed?: () => void;
  /** Accepted and ignored: meaningless for a cross-origin iframe. */
  [key: string]: unknown;
};

export function EmbedPlayer({ source, style, onReady, onFailed }: EmbedPlayerProps) {
  const readyRef = useRef(onReady);
  const failedRef = useRef(onFailed);

  useEffect(() => {
    readyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    failedRef.current = onFailed;
  }, [onFailed]);

  // A cross-origin iframe never fires `onerror` for an HTTP error inside it —
  // the browser treats a 404 page as a successful load. So a failure here means
  // the request itself could not be made at all; everything else surfaces as a
  // loaded iframe showing the host's own error page. Reporting ready in that
  // case is still correct: the overlay must come down either way, or the user is
  // left staring at a spinner over a page that has finished loading.
  return (
    <View style={style}>
      {/* eslint-disable-next-line react/no-unknown-property */}
      <iframe
        key={source.uri}
        src={source.uri}
        title="Video player"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
        referrerPolicy="no-referrer"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        onLoad={() => readyRef.current?.()}
        onError={() => {
          failedRef.current?.();
          // Still clear the overlay. A stuck spinner is worse than an empty
          // player, because it gives the user nothing to act on.
          readyRef.current?.();
        }}
      />
    </View>
  );
}

export default EmbedPlayer;
