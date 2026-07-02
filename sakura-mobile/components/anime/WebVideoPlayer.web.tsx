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
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  startAt?: number;
};

function applySubtitleMode(video: HTMLVideoElement, mode: SubtitleMode): void {
  const tracks = video.textTracks;
  if (!tracks?.length) return;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (mode === 'off') {
      track.mode = 'disabled';
    } else if (track.kind === 'subtitles' || track.kind === 'captions') {
      track.mode = 'showing';
    }
  }
}

const WebVideoPlayer = forwardRef<WebVideoPlayerHandle, Props>(function WebVideoPlayer(
  {
    uri,
    headers,
    isM3U8,
    subtitleMode = 'off',
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

    const cleanup = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute('src');
      video.load();
    };

    const applyStart = () => {
      applySubtitleMode(video, subtitleMode);
      if (startAtRef.current > 1 && video.duration > 1) {
        video.currentTime = Math.min(startAtRef.current, video.duration - 1);
      }
      void video.play().catch(() => undefined);
      onReadyRef.current?.();
    };

    const useHls = isM3U8 || /\.m3u8(?:[?#]|$)/i.test(uri);

    if (useHls && Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr) => {
          if (headers) {
            for (const [key, value] of Object.entries(headers)) {
              xhr.setRequestHeader(key, value);
            }
          }
        },
      });
      hlsRef.current = hls;
      hls.loadSource(uri);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!cancelled) applyStart();
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        if (!cancelled) applySubtitleMode(video, subtitleMode);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && !cancelled) onErrorRef.current?.();
      });
    } else if (useHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = uri;
      video.addEventListener('loadedmetadata', applyStart, { once: true });
    } else {
      video.src = uri;
      video.addEventListener('loadedmetadata', applyStart, { once: true });
    }

    const onTime = () => {
      onTimeUpdateRef.current?.(video.currentTime, video.duration || 0);
    };
    video.addEventListener('timeupdate', onTime);
    const onVideoError = () => onErrorRef.current?.();
    video.addEventListener('error', onVideoError);

    return () => {
      cancelled = true;
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('error', onVideoError);
      cleanup();
    };
  }, [uri, isM3U8, headers, subtitleMode]);

  return (
    <View style={[styles.fill, style]}>
      <video
        ref={videoRef}
        style={styles.video}
        controls
        playsInline
        preload="auto"
      />
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
