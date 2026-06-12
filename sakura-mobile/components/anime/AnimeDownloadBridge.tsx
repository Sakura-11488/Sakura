import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { getAnimeStreamUserAgent } from '@/lib/anime';
import { buildEmbedBridgeInject, embedBridgeInjectDelays } from '@/lib/anime-download-inject';
import {
  getActiveEmbedBridgeJob,
  onEmbedBridgeCookies,
  onEmbedBridgeFetch,
  registerAnimeDownloadBridge,
  reportEmbedBridgeLoadError,
  type EmbedBridgeJob,
} from '@/lib/anime-download-bridge';

export default function AnimeDownloadBridge() {
  const webRef = useRef<WebView>(null);
  const [job, setJob] = useState<EmbedBridgeJob | null>(null);
  const loadedRef = useRef(false);
  const finishedRef = useRef(false);
  const injectTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const loadErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ua = getAnimeStreamUserAgent();

  const clearLoadErrorTimer = () => {
    if (loadErrorTimerRef.current) {
      clearTimeout(loadErrorTimerRef.current);
      loadErrorTimerRef.current = null;
    }
  };

  const clearInjectTimers = () => {
    injectTimersRef.current.forEach(clearTimeout);
    injectTimersRef.current = [];
  };

  const scheduleInject = (active: EmbedBridgeJob) => {
    clearInjectTimers();
    const delays = embedBridgeInjectDelays(active.mode);
    for (const delay of delays) {
      const t = setTimeout(() => {
        if (finishedRef.current) return;
        const current = getActiveEmbedBridgeJob();
        if (!current || current.id !== active.id) return;
        webRef.current?.injectJavaScript(buildEmbedBridgeInject(current));
      }, delay);
      injectTimersRef.current.push(t);
    }
  };

  useEffect(() => {
    loadedRef.current = false;
    finishedRef.current = false;
    clearInjectTimers();
    clearLoadErrorTimer();
    return () => {
      clearInjectTimers();
      clearLoadErrorTimer();
    };
  }, [job?.id]);

  useEffect(() => registerAnimeDownloadBridge(setJob), []);

  if (!job) return null;

  const webSource =
    job.mode === 'document' && job.referer
      ? {
          uri: job.embedUrl,
          headers: {
            Referer: job.referer,
            'User-Agent': ua,
            Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
          },
        }
      : { uri: job.embedUrl };

  return (
    <View style={s.host} pointerEvents="none">
      <WebView
        ref={webRef}
        source={webSource}
        userAgent={ua}
        style={s.web}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        onLoadStart={() => {
          loadedRef.current = false;
          clearLoadErrorTimer();
        }}
        onLoadEnd={() => {
          loadedRef.current = true;
          clearLoadErrorTimer();
          const active = getActiveEmbedBridgeJob();
          if (!active || active.id !== job.id || finishedRef.current) return;
          scheduleInject(active);
        }}
        onHttpError={() => {
          // Subresource 403/404 on the player page is common — do not fail the job here.
        }}
        onError={(e) => {
          if (finishedRef.current || loadedRef.current) return;
          const desc = e.nativeEvent.description || 'WebView error';
          clearLoadErrorTimer();
          loadErrorTimerRef.current = setTimeout(() => {
            if (finishedRef.current || loadedRef.current) return;
            reportEmbedBridgeLoadError(job.id, desc);
          }, embedBridgeInjectDelays(job.mode)[embedBridgeInjectDelays(job.mode).length - 1] + 1200);
        }}
        onMessage={(e) => {
          try {
            const data = JSON.parse(e.nativeEvent.data) as {
              id?: string;
              type?: 'cookies' | 'fetch';
              cookies?: string;
              ok?: boolean;
              text?: string;
              error?: string;
            };
            if (!data.id || data.id !== job.id) return;
            if (data.type === 'cookies') {
              clearLoadErrorTimer();
              if (job.mode === 'cookies') finishedRef.current = true;
              onEmbedBridgeCookies(data.id, data.cookies || '');
              return;
            }
            if (data.type === 'fetch') {
              clearLoadErrorTimer();
              finishedRef.current = true;
              onEmbedBridgeFetch(data.id, {
                ok: !!data.ok,
                text: data.text,
                error: data.error,
              });
            }
          } catch {
            // ignore
          }
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  host: {
    position: 'absolute',
    width: 2,
    height: 2,
    opacity: 0.01,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
  web: { flex: 1 },
});
