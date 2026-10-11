import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { StyleSheet, View } from 'react-native';
import Hls from 'hls.js';
import type { SubtitleMode } from '@/lib/anime-playback-overrides';
import type { WebVideoPlayerHandle, WebVideoPlayerProps } from './player-types';
import PlayerChrome from './PlayerChrome.web';
import { readPlayerPreferences, type QualityPreference, type SubtitleLanguage } from './player-preferences';
import { applyQualityPreference, applySubtitlePreferences } from './player-media-preferences';
export type { WebVideoPlayerHandle } from './player-types';

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

const WebVideoPlayer = forwardRef<WebVideoPlayerHandle, WebVideoPlayerProps>(function WebVideoPlayer(
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
    startProgress = 0,
    onCheckpoint,
    chrome,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const startAtRef = useRef(startAt);
  const startProgressRef = useRef(startProgress);
  const onCheckpointRef = useRef(onCheckpoint);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const preferences = chrome ? readPlayerPreferences() : undefined;
  const subtitleModeRef = useRef(preferences?.captions ?? subtitleMode);
  const subtitleLanguageRef = useRef<SubtitleLanguage | undefined>(preferences?.subtitleLanguage);
  const qualityPreferenceRef = useRef<QualityPreference>(preferences?.qualityPreference ?? 'auto');
  const manualQualityRef = useRef(false);
  // Equivalent header objects must not tear down a playing stream on rerender.
  const headersKey = browserHeadersKey(headers);

  useEffect(() => {
    startAtRef.current = startAt;
  }, [startAt]);

  useEffect(() => { startProgressRef.current = startProgress; }, [startProgress]);
  useEffect(() => { onCheckpointRef.current = onCheckpoint; }, [onCheckpoint]);

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
    const saved = chrome ? readPlayerPreferences() : undefined;
    const mode = saved?.captions ?? subtitleMode;
    subtitleModeRef.current = mode;
    subtitleLanguageRef.current = saved?.subtitleLanguage;
    if (videoRef.current) applySubtitlePreferences(videoRef.current, hlsRef.current, mode, subtitleLanguageRef.current);
  }, [subtitleMode, !!chrome]);

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

    manualQualityRef.current = false;
    qualityPreferenceRef.current = chrome ? readPlayerPreferences().qualityPreference : 'auto';
    let cancelled = false;
    let ready = false;
    let metadataLoaded = false;
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
      applySubtitlePreferences(video, hls, subtitleModeRef.current, subtitleLanguageRef.current);
    };

    const onMetadata = () => {
      if (cancelled || failed) return;
      applySubtitles();
      // HLS manifests arrive before duration/seekability. Restore only after
      // real media metadata, and never rewind when recovery attaches it again.
      metadataLoaded = true;
      if (ready || !Number.isFinite(video.duration) || video.duration <= 0) return;
      ready = true;
      const ratio = startProgressRef.current;
      const position = startAtRef.current > 0 ? startAtRef.current
        : Number.isFinite(ratio) && ratio > 0 && ratio < 1 && Number.isFinite(video.duration) ? video.duration * ratio : 0;
      if (Number.isFinite(position) && position > 0 && video.duration > 0) {
        const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : position;
        video.currentTime = Math.min(position, end);
      }
      void video.play().catch(() => undefined);
      onTimeUpdateRef.current?.(video.currentTime, Number.isFinite(video.duration) ? video.duration : 0);
      onReadyRef.current?.();
    };

    const onDurationChange = () => { if (metadataLoaded) onMetadata(); };

    const onTime = () => {
      if (cancelled || failed || !ready) return;
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

    const checkpoint = () => {
      if (!cancelled && ready && Number.isFinite(video.duration) && video.duration > 0) onCheckpointRef.current?.(video.currentTime, video.duration, video.ended === true);
    };
    const hiddenCheckpoint = () => { if (document.visibilityState === 'hidden') checkpoint(); };
    video.addEventListener('pause', checkpoint);
    video.addEventListener('seeked', checkpoint);
    video.addEventListener('ended', checkpoint);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', checkpoint);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hiddenCheckpoint);

    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('error', onVideoError);
    video.textTracks?.addEventListener('addtrack', applySubtitles);

    const useHls = isM3U8 || /\.m3u8(?:[?#]|$)/i.test(uri);
    if (useHls && Hls.isSupported()) {
      const safeHeaders: [string, string][] = JSON.parse(headersKey);
      hls = new Hls({
        // Only play the selected episode; never launch a playlist's ad assets.
        enableInterstitialPlayback: false,
        // Start capped modes at the lowest variant before automatic selection.
        ...(qualityPreferenceRef.current !== 'auto' ? { startLevel: 0 } : {}),
        xhrSetup: (xhr) => {
          for (const [key, value] of safeHeaders) {
            xhr.setRequestHeader(key, value);
          }
        },
      });
      hlsRef.current = hls;
      hls.subtitleDisplay = subtitleModeRef.current !== 'off';
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, applySubtitles);
      const updateQuality = (initial: boolean) => {
        if (cancelled || failed || !hls) return;
        if (!manualQualityRef.current) applyQualityPreference(hls, qualityPreferenceRef.current, initial);
        if (typeof Event !== 'undefined') video.dispatchEvent?.(new Event('sakura:media-options'));
      };
      hls.on(Hls.Events.MANIFEST_PARSED, () => updateQuality(true));
      hls.on(Hls.Events.LEVELS_UPDATED, () => updateQuality(false));
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
      video.removeEventListener('pause', checkpoint);
      video.removeEventListener('seeked', checkpoint);
      video.removeEventListener('ended', checkpoint);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', checkpoint);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hiddenCheckpoint);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('error', onVideoError);
      video.textTracks?.removeEventListener('addtrack', applySubtitles);
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [uri, isM3U8, headersKey]);

  const video = (
    <video ref={videoRef} style={styles.video} controls={!chrome} playsInline
      className={chrome ? 'sakura-captions' : undefined} data-caption-size={preferences?.captionSize} data-caption-background={preferences?.captionBackground}
      crossOrigin={subtitles?.length ? 'anonymous' : undefined} preload="auto">
      {subtitles?.map((track) => <track key={track.url} kind="subtitles" src={track.url} srcLang={track.lang} label={track.label} />)}
    </video>
  );
  return (
    <View style={[styles.fill, style]}>
      {chrome ? <>
        {video}
        <PlayerChrome videoRef={videoRef} hlsRef={hlsRef} uri={uri} options={chrome}
          onCaptionModeChange={(mode, language) => {
            subtitleModeRef.current = mode;
            if (language) subtitleLanguageRef.current = language;
            if (videoRef.current) applySubtitlePreferences(videoRef.current, hlsRef.current, mode, subtitleLanguageRef.current);
          }} onQualityChange={(choice) => {
            const hls = hlsRef.current;
            manualQualityRef.current = typeof choice === 'number';
            if (typeof choice !== 'number') qualityPreferenceRef.current = choice;
            if (!hls) return;
            if (typeof choice === 'number') { hls.autoLevelCapping = -1; hls.currentLevel = choice; }
            else applyQualityPreference(hls, choice, false, true);
          }} />
      </> : video}
    </View>
  );
});

export default WebVideoPlayer;

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000', position: 'relative' },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    backgroundColor: '#000',
  } as object,
});
