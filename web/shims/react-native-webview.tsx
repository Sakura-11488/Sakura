import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View, type ViewStyle, type StyleProp } from 'react-native';

type WebViewSource = { uri?: string; html?: string };

type WebViewMessageEvent = {
  nativeEvent: { data: string };
};

type Props = {
  source: WebViewSource;
  style?: StyleProp<ViewStyle>;
  userAgent?: string;
  injectedJavaScript?: string;
  injectedJavaScriptBeforeContentLoaded?: string;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onError?: () => void;
  onMessage?: (event: WebViewMessageEvent) => void;
  onShouldStartLoadWithRequest?: (event: { url: string }) => boolean;
  allowsInlineMediaPlayback?: boolean;
  allowsFullscreenVideo?: boolean;
  mediaPlaybackRequiresUserAction?: boolean;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  sharedCookiesEnabled?: boolean;
  thirdPartyCookiesEnabled?: boolean;
  setSupportMultipleWindows?: boolean;
  allowsBackForwardNavigationGestures?: boolean;
};

const WebView = forwardRef<HTMLIFrameElement, Props>(function WebView(
  {
    source,
    style,
    injectedJavaScript,
    injectedJavaScriptBeforeContentLoaded,
    onLoadStart,
    onLoadEnd,
    onError,
    onMessage,
    onShouldStartLoadWithRequest,
  },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useImperativeHandle(ref, () => iframeRef.current as HTMLIFrameElement);

  useEffect(() => {
    onLoadStart?.();
  }, [source?.uri, source?.html, onLoadStart]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      onMessage?.({
        nativeEvent: {
          data: typeof event.data === 'string' ? event.data : JSON.stringify(event.data),
        },
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onMessage]);

  const uri = source?.uri;
  if (!uri) {
    return <View style={[styles.fill, style]} />;
  }

  if (onShouldStartLoadWithRequest && !onShouldStartLoadWithRequest({ url: uri })) {
    return <View style={[styles.fill, style]} />;
  }

  const runInjectedScripts = () => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    const scripts = [injectedJavaScriptBeforeContentLoaded, injectedJavaScript].filter(Boolean);
    for (const script of scripts) {
      try {
        frame.contentWindow.postMessage({ type: 'sakura-injected-script', script }, '*');
      } catch {
        // Cross-origin embeds cannot run injected scripts.
      }
    }
    onLoadEnd?.();
  };

  return (
    <View style={[styles.fill, style]}>
      <iframe
        ref={iframeRef}
        src={uri}
        title="Sakura player"
        style={styles.iframe}
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        onLoad={runInjectedScripts}
        onError={() => onError?.()}
      />
    </View>
  );
});

export { WebView };
export default WebView;

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%', overflow: 'hidden' },
  iframe: { borderWidth: 0, width: '100%', height: '100%' },
});
