import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import EmbedPlayer from '@/components/anime/EmbedPlayer';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as NavigationBar from 'expo-navigation-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { Fonts, FontSize, Radius } from '@/constants/theme';
import {
  buildStreamEmbedUrl,
  fetchAnimeInfo,
  fetchEpisodeSources,
  getAnimeStreamUserAgent,
  type AnimeInfo,
  type AnimeEpisode,
  type StreamingSource,
} from '@/lib/anime';
import {
  getEpisodePlaybackHint,
  shouldPreferDirectPlayback,
  type SubtitleMode,
} from '@/lib/anime-playback-overrides';
import {
  buildAnimePlayerShieldScript,
  shouldAllowAnimePlayerNavigation,
} from '@/lib/anime-player-shield';
import { buildAnimeMediaSessionScript } from '@/lib/anime-media-session';
import { playTap, onTap } from '@/lib/sound';
import {
  estimateProgressFromWatchTime,
  getAnimeWatchProgress,
  setAnimeWatchProgressWithAdvance,
  RESUME_MIN,
} from '@/lib/watch-progress';
import { getOfflinePlaybackUri } from '@/lib/anime-offline';
import WebVideoPlayer, { type WebVideoPlayerHandle } from '@/components/anime/WebVideoPlayer';

const D = {
  bg: '#000000',
  pink: '#E84545',
  text: '#FFFFFF',
  muted: 'rgba(255,255,255,0.55)',
};

const BackIcon = () => (
  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke={D.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const ChevronRightIcon = () => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
    <Path d="M9 6l6 6-6 6" stroke={D.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export default function AnimeWatch() {
  const { id, ep, offline } = useLocalSearchParams<{ id: string; ep: string; offline?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [anime, setAnime] = useState<AnimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [category, setCategory] = useState<'sub' | 'dub'>('sub');
  const [availableCategories, setAvailableCategories] = useState<string[]>(['sub']);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [webReady, setWebReady] = useState(false);
  const forceOffline = offline === '1';
  const isAndroid = Platform.OS === 'android';
  const isWeb = Platform.OS === 'web';

  // Native HLS streaming (Android-preferred): play the m3u8 directly through
  // expo-video (Media3/ExoPlayer) with CDN headers, falling back to the web
  // embed if the native player errors. iOS keeps using the embed (AVPlayer
  // returns 403 on these CDN HLS URLs).
  const [streamSource, setStreamSource] =
    useState<{ uri: string; headers?: Record<string, string>; isM3U8?: boolean } | null>(null);
  const [allSources, setAllSources] = useState<NonNullable<StreamingSource['allSources']>>([]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>('off');
  const playbackHeadersRef = useRef<Record<string, string> | undefined>(undefined);
  const webVideoRef = useRef<WebVideoPlayerHandle | null>(null);
  const [embedFallbackUrl, setEmbedFallbackUrl] = useState<string | null>(null);
  const [skipMarkers, setSkipMarkers] = useState<{
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  }>({});
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const nativeFailedRef = useRef(false);
  const [resumeSeconds, setResumeSeconds] = useState(0);
  const progressRef = useRef(0);
  const pendingResumeRef = useRef(0);
  const pendingResumeSecondsRef = useRef(0);
  const resumeSeekDoneRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchStartedAtRef = useRef<number | null>(null);
  const animeRef = useRef<AnimeInfo | null>(null);
  const episodeRef = useRef<AnimeEpisode | null>(null);
  const [controlsVisible, setControlsVisible] = useState(false);

  useEffect(() => {
    animeRef.current = anime;
  }, [anime]);

  const epNum =
    ep?.match(/^hi-\d+-(\d+)$/)?.[1] ??
    ep?.match(/^mal-\d+-(\d+)$/)?.[1] ??
    ep ??
    '1';
  const epNumInt = parseInt(epNum, 10) || 1;
  const playbackHint = useMemo(
    () => getEpisodePlaybackHint(String(id), epNumInt),
    [id, epNumInt],
  );
  const streamUA = useMemo(() => getAnimeStreamUserAgent(), []);

  const currentEpisodeIndex = anime?.episodes.findIndex((e) => e.id === ep) ?? -1;
  const currentEpisode: AnimeEpisode | null =
    currentEpisodeIndex >= 0 ? (anime?.episodes[currentEpisodeIndex] ?? null) : null;
  const nextEpisode: AnimeEpisode | null =
    currentEpisodeIndex >= 0 && anime && currentEpisodeIndex < anime.episodes.length - 1
      ? (anime.episodes[currentEpisodeIndex + 1] ?? null)
      : null;

  const progressEpisode = useMemo((): AnimeEpisode | null => {
    if (currentEpisode) return currentEpisode;
    if (!ep) return null;
    const num = parseInt(epNum, 10) || 1;
    return { id: ep, number: num, title: `Episode ${num}` };
  }, [currentEpisode, ep, epNum]);

  useEffect(() => {
    episodeRef.current = progressEpisode;
  }, [progressEpisode]);

  const getEstimatedProgress = useCallback(() => {
    const started = watchStartedAtRef.current;
    const elapsed = started ? Date.now() - started : 0;
    return estimateProgressFromWatchTime(elapsed, progressRef.current);
  }, []);

  const flushProgress = useCallback(
    async (
      progress: number,
      info: AnimeInfo | null,
      episode: AnimeEpisode | null,
      positionSeconds?: number,
    ) => {
      if (!id || !ep || !info || !episode) return;
      const p = Math.min(1, Math.max(0, progress));
      if (p < 0.01) return;
      progressRef.current = p;
      await setAnimeWatchProgressWithAdvance(
        {
          animeId: String(id),
          title: info.title,
          cover: info.cover || info.image || '',
          episodeId: episode.id,
          episodeNumber: episode.number,
          episodeTitle: episode.title,
          episodeThumbnail: episode.thumbnail,
          progress: p,
          positionSeconds:
            typeof positionSeconds === 'number' && positionSeconds > 0
              ? positionSeconds
              : undefined,
          updatedAt: Date.now(),
        },
        info.episodes || [],
      );
    },
    [id, ep],
  );

  const persistProgress = useCallback(
    async (
      progress: number,
      info: AnimeInfo | null,
      episode: AnimeEpisode | null,
      immediate = false,
      positionSeconds?: number,
    ) => {
      if (!id || !ep || !info || !episode) return;
      const p = Math.min(1, Math.max(0, progress));
      if (p < 0.01) return;
      progressRef.current = p;
      if (p >= 0.98 || immediate) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        await flushProgress(p, info, episode, positionSeconds);
        return;
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushProgress(p, info, episode, positionSeconds);
      }, 400);
    },
    [id, ep, flushProgress],
  );

  // Unified native source: offline file takes precedence, then native HLS stream.
  const nativeSource = useMemo<
    string | { uri: string; headers?: Record<string, string> }
  >(() => {
    if (localUri) return localUri;
    if (streamSource) return streamSource;
    return '';
  }, [localUri, streamSource]);

  const webStreamUri = useMemo(() => {
    if (!nativeSource) return '';
    if (typeof nativeSource === 'string') return nativeSource;
    return nativeSource.uri;
  }, [nativeSource]);

  const webStreamHeaders = useMemo(() => {
    if (!nativeSource || typeof nativeSource === 'string') return undefined;
    return nativeSource.headers;
  }, [nativeSource]);

  const nativePlayer = useVideoPlayer(isWeb ? '' : nativeSource, (player) => {
    player.loop = false;
    player.timeUpdateEventInterval = 1;
  });

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
      controlsTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    StatusBar.setHidden(true, 'fade');
    if (Platform.OS === 'android') {
      void NavigationBar.setVisibilityAsync('hidden').catch(() => undefined);
    }
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => undefined);

    return () => {
      if (controlsTimerRef.current) {
        clearTimeout(controlsTimerRef.current);
        controlsTimerRef.current = null;
      }
      StatusBar.setHidden(false, 'fade');
      if (Platform.OS === 'android') {
        void NavigationBar.setVisibilityAsync('visible').catch(() => undefined);
      }
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!id || !ep) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setEmbedUrl(null);
    setLocalUri(null);
    setStreamSource(null);
    setEmbedFallbackUrl(null);
    setAllSources([]);
    setSourceIndex(0);
    playbackHeadersRef.current = undefined;
    setSkipMarkers({});
    setCurrentTimeSec(0);
    setWebReady(false);
    setResumeSeconds(0);
    progressRef.current = 0;
    pendingResumeRef.current = 0;
    pendingResumeSecondsRef.current = 0;
    resumeSeekDoneRef.current = false;
    nativeFailedRef.current = false;
    watchStartedAtRef.current = null;

    (async () => {
      const saved = await getAnimeWatchProgress(String(id)).catch(() => null);
      if (cancelled) return;
      if (
        saved?.episodeId === ep &&
        saved.progress >= RESUME_MIN &&
        saved.progress < 0.98
      ) {
        progressRef.current = saved.progress;
        pendingResumeRef.current = saved.progress;
        if (saved.positionSeconds && saved.positionSeconds > 1) {
          pendingResumeSecondsRef.current = saved.positionSeconds;
        }
      }

      const {
        fetchSakuraOriginalInfo,
        getSakuraOriginalEmbedUrl,
        isSakuraOriginal,
        resolveSakuraOriginalStreamUrl,
      } = await import('@/lib/sakura-originals');
      const isOriginal = isSakuraOriginal(String(id));

      /**
       * A downloaded copy wins over the network, for every source.
       *
       * This lookup used to sit BELOW the Sakura Originals branch, which
       * returns as soon as it resolves a stream URL — so a downloaded Original
       * was written to disk, listed in Downloads, opened with `offline: '1'`,
       * and then streamed from the network anyway. The file was written and
       * never once read. Offline, the user got a playback error with a perfect
       * copy sitting on their device.
       *
       * That was a native bug too, not just a web one.
       */
      const cached = await getOfflinePlaybackUri(String(id), ep).catch(() => null);
      if (cancelled) return;
      if (cached) {
        setLocalUri(cached);
        // Metadata has to come from the right backend: fetchAnimeInfo is the
        // Consumet call and returns nothing for an Originals id.
        const info = await (isOriginal
          ? fetchSakuraOriginalInfo(String(id), { force: retryCount > 0 })
          : fetchAnimeInfo(id)
        ).catch(() => null);
        if (info) setAnime(info);
        setLoading(false);
        return;
      }

      // Sakura Originals — stream directly via native video player
      if (isOriginal) {
        const info = await fetchSakuraOriginalInfo(String(id), { force: retryCount > 0 });
        if (info) setAnime(info);

        const embed = isWeb ? getSakuraOriginalEmbedUrl(ep) : null;
        const mp4 = await resolveSakuraOriginalStreamUrl(ep, { force: retryCount > 0 });
        if (mp4) {
          setEmbedFallbackUrl(embed);
          setLocalUri(mp4);
          setLoading(false);
          return;
        }

        if (embed) {
          setEmbedFallbackUrl(null);
          setEmbedUrl(embed);
          setLoading(false);
          return;
        }
      }

      if (forceOffline) {
        setError('Offline file not found. Download the episode again while online.');
        setLoading(false);
        return;
      }

      const info = await fetchAnimeInfo(id, { force: retryCount > 0 }).catch(() => null);
      if (cancelled) return;
      if (info) setAnime(info);

      let src = await fetchEpisodeSources(ep, category, id, {
        force: retryCount > 0 || !!playbackHint?.forceFreshSource,
      }).catch(() => null);
      if (!src?.embedUrl && !src?.url && retryCount === 0) {
        src = await fetchEpisodeSources(
          ep,
          category === 'sub' ? 'dub' : 'sub',
          id,
          { force: !!playbackHint?.forceFreshSource },
        ).catch(() => null);
      }
      if (!src?.embedUrl && !src?.url) {
        const directMal = ep.match(/^mal-(\d+)-(\d+)$/);
        if (directMal) {
          const [, malId, directEpNum] = directMal;
          src = {
            url: '',
            isM3U8: false,
            embedUrl: buildStreamEmbedUrl(malId, directEpNum, category),
            category,
            availableCategories: ['sub', 'dub'],
          };
        }
      }
      if (cancelled) return;

      if (src?.embedUrl || src?.url) {
        if (src.availableCategories?.length) {
          setAvailableCategories(src.availableCategories);
        }
        setSkipMarkers({ intro: src.intro, outro: src.outro });
        playbackHeadersRef.current = src.requestHeaders;
        setAllSources(src.allSources ?? []);
        setSourceIndex(0);
        if (playbackHint?.subtitleMode) {
          setSubtitleMode(playbackHint.subtitleMode);
        }

        const preferDirect = shouldPreferDirectPlayback(playbackHint, isWeb);
        const canNative =
          isAndroid && !nativeFailedRef.current && !!src.url && src.isM3U8 !== false;

        if ((preferDirect || canNative) && src.url) {
          setEmbedFallbackUrl(src.embedUrl || null);
          setStreamSource({
            uri: src.url,
            headers: src.requestHeaders,
            isM3U8: src.isM3U8,
          });
        } else if (src.embedUrl) {
          setEmbedFallbackUrl(null);
          setEmbedUrl(src.embedUrl);
        } else if (src.url) {
          setEmbedFallbackUrl(null);
          setStreamSource({
            uri: src.url,
            headers: src.requestHeaders,
            isM3U8: src.isM3U8,
          });
        }
      } else {
        setError(
          'No streaming source found for this anime.\nIt may not be available in our catalog yet.',
        );
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [id, ep, category, retryCount, forceOffline, isAndroid, isWeb, playbackHint]);

  useEffect(() => {
    if (!nativeSource || !anime || !progressEpisode) return;
    if (!watchStartedAtRef.current) watchStartedAtRef.current = Date.now();

    const applyResumeSeek = (duration: number) => {
      if (resumeSeekDoneRef.current || duration <= 1) return;
      const ratioTarget = pendingResumeRef.current;
      const secondsTarget = pendingResumeSecondsRef.current;
      const seekTo =
        secondsTarget > 1
          ? secondsTarget
          : ratioTarget >= RESUME_MIN
            ? duration * ratioTarget
            : 0;
      if (seekTo < 1) return;
      const clamped = Math.min(Math.max(duration - 0.5, 0), seekTo);
      nativePlayer.currentTime = clamped;
      resumeSeekDoneRef.current = true;
      setTimeout(() => {
        if (nativePlayer.duration > 1 && nativePlayer.currentTime < clamped * 0.5) {
          nativePlayer.currentTime = clamped;
        }
      }, 400);
    };

    const sourceSub = nativePlayer.addListener('sourceChange', () => {
      resumeSeekDoneRef.current = false;
    });

    const loadSub = nativePlayer.addListener('sourceLoad', ({ duration }) => {
      applyResumeSeek(duration);
    });

    const statusSub = nativePlayer.addListener('statusChange', () => {
      applyResumeSeek(nativePlayer.duration);
    });

    applyResumeSeek(nativePlayer.duration);

    return () => {
      sourceSub.remove();
      loadSub.remove();
      statusSub.remove();
    };
  }, [nativeSource, anime, progressEpisode, nativePlayer]);

  useEffect(() => {
    if (!nativeSource || !anime || !progressEpisode) return;
    const sub = nativePlayer.addListener('timeUpdate', ({ currentTime }) => {
      setCurrentTimeSec(currentTime);
      const duration = nativePlayer.duration;
      if (duration <= 0) return;
      const next = Math.min(1, Math.max(0, currentTime / duration));
      if (Math.abs(next - progressRef.current) < 0.008 && next < 0.98) return;
      progressRef.current = next;
      pendingResumeSecondsRef.current = currentTime;
      void persistProgress(next, anime, progressEpisode, false, currentTime);
    });
    return () => sub.remove();
  }, [nativeSource, anime, progressEpisode, nativePlayer, persistProgress]);

  // Fall back to the web embed if native HLS playback errors (e.g. CDN 403).
  useEffect(() => {
    if (!streamSource || isWeb) return;
    const sub = nativePlayer.addListener('statusChange', ({ status }) => {
      if (status !== 'error' || nativeFailedRef.current) return;

      const next = allSources[sourceIndex + 1];
      if (next?.url) {
        setSourceIndex((i) => i + 1);
        setStreamSource({
          uri: next.url,
          headers: playbackHeadersRef.current,
          isM3U8: next.isM3U8,
        });
        return;
      }

      nativeFailedRef.current = true;
      setStreamSource(null);
      resumeSeekDoneRef.current = false;
      if (embedFallbackUrl) setEmbedUrl(embedFallbackUrl);
    });
    return () => sub.remove();
  }, [streamSource, embedFallbackUrl, nativePlayer, allSources, sourceIndex, isWeb]);

  const tryNextAlternateSource = useCallback((): boolean => {
    const next = allSources[sourceIndex + 1];
    if (!next?.url) return false;
    setSourceIndex((i) => i + 1);
    setStreamSource({
      uri: next.url,
      headers: playbackHeadersRef.current,
      isM3U8: next.isM3U8,
    });
    setWebReady(false);
    nativeFailedRef.current = false;
    return true;
  }, [allSources, sourceIndex]);

  const handleDirectPlaybackFailure = useCallback(() => {
    if (tryNextAlternateSource()) return;
    if (embedFallbackUrl) {
      setLocalUri(null);
      setStreamSource(null);
      setEmbedUrl(embedFallbackUrl);
      return;
    }
    setError('Playback failed. Try Retry or switch sub/dub.');
  }, [tryNextAlternateSource, embedFallbackUrl]);

  useEffect(() => {
    if (!nativeSource || !anime || !progressEpisode) return;
    const tick = setInterval(() => {
      if (progressRef.current >= RESUME_MIN) return;
      void persistProgress(getEstimatedProgress(), anime, progressEpisode);
    }, 10_000);
    return () => clearInterval(tick);
  }, [nativeSource, anime, progressEpisode, getEstimatedProgress, persistProgress]);

  useEffect(() => {
    if (!webReady || !anime || !progressEpisode || resumeSeconds > 0 || nativeSource) return;
    if (progressRef.current < RESUME_MIN) return;
    // Seek applied inside WebView once duration is known
    setResumeSeconds(progressRef.current);
  }, [webReady, anime, progressEpisode, resumeSeconds, nativeSource]);

  useEffect(() => {
    if (!webReady && !nativeSource) return;
    if (!watchStartedAtRef.current) watchStartedAtRef.current = Date.now();
  }, [webReady, nativeSource]);

  useEffect(() => {
    if ((!webReady && !nativeSource) || !anime || !progressEpisode) return;
    void persistProgress(getEstimatedProgress(), anime, progressEpisode);
  }, [webReady, nativeSource, anime, progressEpisode, getEstimatedProgress, persistProgress]);

  useEffect(() => {
    if (!webReady || nativeSource || !anime || !progressEpisode) return;
    const tick = setInterval(() => {
      void persistProgress(getEstimatedProgress(), anime, progressEpisode);
    }, 8_000);
    return () => clearInterval(tick);
  }, [webReady, nativeSource, anime, progressEpisode, getEstimatedProgress, persistProgress]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const info = animeRef.current;
      const episode = episodeRef.current;
      if (!info || !episode) return;

      const nativeProgress = progressRef.current;
      if (nativeProgress >= 0.01) {
        void flushProgress(
          nativeProgress,
          info,
          episode,
          pendingResumeSecondsRef.current > 0 ? pendingResumeSecondsRef.current : undefined,
        );
        return;
      }

      const started = watchStartedAtRef.current;
      if (!started) return;
      const elapsed = Date.now() - started;
      if (elapsed < 4_000) return;
      const p = estimateProgressFromWatchTime(elapsed, nativeProgress);
      if (p < 0.01) return;
      void flushProgress(p, info, episode);
    };
  }, [flushProgress]);

  const handleWebMessage = (raw: string) => {
    try {
      const data = JSON.parse(raw) as { type?: string; progress?: number; duration?: number };
      if (data.type !== 'progress' || !data.duration || data.duration <= 0) return;
      const next = Math.min(1, Math.max(0, (data.progress || 0) / data.duration));
      if (Math.abs(next - progressRef.current) < 0.008 && next < 0.98) return;
      progressRef.current = next;
      if (anime && progressEpisode) void persistProgress(next, anime, progressEpisode);
    } catch {
      // ignore malformed messages
    }
  };

  const seekScript = useMemo(() => {
    const ratio = resumeSeconds > 0 && resumeSeconds < 1 ? resumeSeconds : progressRef.current;
    if (ratio < RESUME_MIN) return '';
    return `
      (function() {
        var targetRatio = ${ratio.toFixed(4)};
        function seek() {
          var v = document.querySelector('video');
          if (!v || !v.duration || v.duration < 10) return false;
          var t = Math.max(0, Math.min(v.duration * targetRatio, v.duration - 3));
          if (Math.abs(v.currentTime - t) > 2) v.currentTime = t;
          return true;
        }
        if (!seek()) {
          var n = 0;
          var iv = setInterval(function() {
            if (seek() || ++n > 40) clearInterval(iv);
          }, 500);
        }
      })();
    `;
  }, [resumeSeconds]);

  const progressPollScript = `
    (function() {
      function findVideo() {
        var v = document.querySelector('video');
        if (v) return v;
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          try {
            var doc = frames[i].contentDocument;
            if (doc) {
              v = doc.querySelector('video');
              if (v) return v;
            }
          } catch (e) {}
        }
        return null;
      }
      function tick() {
        try {
          var v = findVideo();
          if (v && v.duration > 0) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'progress',
              progress: v.currentTime,
              duration: v.duration
            }));
          }
        } catch (e) {}
      }
      tick();
      setInterval(tick, 4000);
    })();
    true;
  `;

  const episodeLabel = currentEpisode?.title || `Episode ${epNum}`;
  const playerShieldScript = useMemo(() => buildAnimePlayerShieldScript(), []);
  const mediaSessionScript = useMemo(
    () => buildAnimeMediaSessionScript(anime?.title ?? 'Anime', episodeLabel),
    [anime?.title, episodeLabel],
  );

  const shouldAllowPlayerRequest = useCallback((request: { url?: string; mainDocumentURL?: string; isTopFrame?: boolean }) => {
    return shouldAllowAnimePlayerNavigation(request.url || '', embedUrl, request.isTopFrame ?? true);
  }, [embedUrl]);

  const toggleCategory = () => {
    const next = category === 'sub' ? 'dub' : 'sub';
    if (availableCategories.includes(next)) {
      setCategory(next);
    }
  };

  const goToNext = () => {
    if (!nextEpisode || !anime) return;
    playTap();
    void setAnimeWatchProgressWithAdvance({
      animeId: String(id),
      title: anime.title,
      cover: anime.cover || anime.image || '',
      episodeId: nextEpisode.id,
      episodeNumber: nextEpisode.number,
      episodeTitle: nextEpisode.title,
      episodeThumbnail: nextEpisode.thumbnail,
      progress: 0,
      updatedAt: Date.now(),
    }, anime.episodes || []);
    router.replace({
      pathname: '/anime/watch',
      params: {
        id,
        ep: nextEpisode.id,
        ...(localUri?.startsWith('file://') ? { offline: '1' } : {}),
      },
    });
  };

  const skipIntro = () => {
    if (!skipMarkers.intro) return;
    playTap();
    const target = skipMarkers.intro.end;
    if (isWeb && streamSource) {
      webVideoRef.current?.seekTo(target);
    } else {
      nativePlayer.currentTime = target;
    }
  };

  const skipOutro = () => {
    playTap();
    if (nextEpisode) {
      goToNext();
    } else if (skipMarkers.outro) {
      const target = skipMarkers.outro.end;
      if (isWeb && streamSource) {
        webVideoRef.current?.seekTo(target);
      } else {
        nativePlayer.currentTime = target;
      }
    }
  };

  const showWebEmbedPlayer = !!embedUrl && !nativeSource && !error;
  const showWebDirectPlayer = isWeb && !!nativeSource && !error;
  const showNativePlayer = !!nativeSource && !error && !isWeb;
  const showPlayer = showWebEmbedPlayer || showWebDirectPlayer || showNativePlayer;
  const showLoader = loading || (showWebEmbedPlayer && !webReady);
  const showCategoryToggle =
    (showWebEmbedPlayer || showWebDirectPlayer || !!streamSource) && availableCategories.length > 1;

  const canShowSkipButtons = showNativePlayer || showWebDirectPlayer;
  const introActive =
    canShowSkipButtons &&
    !!skipMarkers.intro &&
    currentTimeSec >= skipMarkers.intro.start &&
    currentTimeSec < skipMarkers.intro.end - 0.5;
  const outroActive =
    canShowSkipButtons &&
    !!skipMarkers.outro &&
    currentTimeSec >= skipMarkers.outro.start &&
    currentTimeSec < skipMarkers.outro.end - 0.5;

  return (
    <View style={s.root}>
      <StatusBar hidden barStyle="light-content" backgroundColor={D.bg} />

      <View style={s.playerWrap} onTouchStart={revealControls}>
      {showWebDirectPlayer && (
        <WebVideoPlayer
          ref={webVideoRef}
          uri={webStreamUri}
          headers={webStreamHeaders}
          isM3U8={streamSource?.isM3U8}
          subtitleMode={subtitleMode}
          style={s.player}
          startAt={pendingResumeSecondsRef.current > 1 ? pendingResumeSecondsRef.current : undefined}
          onReady={() => setWebReady(true)}
          onError={handleDirectPlaybackFailure}
          onTimeUpdate={(currentTime, duration) => {
            setCurrentTimeSec(currentTime);
            if (duration <= 0 || !anime || !progressEpisode) return;
            const next = Math.min(1, Math.max(0, currentTime / duration));
            if (Math.abs(next - progressRef.current) < 0.008 && next < 0.98) return;
            progressRef.current = next;
            pendingResumeSecondsRef.current = currentTime;
            void persistProgress(next, anime, progressEpisode, false, currentTime);
          }}
        />
      )}

      {showNativePlayer && (
        <VideoView
          player={nativePlayer}
          style={s.player}
          {...({
            allowsFullscreen: true,
            allowsPictureInPicture: true,
          } as Partial<React.ComponentProps<typeof VideoView>>)}
          nativeControls
        />
      )}

      {(controlsVisible || error) && (
        <View style={[s.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <TouchableOpacity
            onPress={() => {
              playTap();
              const info = animeRef.current;
              const episode = episodeRef.current;
              if (info && episode && progressRef.current >= 0.01) {
                void flushProgress(
                  progressRef.current,
                  info,
                  episode,
                  pendingResumeSecondsRef.current > 0 ? pendingResumeSecondsRef.current : undefined,
                );
              }
              router.back();
            }}
            style={s.circleBtn}
          >
            <BackIcon />
          </TouchableOpacity>

          <View style={s.titleWrap}>
            <Text style={s.showTitle} numberOfLines={1}>{anime?.title ?? ''}</Text>
            <Text style={s.epTitle} numberOfLines={1}>
              {currentEpisode?.title || `Episode ${epNum}`}
            </Text>
          </View>

          {showCategoryToggle ? (
            <TouchableOpacity
              onPress={toggleCategory}
              style={s.categoryPill}
              activeOpacity={availableCategories.includes(category === 'sub' ? 'dub' : 'sub') ? 0.7 : 1}
            >
              <Text style={s.categoryText}>{category.toUpperCase()}</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.topBarSpacer} />
          )}
        </View>
      )}

      {showWebEmbedPlayer && (
        <EmbedPlayer
          key={`${embedUrl}-${category}`}
          source={{ uri: embedUrl }}
          style={s.player}
          userAgent={streamUA}
          allowsInlineMediaPlayback
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={shouldAllowPlayerRequest}
          allowsBackForwardNavigationGestures={false}
          onReady={() => setWebReady(true)}
          onLoadStart={() => setWebReady(false)}
          onLoadEnd={() => setWebReady(true)}
          onMessage={(e) => handleWebMessage(e.nativeEvent.data)}
          injectedJavaScriptBeforeContentLoaded={playerShieldScript}
          injectedJavaScript={`
            ${playerShieldScript}
            ${mediaSessionScript}
            (function() {
              try {
                var v = document.querySelector('video');
                if (v) { v.play().catch(function(){}); }
              } catch (e) {}
            })();
            ${seekScript}
            ${progressPollScript}
          `}
          onError={() => {
            setError('Video player failed to load.\nCheck your connection and try again.');
            setEmbedUrl(null);
          }}
          onHttpError={({ nativeEvent }) => {
            if (nativeEvent.statusCode >= 400) {
              setError(`Stream unavailable (HTTP ${nativeEvent.statusCode}).`);
              setEmbedUrl(null);
            }
          }}
        />
      )}

      {showLoader && (
        <View style={s.loaderOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={D.pink} />
        </View>
      )}

      {error && !loading && (
        <View style={s.errorOverlay}>
          <View style={s.errorCard}>
            <Text style={s.errorTitle}>Playback Error</Text>
            <Text style={s.errorText}>{error}</Text>
            <View style={s.errorBtnRow}>
              <TouchableOpacity
                onPress={() => { playTap(); setRetryCount((c) => c + 1); }}
                style={[s.errorBtn, s.errorBtnOutline]}
                activeOpacity={0.8}
              >
                <Text style={[s.errorBtnText, s.errorBtnTextOutline]}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onTap(() => router.back())} style={s.errorBtn} activeOpacity={0.8}>
                <Text style={s.errorBtnText}>Go Back</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {(introActive || outroActive) && (
        <View
          style={[s.skipWrap, { bottom: insets.bottom + (canShowSkipButtons ? 104 : 70) }]}
          pointerEvents="box-none"
        >
          <TouchableOpacity
            onPress={introActive ? skipIntro : skipOutro}
            style={s.skipBtn}
            activeOpacity={0.85}
          >
            <Text style={s.skipText}>{introActive ? 'Skip Intro' : 'Skip Outro'}</Text>
            <ChevronRightIcon />
          </TouchableOpacity>
        </View>
      )}

      {controlsVisible && nextEpisode && showPlayer && (nativeSource || (webReady && !error)) && !error && (
        <View
          style={[s.nextWrap, { bottom: insets.bottom + (showNativePlayer ? 58 : 24) }]}
          pointerEvents="box-none"
        >
          <TouchableOpacity onPress={goToNext} style={s.nextBtn}>
            <Text style={s.nextText}>Next: Ep {nextEpisode.number}</Text>
            <ChevronRightIcon />
          </TouchableOpacity>
        </View>
      )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: D.bg },
  // The wrapper fills the space; the player itself is pinned to 16:9 and
  // centred inside it. Both were `flex: 1`, which made the player take the
  // shape of whatever box it landed in -- a tall column in portrait -- so the
  // video was stretched rather than letterboxed. Nearly all anime is 16:9, so
  // constraining the frame and letting the black fill the remainder is both
  // correct and what every video app does.
  playerWrap: {
    flex: 1,
    position: 'relative',
    backgroundColor: D.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  player: {
    width: '100%',
    aspectRatio: 16 / 9,
    maxHeight: '100%',
    backgroundColor: D.bg,
  },
  loaderOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    zIndex: 20,
  },
  errorCard: {
    backgroundColor: '#1A1A26',
    borderRadius: 16,
    padding: 28,
    marginHorizontal: 32,
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: 'rgba(232,69,69,0.2)',
  },
  errorTitle: {
    color: D.text,
    fontSize: FontSize.lg,
    fontFamily: Fonts.bodyBold,
  },
  errorText: {
    color: D.muted,
    fontSize: FontSize.sm,
    fontFamily: Fonts.body,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorBtnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  errorBtn: {
    backgroundColor: D.pink,
    borderRadius: Radius.full,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  errorBtnOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  errorBtnText: {
    color: D.text,
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyBold,
  },
  errorBtnTextOutline: {
    color: D.muted,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
    backgroundColor: 'rgba(0,0,0,0.54)',
    zIndex: 10,
  },
  topBarSpacer: { width: 44 },
  circleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: { flex: 1 },
  showTitle: {
    color: D.text,
    fontSize: FontSize.md,
    fontFamily: Fonts.bodyBold,
    lineHeight: 20,
  },
  epTitle: {
    color: D.muted,
    fontSize: FontSize.sm,
    fontFamily: Fonts.body,
    marginTop: 2,
  },
  categoryPill: {
    backgroundColor: D.pink,
    borderRadius: Radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  categoryText: {
    color: D.text,
    fontSize: FontSize.xs,
    fontFamily: Fonts.bodyBold,
    letterSpacing: 0.8,
  },
  skipWrap: {
    position: 'absolute',
    right: 16,
  },
  skipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: D.pink,
    borderRadius: Radius.full,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  skipText: {
    color: D.text,
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyBold,
  },
  nextWrap: {
    position: 'absolute',
    right: 16,
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: Radius.full,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  nextText: {
    color: D.text,
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyBold,
  },
});
