import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { StyleSheet, View, type ViewStyle, type StyleProp } from 'react-native';
import Hls from 'hls.js';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';

export type WebVideoPlayerHandle = {
  seekTo: (seconds: number) => void;
};

type Props = {
  uri: string;
  headers?: Record<string, string>;
  isM3U8?: boolean;
  subtitleMode?: SubtitleMode;
  subtitles?: Array<{ url: string; lang: string; label: string }>;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  startAt?: number;
};

function applySubtitleMode(video: HTMLVideoElement, mode: SubtitleMode): void {
  const tracks = video.textTracks;
  if (!tracks?.length) return;
  const captions = Array.from(tracks).filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
  const selected = captions.find((track) => track.mode === 'showing')
    ?? captions.find((track) => /^en(?:-|$)/i.test(track.language))
    ?? captions[0];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (mode === 'off') {
      track.mode = 'disabled';
    } else if (track.kind === 'subtitles' || track.kind === 'captions') {
      track.mode = track === selected ? 'showing' : 'disabled';
    }
  }
}

// These provider headers only work in a native player or a server-side proxy.
// Browsers own them; trying to set them cannot bypass a host's CORS policy.
const BROWSER_OWNED_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie',
  'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'permissions-policy', 'referer', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'user-agent', 'via',
]);

function browserHeadersKey(headers: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(headers ?? {})
    .map(([key, value]) => [key.toLowerCase(), value])
    .filter(([key]) => !BROWSER_OWNED_HEADERS.has(key) && !/^(proxy-|sec-)/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)));
}

const WebVideoPlayer = forwardRef<WebVideoPlayerHandle, Props>(function WebVideoPlayer(
  {
    uri,
    headers,
    isM3U8,
    subtitleMode = 'off',
    subtitles,
    style,
    onReady,
    onError,
    onTimeUpdate,
    startAt = 0,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const startAtRef = useRef(startAt);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const subtitleModeRef = useRef(subtitleMode);
  // Equivalent header objects must not tear down a playing stream on rerender.
  const headersKey = browserHeadersKey(headers);

  useEffect(() => {
    startAtRef.current = startAt;
  }, [startAt]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
  }, [onTimeUpdate]);

  useEffect(() => {
    subtitleModeRef.current = subtitleMode;
    if (hlsRef.current) hlsRef.current.subtitleDisplay = subtitleMode !== 'off';
    if (videoRef.current) applySubtitleMode(videoRef.current, subtitleMode);
  }, [subtitleMode]);

  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(seconds)) return;
      video.currentTime = Math.max(0, seconds);
    },
  }));

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !uri) return;

    let cancelled = false;
    let ready = false;
    let failed = false;
    let recoveryAttempted = false;
    let hls: Hls | null = null;
    let videoErrorTimer: ReturnType<typeof setTimeout> | null = null;

    const clearVideoError = () => {
      if (videoErrorTimer !== null) clearTimeout(videoErrorTimer);
      videoErrorTimer = null;
    };

    const fail = () => {
      if (cancelled || failed) return;
      failed = true;
      clearVideoError();
      onErrorRef.current?.();
    };

    const recoverMedia = () => {
      if (cancelled || failed) return;
      clearVideoError();
      if (!hls || recoveryAttempted) {
        fail();
        return;
      }
      recoveryAttempted = true;
      try {
        hls.recoverMediaError();
      } catch {
        fail();
      }
    };

    const applySubtitles = () => {
      if (cancelled || failed) return;
      if (hls) hls.subtitleDisplay = subtitleModeRef.current !== 'off';
      applySubtitleMode(video, subtitleModeRef.current);
    };

    const onMetadata = () => {
      if (cancelled || failed) return;
      applySubtitles();
      // HLS manifests arrive before duration/seekability. Restore only after
      // real media metadata, and never rewind when recovery attaches it again.
      if (ready) return;
      ready = true;
      const position = startAtRef.current;
      if (Number.isFinite(position) && position > 0 && video.duration > 0) {
        const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : position;
        video.currentTime = Math.min(position, end);
      }
      void video.play().catch(() => undefined);
      onReadyRef.current?.();
    };

    const onTime = () => {
      if (cancelled || failed) return;
      onTimeUpdateRef.current?.(video.currentTime, Number.isFinite(video.duration) ? video.duration : 0);
    };

    const onVideoError = () => {
      if (cancelled || failed) return;
      if (!hls) {
        fail();
        return;
      }
      // Let hls.js report/recover a related fatal event first, so one decoding
      // failure cannot immediately consume recovery and also trigger fallback.
      clearVideoError();
      videoErrorTimer = setTimeout(() => {
        videoErrorTimer = null;
        if (cancelled || failed || !video.error) return;
        if (video.error.code === 3) recoverMedia(); // MEDIA_ERR_DECODE
        else fail();
      }, 0);
    };

    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('error', onVideoError);
    video.textTracks?.addEventListener('addtrack', applySubtitles);

    const useHls = isM3U8 || /\.m3u8(?:[?#]|$)/i.test(uri);
    if (useHls && Hls.isSupported()) {
      const safeHeaders: [string, string][] = JSON.parse(headersKey);
      hls = new Hls({
        // Only play the selected episode; never launch a playlist's ad assets.
        enableInterstitialPlayback: false,
        xhrSetup: (xhr) => {
          for (const [key, value] of safeHeaders) {
            xhr.setRequestHeader(key, value);
          }
        },
      });
      hlsRef.current = hls;
      hls.subtitleDisplay = subtitleModeRef.current !== 'off';
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, applySubtitles);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || cancelled || failed) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) recoverMedia();
        else fail();
      });
      hls.loadSource(uri);
      hls.attachMedia(video);
    } else {
      // Native HLS (Safari) and ordinary video both use the same metadata path.
      video.src = uri;
    }

    return () => {
      cancelled = true;
      clearVideoError();
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('error', onVideoError);
      video.textTracks?.removeEventListener('addtrack', applySubtitles);
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [uri, isM3U8, headersKey]);

  return (
    <View style={[styles.fill, style]}>
      <video
        ref={videoRef}
        style={styles.video}
        controls
        playsInline
        crossOrigin={subtitles?.length ? 'anonymous' : undefined}
        preload="auto"
      >
        {subtitles?.map((track) => (
          <track key={track.url} kind="subtitles" src={track.url} srcLang={track.lang} label={track.label} />
        ))}
      </video>
    </View>
  );
});

export default WebVideoPlayer;

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    backgroundColor: '#000',
  } as object,
});
