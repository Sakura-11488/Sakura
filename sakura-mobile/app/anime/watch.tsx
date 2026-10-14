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
import EmbedPlayer from '@/components/anime/EmbedPlayer';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as NavigationBar from 'expo-navigation-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { Fonts, FontSize, Radius } from '@/constants/theme';
import {
  fetchAnimeInfo,
  fetchEpisodeSources,
  getAnimeStreamUserAgent,
  prewarmEpisodeStream,
  type AnimeInfo,
  type AnimeEpisode,
  type StreamingSource,
} from '@/lib/anime';
import { noteAnimePlayback } from '@/lib/anime-watchlist';
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
  setAnimeWatchProgress,
  setAnimeWatchProgressWithAdvance,
  RESUME_MIN,
  canResumeWatchProgress,
  type AnimeWatchProgress,
} from '@/lib/watch-progress';
import { getOfflinePlaybackUri, listOfflineEpisodes, type OfflineEpisode } from '@/lib/anime-offline';
import WebVideoPlayer, { type WebVideoPlayerHandle } from '@/components/anime/WebVideoPlayer';
import WatchViewport from '@/components/anime/WatchViewport';
import { readPlayerPreferences, savePlayerPreferences } from '@/components/anime/player-preferences';
import { fetchAnimeSkipTimes, mergeAnimeSkipMarkers } from '@/lib/anime-skip-times';

const D = {
  bg: '#000000',
  pink: '#E84545',
  text: '#FFFFFF',
  muted: 'rgba(255,255,255,0.55)',
};
const WEB_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const CATALOG_EPISODE_ID = /^(?:hi|mal)-\d+-\d+$/;

/**
 * Series metadata rebuilt from the downloads, for playing with no network.
 *
 * Every progress effect below needs `anime`, and offline it never arrived: the
 * info cache keeps titles for 24 hours, after which fetchAnimeInfo has nothing
 * to return. So a downloaded episode played, but nothing about it was saved.
 * The remote artwork URLs are kept on purpose — they end up in the watch
 * progress entry, which outlives the download.
 */
function animeFromOfflineRows(animeId: string, rows: OfflineEpisode[]): AnimeInfo | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.episodeNumber - b.episodeNumber);
  return {
    id: animeId,
    title: sorted[0].title,
    image: sorted[0].cover,
    cover: sorted[0].cover,
    episodes: sorted.map((row) => ({
      id: row.episodeId,
      number: row.episodeNumber,
      title: row.episodeTitle || `Episode ${row.episodeNumber}`,
      thumbnail: row.episodeThumbnail,
    })),
  };
}

/** "Episode 3 · Killing Magic", or just "Episode 3" when the title is only the number. */
function episodeHeading(number: number, title?: string): string {
  const base = `Episode ${number}`;
  const name = title?.trim();
  return name && !/^episode\s*\d+$/i.test(name) ? `${base} · ${name}` : base;
}

const isFinishedSeries = (status?: string) => /^(?:finished airing|finished)$/i.test(status?.trim() || '');

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
  const { id, ep, offline, restart } = useLocalSearchParams<{ id: string; ep: string; offline?: string; restart?: string }>();
  const router = useRouter();
  const safeAreaInsets = useSafeAreaInsets();
  // The web viewport maps its own safe-area edges when the player rotates.
  const insets = Platform.OS === 'web' ? WEB_INSETS : safeAreaInsets;

  const [anime, setAnime] = useState<AnimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [category, setCategory] = useState<'sub' | 'dub'>(() =>
    Platform.OS === 'web' ? readPlayerPreferences().audio ?? 'sub' : 'sub',
  );
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
  const [webSubtitles, setWebSubtitles] = useState<StreamingSource['subtitles']>([]);
  const playbackHeadersRef = useRef<Record<string, string> | undefined>(undefined);
  const webVideoRef = useRef<WebVideoPlayerHandle | null>(null);
  const [embedFallbackUrl, setEmbedFallbackUrl] = useState<string | null>(null);
  const [skipMarkers, setSkipMarkers] = useState<{
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  }>({});
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [fallbackSkipMarkers, setFallbackSkipMarkers] = useState<typeof skipMarkers>({});
  const nativeFailedRef = useRef(false);
  const [resumeSeconds, setResumeSeconds] = useState(0);
  const progressRef = useRef(0);
  const pendingResumeRef = useRef(0);
  const pendingResumeSecondsRef = useRef(0);
  const playbackEpisodeKeyRef = useRef<string | null>(null);
  const restartRequestedRef = useRef(restart === '1');
  const resumeSeekDoneRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchStartedAtRef = useRef<number | null>(null);
  const animeRef = useRef<AnimeInfo | null>(null);
  const episodeRef = useRef<AnimeEpisode | null>(null);
  const [controlsVisible, setControlsVisible] = useState(false);
  const webBookmarkRef = useRef<{ entry: AnimeWatchProgress; episodes: AnimeEpisode[] } | null>(null);
  const savedWebBookmarkRef = useRef<typeof webBookmarkRef.current>(null);
  const lastWebSaveRef = useRef(0);
  /** This series' download rows, read when playing a downloaded copy. */
  const offlineRowsRef = useRef<OfflineEpisode[]>([]);
  /** The next episode's stream has been looked up ahead of the handoff. */
  const nextPrewarmedRef = useRef(false);
  const nextEpisodeRef = useRef<AnimeEpisode | null>(null);
  const categoryRef = useRef(category);
  /** Playback has been reported to the watchlist for this title. */
  const watchlistNotedRef = useRef<string | null>(null);

  const saveWebBookmark = useCallback(() => {
    const bookmark = webBookmarkRef.current;
    if (!bookmark || bookmark === savedWebBookmarkRef.current) return;
    savedWebBookmarkRef.current = bookmark;
    lastWebSaveRef.current = Date.now();
    void setAnimeWatchProgressWithAdvance(bookmark.entry, bookmark.episodes);
  }, []);

  useEffect(() => {
    if (!isWeb) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveWebBookmark();
    };
    window.addEventListener('pagehide', saveWebBookmark);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', saveWebBookmark);
      document.removeEventListener('visibilitychange', onVisibility);
      saveWebBookmark();
    };
  }, [isWeb, saveWebBookmark]);

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

  const currentEpisodeIndex = useMemo(() => {
    if (!anime) return -1;
    const exact = anime.episodes.findIndex((episode) => episode.id === ep);
    if (exact >= 0) return exact;
    // Shared MAL watch links and the source catalog can name the same episode
    // differently. Match its number only inside this title's catalog.
    if (anime.id === String(id) && CATALOG_EPISODE_ID.test(ep || '')) {
      return anime.episodes.findIndex((episode) => episode.number === epNumInt);
    }
    return -1;
  }, [anime, ep, id, epNumInt]);
  const currentEpisode: AnimeEpisode | null =
    currentEpisodeIndex >= 0 ? (anime?.episodes[currentEpisodeIndex] ?? null) : null;
  const nextEpisode: AnimeEpisode | null =
    currentEpisodeIndex >= 0 && anime && currentEpisodeIndex < anime.episodes.length - 1
      ? (anime.episodes[currentEpisodeIndex + 1] ?? null)
      : null;
  nextEpisodeRef.current = nextEpisode;
  categoryRef.current = category;

  const progressEpisode = useMemo((): AnimeEpisode | null => {
    if (currentEpisode) return currentEpisode;
    if (!ep) return null;
    const num = parseInt(epNum, 10) || 1;
    return { id: ep, number: num, title: `Episode ${num}` };
  }, [currentEpisode, ep, epNum]);

  const recordWebProgress = useCallback((seconds: number, duration: number, checkpoint = false, ended = false) => {
    if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return;
    setDurationSeconds(duration);
    const position = Math.max(0, Math.min(seconds, duration));
    const progress = position / duration;
    progressRef.current = progress;
    pendingResumeRef.current = progress;
    pendingResumeSecondsRef.current = position;
    if (!anime || !progressEpisode) return;
    webBookmarkRef.current = {
      entry: {
        animeId: String(id), title: anime.title, cover: anime.cover || anime.image || '',
        episodeId: progressEpisode.id, episodeNumber: progressEpisode.number,
        episodeTitle: progressEpisode.title, episodeThumbnail: progressEpisode.thumbnail,
        progress, positionSeconds: position, durationSeconds: duration,
        completed: ended, updatedAt: Date.now(),
      },
      episodes: anime.episodes || [],
    };
    // Record a real clock every three seconds, including the first few seconds
    // of an episode; pause, scrubbing, restart, and exit save immediately.
    if (checkpoint || Date.now() - lastWebSaveRef.current >= 3000) saveWebBookmark();
    // Near the end, look up the next episode's stream so Up Next and the
    // autoplay handoff start from a resolved URL instead of a fresh lookup.
    const upcoming = nextEpisodeRef.current;
    if (upcoming && !nextPrewarmedRef.current && (duration - position <= 240 || progress >= 0.85)) {
      nextPrewarmedRef.current = true;
      prewarmEpisodeStream(upcoming.id, categoryRef.current, String(id));
    }
    // The last episode of a finished series, watched to the end, completes it.
    // "No next episode" alone is not enough: it is also true while the episode
    // is missing from the list (an unmatched id), which is not the finale.
    const finale = anime.episodes[anime.episodes.length - 1];
    if (ended && !upcoming && finale?.id === progressEpisode.id && isFinishedSeries(anime.status)) {
      void noteAnimePlayback({ animeId: String(id), title: anime.title, cover: anime.cover || anime.image || '' }, 'finished-series');
    }
  }, [id, anime, progressEpisode, saveWebBookmark]);

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
      // Estimated/embed updates may not carry a clock. Keep the last measured
      // position instead of replacing a usable bookmark with undefined.
      const savedPosition = positionSeconds ?? (
        pendingResumeSecondsRef.current > 0 ? pendingResumeSecondsRef.current : undefined
      );
      if (p >= 0.98 || immediate) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        await flushProgress(p, info, episode, savedPosition);
        return;
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushProgress(p, info, episode, savedPosition);
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

  // Opening times vary by episode and cut. Only offer a skip when real timing
  // data matches the duration of the stream that is actually playing.
  useEffect(() => {
    if (!isWeb || durationSeconds <= 0 || !webReady) return;
    const validPrimary = mergeAnimeSkipMarkers(skipMarkers, undefined, durationSeconds);
    if (validPrimary.intro && validPrimary.outro) return;
    setFallbackSkipMarkers({});
    const controller = new AbortController();
    void fetchAnimeSkipTimes(String(id), epNumInt, durationSeconds, { signal: controller.signal, force: retryCount > 0 })
      .then(markers => { if (!controller.signal.aborted) setFallbackSkipMarkers(markers); });
    return () => controller.abort();
  }, [isWeb, id, epNumInt, category, retryCount, webStreamUri, durationSeconds, webReady, skipMarkers.intro, skipMarkers.outro]);

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
    if (Platform.OS !== 'web') {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => undefined);
    }

    return () => {
      if (controlsTimerRef.current) {
        clearTimeout(controlsTimerRef.current);
        controlsTimerRef.current = null;
      }
      StatusBar.setHidden(false, 'fade');
      if (Platform.OS === 'android') {
        void NavigationBar.setVisibilityAsync('visible').catch(() => undefined);
      }
      if (Platform.OS !== 'web') {
        void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    // A Start over action is one-shot; a later reload resumes the new position.
    if (isWeb && restart === '1') router.setParams?.({ restart: undefined });
  }, [isWeb, restart, router]);

  useEffect(() => {
    if (!id || !ep) return;
    let cancelled = false;
    const episodeKey = JSON.stringify([id, ep]);
    const episodeChanged = playbackEpisodeKeyRef.current !== episodeKey;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (episodeChanged) {
      if (isWeb) saveWebBookmark();
      nextPrewarmedRef.current = false;
      webBookmarkRef.current = null;
      savedWebBookmarkRef.current = null;
      lastWebSaveRef.current = 0;
      progressRef.current = 0;
      pendingResumeRef.current = 0;
      pendingResumeSecondsRef.current = 0;
    }

    setLoading(true);
    setError(null);
    setEmbedUrl(null);
    setLocalUri(null);
    setStreamSource(null);
    setEmbedFallbackUrl(null);
    setAllSources([]);
    setSourceIndex(0);
    setWebSubtitles([]);
    setSubtitleMode('off');
    playbackHeadersRef.current = undefined;
    setSkipMarkers({});
    setFallbackSkipMarkers({});
    setDurationSeconds(0);
    setCurrentTimeSec(pendingResumeSecondsRef.current);
    setWebReady(false);
    setResumeSeconds(0);
    resumeSeekDoneRef.current = false;
    nativeFailedRef.current = false;
    watchStartedAtRef.current = null;

    (async () => {
      // Category switches and retries stay in the current episode. Their
      // in-memory clock is newer than the throttled persisted bookmark.
      const saved = episodeChanged
        ? await getAnimeWatchProgress(String(id), ep, epNumInt).catch(() => null)
        : null;
      if (cancelled) return;
      playbackEpisodeKeyRef.current = episodeKey;
      const matchingBookmark = saved && (saved.episodeId === ep || (
        CATALOG_EPISODE_ID.test(ep || '') && CATALOG_EPISODE_ID.test(saved.episodeId) && saved.episodeNumber === epNumInt
      ));
      if (restartRequestedRef.current && matchingBookmark) {
        await setAnimeWatchProgress({ ...saved, progress: 0, positionSeconds: 0, completed: false, updatedAt: Date.now() });
        if (cancelled) return;
      }
      if (
        matchingBookmark &&
        !restartRequestedRef.current &&
        canResumeWatchProgress(saved)
      ) {
        progressRef.current = saved.progress;
        pendingResumeRef.current = saved.progress;
        if (saved.positionSeconds && saved.positionSeconds > 0) {
          pendingResumeSecondsRef.current = saved.positionSeconds;
        }
      }

      restartRequestedRef.current = false;

      const {
        fetchSakuraOriginalInfo,
        getSakuraOriginalEmbedUrl,
        isSakuraOriginal,
        resolveSakuraOriginalStreamUrl,
      } = await import('@/lib/sakura-originals');
      const isOriginal = isSakuraOriginal(String(id));
      // Title metadata is needed by every path below except Originals, and
      // nothing below needs to wait for it: start it now and apply it when it
      // lands. (It used to be awaited before the stream lookup, so a slow
      // metadata source delayed playback by its whole timeout.)
      const infoRequest: Promise<AnimeInfo | null> = isOriginal
        ? Promise.resolve(null)
        : fetchAnimeInfo(id, { force: retryCount > 0 }).catch(() => null);

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
        const rows = (await listOfflineEpisodes().catch(() => [] as OfflineEpisode[]))
          .filter((row) => row.animeId === String(id));
        if (cancelled) return;
        offlineRowsRef.current = rows;
        const row = rows.find((candidate) => candidate.episodeId === ep);
        // Captions and skip markers were reset above and, for a local file,
        // never set again — so a downloaded episode lost its subtitles and its
        // Skip Opening button. The web store keeps both with the episode.
        if (row?.subtitles?.length) {
          setWebSubtitles(row.subtitles.map((track) => ({ url: track.uri, lang: track.lang, label: track.label })));
          setSubtitleMode(playbackHint?.subtitleMode ?? (isWeb ? 'auto' : 'off'));
        }
        if (row?.intro || row?.outro) setSkipMarkers({ intro: row.intro, outro: row.outro });
        const fallback = animeFromOfflineRows(String(id), rows);
        if (fallback) setAnime((current) => current?.id === String(id) ? current : fallback);
        if (row) {
          setAvailableCategories([row.category]);
          setCategory(row.category);
        }
        setLocalUri(cached);
        // Play first. This used to await the metadata request before hiding
        // the loader, so with no network the "Preparing your episode" overlay
        // sat over a playable copy until the request timed out.
        setLoading(false);
        // Metadata has to come from the right backend: fetchAnimeInfo is the
        // Consumet call and returns nothing for an Originals id. It replaces
        // the rows-only fallback when it arrives (full episode list for "next").
        void (isOriginal
          ? fetchSakuraOriginalInfo(String(id), { force: retryCount > 0 })
          : infoRequest
        ).catch(() => null).then((info) => {
          if (!cancelled && info) setAnime(info);
        });
        return;
      }

      if (forceOffline || (isWeb && typeof navigator !== 'undefined' && navigator.onLine === false)) {
        // A web copy can be complete and still unplayable: only a tab the
        // service worker controls can read /app/__offline/ (see
        // getOfflinePlaybackUri). Say so, instead of telling the user to
        // download again something that is already on the device.
        const row = isWeb
          ? (await listOfflineEpisodes().catch(() => [] as OfflineEpisode[]))
            .find((candidate) => candidate.animeId === String(id) && candidate.episodeId === ep)
          : undefined;
        if (cancelled) return;
        const uncontrolled = isWeb && typeof navigator !== 'undefined' && !navigator.serviceWorker?.controller;
        setError(row?.status === 'ready' && uncontrolled
          ? 'This download can play once Sakura finishes loading in this tab. Reload the page and try again.'
          : 'Offline file not found. Download the episode again while online.');
        setLoading(false);
        return;
      }


      // Sakura Originals — stream directly via native video player
      if (isOriginal) {
        const info = await fetchSakuraOriginalInfo(String(id), { force: retryCount > 0 });
        if (cancelled) return;
        if (info) setAnime(info);

        const embed = isWeb ? getSakuraOriginalEmbedUrl(ep) : null;
        const mp4 = await resolveSakuraOriginalStreamUrl(ep, { force: retryCount > 0 });
        if (cancelled) return;
        if (mp4) {
          setEmbedFallbackUrl(embed);
          setLocalUri(mp4);
          setLoading(false);
          return;
        }

        if (embed) {
          setEmbedFallbackUrl(embed);
          setError('Direct playback is unavailable for this episode. You can retry or choose the external player.');
          setLoading(false);
          return;
        }
      }


      // The stream lookup needs only the episode and MAL ids, so it runs in
      // parallel with the metadata request above.
      void infoRequest.then((info) => { if (!cancelled && info) setAnime(info); });
      let src = await fetchEpisodeSources(ep, category, id, {
        force: retryCount > 0 || !!playbackHint?.forceFreshSource,
      }).catch(() => null);
      if (!src?.unavailableCategory && !src?.embedUrl && !src?.url) {
        if (isWeb) {
          // A failed lookup does not establish which audio is available. Keep
          // the chosen language and offer an explicit switch in recovery UI.
          if (!cancelled) setAvailableCategories(['sub', 'dub']);
        } else if (retryCount === 0) {
          src = await fetchEpisodeSources(
            ep,
            category === 'sub' ? 'dub' : 'sub',
            id,
            { force: !!playbackHint?.forceFreshSource },
          ).catch(() => null);
        }
      }
      if (cancelled) return;

      if (src?.unavailableCategory) {
        setAvailableCategories(src.availableCategories ?? ['sub', 'dub']);
        const unavailable = src.unavailableCategory.toUpperCase();
        const alternative = src.unavailableCategory === 'sub' ? 'DUB' : 'SUB';
        setError(`Episode ${epNum} is not available in ${unavailable} from the current source. Try ${alternative}.`);
      } else if (src?.embedUrl || src?.url) {
        if (src.availableCategories?.length) {
          setAvailableCategories(src.availableCategories);
        }
        setSkipMarkers({ intro: src.intro, outro: src.outro });
        playbackHeadersRef.current = src.requestHeaders;
        setAllSources(src.allSources ?? []);
        setSourceIndex(0);
        setWebSubtitles(src.subtitles ?? []);
        setSubtitleMode(playbackHint?.subtitleMode ?? (isWeb && src.subtitles?.length ? 'auto' : 'off'));

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
          if (isWeb) {
            setEmbedFallbackUrl(src.embedUrl);
            setError('Direct playback is unavailable for this episode. You can retry, switch sub/dub, or choose the external player.');
          } else {
            setEmbedFallbackUrl(null);
            setEmbedUrl(src.embedUrl);
          }
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
  }, [id, ep, category, retryCount, forceOffline, isAndroid, isWeb, playbackHint, saveWebBookmark]);

  useEffect(() => {
    if (isWeb || !nativeSource || !anime || !progressEpisode) return;
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
  }, [nativeSource, anime, progressEpisode, nativePlayer, isWeb]);

  useEffect(() => {
    if (isWeb || !nativeSource || !anime || !progressEpisode) return;
    const sub = nativePlayer.addListener('timeUpdate', ({ currentTime }) => {
      setCurrentTimeSec(currentTime);
      const duration = nativePlayer.duration;
      if (duration <= 0) return;
      const next = Math.min(1, Math.max(0, currentTime / duration));
      pendingResumeRef.current = next;
      pendingResumeSecondsRef.current = currentTime;
      if (Math.abs(next - progressRef.current) < 0.008 && next < 0.98) return;
      progressRef.current = next;
      void persistProgress(next, anime, progressEpisode, false, currentTime);
    });
    return () => sub.remove();
  }, [nativeSource, anime, progressEpisode, nativePlayer, persistProgress, isWeb]);

  // Fall back to the web embed if native HLS playback errors (e.g. CDN 403).
  useEffect(() => {
    if (!streamSource || isWeb) return;
    const sub = nativePlayer.addListener('statusChange', ({ status }) => {
      if (status !== 'error' || nativeFailedRef.current) return;

      const next = allSources[sourceIndex + 1];
      if (next?.url) {
        resumeSeekDoneRef.current = false;
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
    resumeSeekDoneRef.current = false;
    setFallbackSkipMarkers({});
    setDurationSeconds(0);
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
    setLocalUri(null);
    setStreamSource(null);
    setWebReady(false);
    setError(embedFallbackUrl
      ? 'Direct playback failed. You can retry, switch sub/dub, or choose the external player.'
      : 'Playback failed. Try Retry or switch sub/dub.');
  }, [tryNextAlternateSource, embedFallbackUrl]);

  const openExternalPlayer = () => {
    if (!isWeb || !embedFallbackUrl || typeof window === 'undefined') return;
    playTap();
    // This provider rejects popup-blocking sandboxes. Keep it outside Sakura
    // and open it only after an explicit click, without access to our window.
    window.open(embedFallbackUrl, '_blank', 'noopener');
  };

  useEffect(() => {
    if (isWeb || !nativeSource || !anime || !progressEpisode) return;
    const tick = setInterval(() => {
      if (progressRef.current >= RESUME_MIN) return;
      void persistProgress(getEstimatedProgress(), anime, progressEpisode);
    }, 10_000);
    return () => clearInterval(tick);
  }, [nativeSource, anime, progressEpisode, getEstimatedProgress, persistProgress, isWeb]);

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
    // Pressing play is what MAL and AniList call "Watching": list it (or move
    // it back from Plan to watch / On hold / Dropped) once per title visit.
    if ((!webReady && !nativeSource) || !anime || anime.id !== String(id) || watchlistNotedRef.current === anime.id) return;
    watchlistNotedRef.current = anime.id;
    void noteAnimePlayback({ animeId: anime.id, title: anime.title, cover: anime.cover || anime.image || '' }, 'started');
  }, [webReady, nativeSource, anime, id]);

  useEffect(() => {
    // Direct players report an exact clock; estimates are only for embeds.
    if (!webReady || nativeSource || !anime || !progressEpisode) return;
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
    if (isWeb) return;
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
  }, [flushProgress, isWeb]);

  const handleWebMessage = (raw: string) => {
    try {
      const data = JSON.parse(raw) as { type?: string; progress?: number; duration?: number };
      if (data.type !== 'progress' || !data.duration || data.duration <= 0) return;
      const next = Math.min(1, Math.max(0, (data.progress || 0) / data.duration));
      pendingResumeRef.current = next;
      pendingResumeSecondsRef.current = Math.max(0, data.progress || 0);
      if (Math.abs(next - progressRef.current) < 0.008 && next < 0.98) return;
      progressRef.current = next;
      if (anime && progressEpisode) void persistProgress(next, anime, progressEpisode, false, pendingResumeSecondsRef.current);
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

  const episodeLabel = episodeHeading(epNumInt, currentEpisode?.title);
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
      if (isWeb) savePlayerPreferences({ audio: next });
    }
  };

  const goToNext = () => {
    if (!nextEpisode || !anime) return;
    playTap();
    // Native files carry the flag as before. A web copy carries it when the
    // next episode is downloaded too (as the series page does) or there is no
    // network at all; otherwise the next episode should simply stream.
    const nextIsLocal = !!localUri?.startsWith('file://') || (
      !!localUri?.startsWith('/app/__offline/') && (
        offlineRowsRef.current.some((row) => row.episodeId === nextEpisode.id && row.status === 'ready') ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
      )
    );
    if (isWeb) {
      saveWebBookmark();
      webBookmarkRef.current = null;
    }
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
    if (isWeb) {
      // Retain the viewport/fullscreen element and audio choice between episodes.
      router.setParams({ ep: nextEpisode.id, restart: undefined, offline: nextIsLocal ? '1' : undefined });
      return;
    }
    router.replace({
      pathname: '/anime/watch',
      params: {
        id,
        ep: nextEpisode.id,
        ...(nextIsLocal ? { offline: '1' } : {}),
      },
    });
  };

  const skipIntro = () => {
    if (!skipMarkers.intro) return;
    playTap();
    const target = skipMarkers.intro.end;
    // Every web source plays in WebVideoPlayer, downloaded copies included;
    // this used to require streamSource, so skipping did nothing offline.
    if (isWeb) {
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
      if (isWeb) {
        webVideoRef.current?.seekTo(target);
      } else {
        nativePlayer.currentTime = target;
      }
    }
  };

  const embedSource = { uri: embedUrl || '', headers: playbackHeadersRef.current };
  const showNativeEmbedPlayer = !isWeb && !!embedUrl && !nativeSource && !error;
  const showWebDirectPlayer = isWeb && !!nativeSource && !error &&
    playbackEpisodeKeyRef.current === JSON.stringify([id, ep]);
  const showNativePlayer = !!nativeSource && !error && !isWeb;
  const showPlayer = showNativeEmbedPlayer || showWebDirectPlayer || showNativePlayer;
  const showLoader = loading || (showNativeEmbedPlayer && !webReady);
  const showCategoryToggle =
    (showNativeEmbedPlayer || showWebDirectPlayer || !!streamSource) && availableCategories.length > 1;

  const canShowSkipButtons = showNativePlayer || showWebDirectPlayer;
  const webSkipMarkers = mergeAnimeSkipMarkers(skipMarkers, fallbackSkipMarkers, durationSeconds);
  const leavePlayer = () => {
    playTap();
    if (isWeb) {
      saveWebBookmark();
      // After a hard reload Expo can have Home behind this route. The player
      // promises the episode list, so return to the series explicitly.
      router.dismissTo({ pathname: '/anime/[id]', params: { id: String(id) } });
      return;
    }
    if (animeRef.current && episodeRef.current && progressRef.current >= 0.01) {
      void flushProgress(progressRef.current, animeRef.current, episodeRef.current,
        pendingResumeSecondsRef.current > 0 ? pendingResumeSecondsRef.current : undefined);
    }
    if (router.canGoBack?.() !== false) router.back();
    else router.replace({ pathname: '/anime/[id]', params: { id: String(id) } });
  };
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
    <WatchViewport>
    <View style={s.root}>
      <StatusBar hidden barStyle="light-content" backgroundColor={D.bg} />

      <View style={s.playerWrap} onTouchStart={showWebDirectPlayer ? undefined : revealControls}>
      {showWebDirectPlayer && (
        <WebVideoPlayer
          key={`${id}:${ep}`}
          ref={webVideoRef}
          uri={webStreamUri}
          headers={webStreamHeaders}
          isM3U8={streamSource?.isM3U8}
          subtitleMode={subtitleMode}
          subtitles={webSubtitles}
          style={s.webPlayer}
          startAt={pendingResumeSecondsRef.current > 0 ? pendingResumeSecondsRef.current : undefined}
          startProgress={pendingResumeRef.current}
          chrome={{
            title: anime?.title || 'Sakura',
            artwork: typeof anime?.cover === 'string' && anime.cover ? anime.cover : anime?.image || undefined,
            episodeLabel,
            episodeNumber: epNumInt,
            onBack: leavePlayer,
            category,
            availableCategories,
            onToggleCategory: toggleCategory,
            intro: webSkipMarkers.intro,
            outro: webSkipMarkers.outro,
            nextEpisode: nextEpisode ? {
              label: `Episode ${nextEpisode.number}`,
              title: nextEpisode.title,
              number: nextEpisode.number,
              thumbnail: nextEpisode.thumbnail,
              onPlay: goToNext,
            } : undefined,
          }}
          onReady={() => setWebReady(true)}
          onError={handleDirectPlaybackFailure}
          onTimeUpdate={(currentTime, duration) => recordWebProgress(currentTime, duration)}
          onCheckpoint={(currentTime, duration, ended) => recordWebProgress(currentTime, duration, true, ended)}
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

      {!showWebDirectPlayer && (controlsVisible || error || (isWeb && loading)) && (
        <View style={[s.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <TouchableOpacity
            onPress={leavePlayer}
            style={s.circleBtn}
          >
            <BackIcon />
          </TouchableOpacity>

          <View style={s.titleWrap}>
            <Text style={s.showTitle} numberOfLines={1}>{anime?.title ?? ''}</Text>
            <Text style={s.epTitle} numberOfLines={1}>
              {episodeLabel}
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

      {showNativeEmbedPlayer && (
        <EmbedPlayer
          key={`${embedUrl}-${category}`}
          source={embedSource}
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
          onFailed={() => {
            setError('Video player failed to load.\nCheck your connection and try again.');
            setEmbedUrl(null);
          }}
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
          <ActivityIndicator size={isWeb ? 'small' : 'large'} color={D.pink} />
          {isWeb && <Text style={s.loadingLabel}>Preparing your episode</Text>}
        </View>
      )}

      {error && !loading && (
        <View style={s.errorOverlay}>
          <View style={s.errorCard}>
            <Text style={s.errorTitle}>{isWeb && embedFallbackUrl ? 'Choose how to continue' : 'Playback Error'}</Text>
            <Text style={s.errorText}>{error}</Text>
            <View style={s.errorBtnRow}>
              <TouchableOpacity
                onPress={() => { playTap(); setRetryCount((c) => c + 1); }}
                style={[s.errorBtn, s.errorBtnOutline]}
                activeOpacity={0.8}
              >
                <Text style={[s.errorBtnText, s.errorBtnTextOutline]}>Retry</Text>
              </TouchableOpacity>
              {isWeb && availableCategories.includes(category === 'sub' ? 'dub' : 'sub') && (
                <TouchableOpacity
                  onPress={onTap(toggleCategory)}
                  style={[s.errorBtn, s.errorBtnOutline]}
                  accessibilityRole="button"
                  activeOpacity={0.8}
                >
                  <Text style={[s.errorBtnText, s.errorBtnTextOutline]}>Try {category === 'sub' ? 'DUB' : 'SUB'}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={leavePlayer} style={s.errorBtn} activeOpacity={0.8}>
                <Text style={s.errorBtnText}>Go Back</Text>
              </TouchableOpacity>
            </View>
            {isWeb && embedFallbackUrl && (
              <>
                <TouchableOpacity
                  onPress={openExternalPlayer}
                  style={[s.errorBtn, s.errorBtnOutline]}
                  accessibilityRole="button"
                  activeOpacity={0.8}
                >
                  <Text style={[s.errorBtnText, s.errorBtnTextOutline]}>Open external player</Text>
                </TouchableOpacity>
                <Text style={s.errorText}>Opens a new tab. The provider may show ads.</Text>
              </>
            )}
          </View>
        </View>
      )}

      {!isWeb && (introActive || outroActive) && (
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

      {!isWeb && controlsVisible && nextEpisode && showPlayer && (nativeSource || (webReady && !error)) && !error && (
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
    </WatchViewport>
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
  webPlayer: {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    width: '100%', height: '100%', backgroundColor: D.bg,
  },
  loaderOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    gap: 14,
  },
  loadingLabel: { color: D.muted, fontFamily: Fonts.body, fontSize: 12, letterSpacing: 0.4 },
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    zIndex: 20,
  },
  errorCard: {
    backgroundColor: Platform.OS === 'web' ? '#111116' : '#1A1A26',
    borderRadius: 16,
    padding: Platform.OS === 'web' ? 20 : 28,
    maxWidth: Platform.OS === 'web' ? 480 : undefined,
    marginHorizontal: 32,
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: Platform.OS === 'web' ? 'rgba(255,255,255,0.12)' : 'rgba(232,69,69,0.2)',
  },
  errorTitle: {
    color: D.text,
    fontSize: Platform.OS === 'web' ? 19 : FontSize.lg,
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
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
  },
  errorBtn: {
    backgroundColor: D.pink,
    borderRadius: Platform.OS === 'web' ? 8 : Radius.full,
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
