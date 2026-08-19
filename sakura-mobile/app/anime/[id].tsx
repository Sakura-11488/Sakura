import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  useWindowDimensions,
  StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  withTiming,
  withRepeat,
  withSequence,
  withSpring,
  interpolate,
  Extrapolation,
  FadeInDown,
  Easing,
} from 'react-native-reanimated';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path, Polygon } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { Toast } from '@/components/ui/Toast';
import CommentsSection from '@/components/social/CommentsSection';
import { fetchAnimeInfo, type AnimeInfo, type AnimeEpisode } from '@/lib/anime';
import { getAnimeWatchProgress, subscribeWatchProgress, type AnimeWatchProgress } from '@/lib/watch-progress';
import {
  downloadAnimeEpisode,
  getOfflineEpisode,
  pauseAnimeEpisodeDownload,
  resumeAnimeEpisodeDownload,
  subscribeOfflineEpisodes,
  type OfflineEpisode,
} from '@/lib/anime-offline';
import { playTap, onTap } from '@/lib/sound';
import { Library } from '@/lib/storage';
import { useTheme } from '@/lib/theme';
import { shareContentLink } from '@/lib/share-link';
import { contentWidth, isWideWeb, MAX_CONTENT_WIDTH } from '@/constants/layout';
import CreatorTab from '@/components/ui/CreatorTab';
import { getSakuraOriginalAuthor, isSakuraOriginal } from '@/lib/sakura-originals';

/**
 * Hero height.
 *
 * `W * 0.88` is a portrait-poster ratio and it is right on a phone. On a 1920px
 * desktop window it computed to roughly 1690px — taller than the viewport — so
 * the hero swallowed the entire screen, nothing below it was reachable without
 * scrolling, and the sticky call-to-action ended up pinned to the bottom edge
 * looking like a banner. That is the layout in the bug report.
 *
 * On desktop the hero becomes a band instead: tall enough to be cinematic,
 * short enough that the episode list is visible underneath, which is the whole
 * point of having more screen.
 */
const DESKTOP_HERO_H = 560;
const HEADER_FADE_DISTANCE = 48;

/**
 * Read reactively, because these decide a layout MODE and not just a size.
 *
 * As module constants they were evaluated once when the bundle was required,
 * and nothing in the app re-reads Dimensions — so `isWideWeb(W)` froze the
 * desktop-vs-phone branch at bundle-evaluation time. W is the content width
 * rather than the window width: on desktop web the sidebar is a sibling of this
 * column, so sizing off the raw window overflows by exactly SIDEBAR_WIDTH.
 */
function useDetailMetrics() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const wide = isWideWeb(windowW);
    const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    const HERO_H = wide ? Math.min(W * 0.88, DESKTOP_HERO_H) : W * 0.88;
    return { wide, W, HERO_H, HEADER_TRIGGER: Math.round(HERO_H * 0.35) };
  }, [windowW]);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const BackIcon = () => (
  <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const ShareIcon = () => (
  <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
    <Path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"
      stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const BookmarkIcon = ({ saved, color = '#fff' }: { saved: boolean; color?: string }) => (
  <Svg width={19} height={19} viewBox="0 0 24 24" fill={saved ? color : 'none'}>
    <Path
      d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

const StarIcon = ({ goldColor }: { goldColor: string }) => (
  <Svg width={11} height={11} viewBox="0 0 24 24">
    <Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill={goldColor} />
  </Svg>
);

const PlayIcon = ({ size = 16 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="#fff">
    <Path d="M5 3l14 9-14 9V3z" fill="#fff" />
  </Svg>
);

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function DetailSkeleton({ onBack }: { onBack: () => void }) {
  const { W, HERO_H } = useDetailMetrics();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, []);

  const anim = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const Bar = ({
    h,
    w = '100%',
    r = 8,
    mb = 0,
    style,
  }: {
    h: number;
    w?: number | string;
    r?: number;
    mb?: number;
    style?: object;
  }) => (
    <Animated.View
      style={[anim, { height: h, width: w as number, borderRadius: r, marginBottom: mb, backgroundColor: colors.border }, style]}
    />
  );

  const EpisodeSkel = () => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
      }}
    >
      <Animated.View style={[anim, { width: 96, height: 58, borderRadius: Radius.xs, backgroundColor: colors.border }]} />
      <View style={{ flex: 1, gap: 6 }}>
        <Bar h={10} w={44} r={4} mb={0} />
        <Bar h={12} w="88%" r={4} mb={0} />
      </View>
      <Bar h={28} w={28} r={14} mb={0} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />

      <Animated.View style={[{ width: W, height: HERO_H, backgroundColor: colors.surfaceSecondary }, anim]} />

      <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 }} pointerEvents="box-none">
        <View style={{ paddingHorizontal: Spacing.md, paddingTop: 8 }}>
          <TouchableOpacity
            onPress={onBack}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: 'rgba(0,0,0,0.40)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            activeOpacity={0.85}
          >
            <BackIcon />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <View
        style={{
          marginTop: -50,
          paddingHorizontal: Spacing.md,
          paddingTop: 8,
          backgroundColor: colors.surface,
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          flex: 1,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
          <Bar h={22} w={52} r={Radius.full} />
          <Bar h={22} w={68} r={Radius.full} />
          <Bar h={22} w={40} r={Radius.full} />
        </View>

        <Bar h={28} w="88%" r={8} mb={10} />
        <Bar h={14} w={148} r={6} mb={12} />

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 14 }}>
          {[58, 72, 48, 56].map((w, i) => (
            <Bar key={i} h={22} w={w} r={Radius.full} mb={0} />
          ))}
        </View>

        <Bar h={13} mb={7} />
        <Bar h={13} mb={7} />
        <Bar h={13} w="72%" mb={18} />

        <View
          style={{
            flexDirection: 'row',
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            marginBottom: 14,
            marginTop: 4,
          }}
        >
          {[72, 36].map((w, i) => (
            <View key={i} style={{ flex: 1, alignItems: 'center', paddingVertical: 10 }}>
              <Bar h={12} w={w} r={4} mb={0} />
            </View>
          ))}
        </View>

        <EpisodeSkel />
        <EpisodeSkel />
        <EpisodeSkel />
        <EpisodeSkel />
      </View>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingTop: 12,
          paddingHorizontal: Spacing.md,
          paddingBottom: insets.bottom + 10,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
          flexDirection: 'row',
          gap: 8,
        }}
      >
        <Bar h={46} r={Radius.full} mb={0} style={{ flex: 1 }} />
        <Bar h={46} w={46} r={23} mb={0} />
      </View>
    </View>
  );
}

// ─── Glow CTA button ──────────────────────────────────────────────────────────
function GlowButton({ label, onPress, fullWidth }: { label: string; onPress: () => void; fullWidth?: boolean }) {
  const { colors } = useTheme();
  const glow = useSharedValue(0.3);
  const scale = useSharedValue(1);

  const gb = useMemo(() => StyleSheet.create({
    btn: {
      backgroundColor: colors.primary,
      borderRadius: Radius.full,
      paddingVertical: 13,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      flex: 1,
    },
    label: { color: '#fff', fontSize: FontSize.sm, fontFamily: Fonts.bodyBold, letterSpacing: 0.2 },
  }), [colors]);

  useEffect(() => {
    glow.value = withRepeat(
      withSequence(
        withTiming(0.55, { duration: 1200, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.22, { duration: 1200, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
  }, []);

  const glowStyle = useAnimatedStyle(() => ({
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: glow.value,
    shadowRadius: 14,
    elevation: 8,
  }));
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = async () => {
    scale.value = withSequence(withSpring(0.95), withSpring(1));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <Animated.View style={[glowStyle, { borderRadius: Radius.full, flex: fullWidth ? 1 : undefined }]}>
      <Animated.View style={scaleStyle}>
        <TouchableOpacity onPress={handlePress} activeOpacity={1} style={[gb.btn, fullWidth && { flex: 1 }]}>
          <PlayIcon size={14} />
          <Text style={gb.label}>{label}</Text>
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

// ─── Episode row ──────────────────────────────────────────────────────────────
const DownloadIcon = ({ color, size = 18 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12 3v12m0 0l4-4m-4 4L8 11M4 21h16"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

function EpisodeRow({
  ep,
  cover,
  progress,
  offline,
  onPress,
  onDownload,
  downloadable,
}: {
  ep: AnimeEpisode;
  cover?: string;
  progress?: number;
  offline?: OfflineEpisode | null;
  onPress: () => void;
  onDownload: () => void;
  /** False on web for sources a browser cannot fetch; the button explains itself. */
  downloadable: boolean;
}) {
  const { colors } = useTheme();
  const epS = useMemo(() => StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    thumbWrap: {
      width: 96, height: 58,
      borderRadius: Radius.xs,
      overflow: 'hidden',
      backgroundColor: colors.surfaceSecondary,
    },
    thumb: { width: '100%', height: '100%' },
    playOverlay: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.32)',
      alignItems: 'center', justifyContent: 'center',
    },
    info: { flex: 1 },
    num: { color: colors.primary, fontSize: 10, fontFamily: Fonts.bodyBold, textTransform: 'uppercase', letterSpacing: 0.5 },
    title: { color: colors.text, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium, marginTop: 2, lineHeight: 16 },
    desc: { color: colors.textSecondary, fontSize: 10, fontFamily: Fonts.body, marginTop: 2, lineHeight: 14 },
    progressTrack: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: 3,
      backgroundColor: colors.border,
    },
    progressFill: {
      height: '100%',
      backgroundColor: colors.primary,
    },
    progressLabel: {
      color: colors.textSecondary,
      fontSize: 10,
      fontFamily: Fonts.body,
      marginTop: 4,
    },
    dlBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.surfaceSecondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
  }), [colors]);

  const thumbUri = ep.thumbnail || cover;
  const pct = progress != null && progress > 0.02 ? Math.round(progress * 100) : 0;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} style={epS.row}>
      <View style={epS.thumbWrap}>
        <Image source={{ uri: thumbUri }} style={epS.thumb} contentFit="cover" />
        <View style={epS.playOverlay}>
          <PlayIcon size={12} />
        </View>
        {pct > 0 && (
          <View style={epS.progressTrack}>
            <View style={[epS.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
      <View style={epS.info}>
        <Text style={epS.num}>Ep {ep.number}</Text>
        <Text style={epS.title} numberOfLines={2}>{ep.title}</Text>
        {!!ep.description && (
          <Text style={epS.desc} numberOfLines={2}>{ep.description}</Text>
        )}
        {pct > 0 && <Text style={epS.progressLabel}>{pct}% watched</Text>}
        {offline?.status === 'downloading' && (
          <Text style={epS.progressLabel}>Downloading {Math.round(offline.progress * 100)}% · tap to pause</Text>
        )}
        {offline?.status === 'paused' && (
          <Text style={epS.progressLabel}>Paused {Math.round(offline.progress * 100)}% · tap to resume</Text>
        )}
        {offline?.status === 'ready' && (
          <Text style={[epS.progressLabel, { color: '#34C759' }]}>Downloaded</Text>
        )}
        {offline?.status === 'error' && (
          <Text style={[epS.progressLabel, { color: colors.primary }]} numberOfLines={1}>
            {offline.error || 'Download failed'}
          </Text>
        )}
      </View>
      {/*
        On web this depends on the SOURCE, not the platform.

        Sakura Originals are progressive MP4/MOV files served same-origin
        through /api/media-proxy/ with CORS and Range, so a browser can fetch
        them like any other file. Third-party streamed episodes cannot be
        fetched at all: their CDN 403s without a `Referer`, and `Referer` is a
        forbidden request header name, so fetch silently drops it.

        The button stays visible either way and the press path explains the
        refusal, because a control that vanishes teaches the user nothing. It
        is the guard in lib/anime-offline.web.ts that produces the message, so
        the Downloads screen\u2019s retry path is covered too.

        (It previously used to SUCCEED into nothing on web: the filesystem shim
        was localStorage-backed and its downloadAsync ran response.text() over
        binary. That shim now throws.)
      */}
      <TouchableOpacity
        onPress={(e) => {
          e.stopPropagation?.();
          onDownload();
        }}
        style={[epS.dlBtn, !downloadable && { opacity: 0.35 }]}
        hitSlop={8}
        disabled={offline?.status === 'ready'}
        accessibilityLabel={
          downloadable ? 'Download episode' : 'Download unavailable in the browser'
        }
      >
        <DownloadIcon color={colors.text} size={16} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function AnimeDetail() {
  const { wide, W, HERO_H, HEADER_TRIGGER } = useDetailMetrics();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();

  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    stickyHeader: {
      position: 'absolute',
      top: 0, left: 0, right: 0,
      zIndex: 40,
      overflow: 'hidden',
    },
    stickyHeaderFill: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: -12,
    },
    floatNav: {
      position: 'absolute',
      left: 0,
      right: 0,
      zIndex: 30,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
    },
    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      paddingVertical: 9,
    },
    navTitle: {
      flex: 1,
      color: colors.text,
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyBold,
      textAlign: 'center',
      marginHorizontal: 8,
    },
    navBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: 'rgba(0,0,0,0.40)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    navBtnSaved: { backgroundColor: colors.primary },
    backBtnAbsolute: {
      width: 42, height: 42, borderRadius: 21,
      backgroundColor: colors.surface,
      alignItems: 'center', justifyContent: 'center',
    },
    heroWrap: { width: W, height: HERO_H, overflow: 'hidden' },
    heroImg: { width: '100%', height: '100%' },
    heroGrad: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '62%' },
    content: { marginTop: -50, paddingHorizontal: Spacing.md, backgroundColor: colors.background },
    badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 7 },
    typeBadge: {
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    typeBadgeText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    yearText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.body },
    title: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '800',
      lineHeight: 30,
      letterSpacing: 0.2,
      marginBottom: 8,
    },
    ratingRow: {
      flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 9,
    },
    rating: { color: colors.gold, fontSize: FontSize.sm, fontFamily: Fonts.bodyBold },
    ratingMax: { color: colors.textSecondary, fontSize: FontSize.xs },
    ratingDivider: { width: 1, height: 10, backgroundColor: colors.border, marginHorizontal: 3 },
    episodeCount: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    genreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 12 },
    genreChip: {
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 8, paddingVertical: 3,
      backgroundColor: colors.surface,
    },
    genreChipText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    synopsis: {
      color: colors.textSecondary, fontSize: 13.5, lineHeight: 20, marginBottom: 4,
    },
    seeMore: {
      color: colors.primary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium, marginBottom: 16,
    },
    tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 14, marginTop: 4 },
    tab: { flex: 1, paddingVertical: 9, alignItems: 'center' },
    tabActive: { borderBottomWidth: 2, borderBottomColor: colors.primary, marginBottom: -1 },
    tabText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium },
    tabTextActive: { color: colors.text, fontFamily: Fonts.bodyBold, fontSize: FontSize.sm },
    noEps: {
      padding: 20,
      backgroundColor: `${colors.primary}10`,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: `${colors.primary}24`,
      alignItems: 'center',
      gap: 6,
    },
    noEpsTitle: { color: colors.text, fontSize: FontSize.sm, fontFamily: Fonts.bodyBold },
    noEpsText: { color: colors.textSecondary, fontSize: FontSize.xs, fontFamily: Fonts.body, textAlign: 'center', lineHeight: 18 },
    infoTab: { gap: 14 },
    infoRow: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 12, gap: 3 },
    infoLabel: { color: colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium, textTransform: 'uppercase', letterSpacing: 0.5 },
    infoValue: { color: colors.text, fontSize: FontSize.sm, fontFamily: Fonts.body },
    cta: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 15,
      overflow: 'hidden',
      // Centre and cap it on desktop. Stretched edge to edge across a 1920px
      // window the button reads as a site-wide banner rather than an action
      // belonging to this title.
      ...(wide
        ? { alignSelf: 'center', width: '100%', maxWidth: MAX_CONTENT_WIDTH, left: undefined, right: undefined }
        : null),
    },
    saveBtn: {
      width: 46, height: 46,
      borderRadius: 23,
      backgroundColor: colors.surfaceSecondary,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    saveBtnActive: { backgroundColor: `${colors.primary}18`, borderColor: `${colors.primary}45` },
  }), [colors, wide, W, HERO_H]);

  const [anime, setAnime] = useState<AnimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Why the load failed, shown to the user rather than discarded.
   *
   * The catch below used to swallow the error and do nothing. That is the reason
   * "Could not load anime" outlived three attempts to fix it: a rate limit, a
   * network failure and a genuinely missing title all produced the same blank
   * page, so every fix was a guess about which one it was.
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by "Try again" to re-run the load effect. */
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'episodes' | 'info' | 'authors'>('episodes');
  const originalAuthor = id ? getSakuraOriginalAuthor(String(id)) : null;
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState('');
  const [watchProgress, setWatchProgress] = useState<AnimeWatchProgress | null>(null);
  const [offlineMap, setOfflineMap] = useState<Record<string, OfflineEpisode>>({});

  const scrollY = useSharedValue(0);

  const refreshOffline = React.useCallback(async () => {
    if (!id || !anime?.episodes.length) return;
    const entries = await Promise.all(
      anime.episodes.map(async (ep) => {
        const row = await getOfflineEpisode(String(id), ep.id);
        return [ep.id, row] as const;
      }),
    );
    const map: Record<string, OfflineEpisode> = {};
    for (const [epId, row] of entries) {
      if (row) map[epId] = row;
    }
    setOfflineMap(map);
  }, [id, anime?.episodes]);

  useFocusEffect(
    React.useCallback(() => {
      if (!id) return;
      getAnimeWatchProgress(String(id)).then(setWatchProgress);
      refreshOffline();
    }, [id, refreshOffline]),
  );

  useEffect(() => {
    return subscribeWatchProgress(() => {
      if (!id) return;
      getAnimeWatchProgress(String(id)).then(setWatchProgress);
    });
  }, [id]);

  useEffect(() => {
    const unsubscribe = subscribeOfflineEpisodes(() => {
      refreshOffline();
    });
    return () => {
      unsubscribe();
    };
  }, [refreshOffline]);

  useEffect(() => {
    if (anime?.episodes.length) refreshOffline();
  }, [anime?.episodes.length, refreshOffline]);

  useEffect(() => {
    if (!id) return;
    setLoadError(null);
    (async () => {
      try {
        let data = await fetchAnimeInfo(id);
        if (data && data.episodes.length === 0) {
          // Retry uncached in case the empty episode list came from a stale or
          // half-built cache entry — but never let the retry destroy a result
          // we already have. It used to assign straight over `data`, so when
          // the second call failed (Jikan 504s persistently on /episodes, which
          // only currently-airing shows ever reach) a perfectly good page
          // turned into "Could not load anime".
          const retried = await fetchAnimeInfo(id, { force: true }).catch(() => null);
          if (retried && retried.episodes.length > 0) data = retried;
        }
        if (data) {
          setAnime(data);
        } else {
          // Not a throw: the fetch completed and had nothing for this id.
          setLoadError('No data returned for this title.');
        }
      } catch (err) {
        // Deliberately NOT swallowed.
        //
        // This used to swallow the error entirely, which is why "Could not load
        // anime" survived three separate attempts to fix it: every one was a
        // guess, because the code threw away the only evidence of what actually
        // went wrong. Rate limits, network failures, and a genuinely missing
        // title all rendered the identical dead page.
        //
        // Now the reason reaches the screen. Whatever the cause turns out to be,
        // the next report will name it instead of requiring another theory.
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    Library.isSaved(String(id), 'anime').then(setSaved);
  }, [id, reloadKey]);

  const handleSave = async () => {
    if (!anime) return;
    playTap();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = await Library.toggle({
      id: String(id),
      title: anime.title,
      cover: anime.cover || anime.image || '',
      type: 'anime',
      savedAt: 0,
    });
    setSaved(next);
    setToast(next ? 'Added to library' : 'Removed from library');
  };

  const handleShare = () => {
    if (!anime) return;
    playTap();
    shareContentLink(`Watch "${anime.title}" on Sakura!`, `/anime/${encodeURIComponent(String(id))}`);
  };

  const scrollHandler = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });

  const heroStyle = useAnimatedStyle(() => ({
    transform: [{
      translateY: interpolate(scrollY.value, [0, HERO_H], [0, -HERO_H * 0.22], Extrapolation.CLAMP),
    }],
  }));

  const headerOpacity = useAnimatedStyle(() => ({
    opacity: withTiming(
      interpolate(
        scrollY.value,
        [HEADER_TRIGGER, HEADER_TRIGGER + HEADER_FADE_DISTANCE],
        [0, 1],
        Extrapolation.CLAMP,
      ),
      { duration: 80 },
    ),
  }));

  const floatNavOpacity = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [HEADER_TRIGGER, HEADER_TRIGGER + HEADER_FADE_DISTANCE],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  if (loading) return <DetailSkeleton onBack={onTap(() => router.back())} />;

  if (!anime) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '700' }}>Could not load anime</Text>
        {loadError ? (
          <Text
            selectable
            style={{
              color: colors.textSecondary,
              fontSize: FontSize.sm,
              textAlign: 'center',
              paddingHorizontal: Spacing.xl,
            }}
          >
            {loadError}
          </Text>
        ) : null}
        <TouchableOpacity
          onPress={onTap(() => {
            setLoading(true);
            setLoadError(null);
            setReloadKey((k) => k + 1);
          })}
          style={{
            marginTop: 4,
            paddingHorizontal: 20,
            paddingVertical: 10,
            borderRadius: Radius.full,
            backgroundColor: colors.surfaceSecondary,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.text, fontWeight: '700' }}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onTap(() => router.back())} style={s.backBtnAbsolute}>
          <BackIcon />
        </TouchableOpacity>
      </View>
    );
  }

  const episodes = anime.episodes || [];
  const firstEp = episodes[0];
  const resumeEp =
    watchProgress?.episodeId
      ? episodes.find((e) => e.id === watchProgress.episodeId) ?? null
      : null;
  const playEp = resumeEp || firstEp;
  const watchPct = watchProgress?.progress ?? 0;
  const continueWatching =
    !!resumeEp && watchPct < 0.98 && (watchPct >= 0.01 || watchPct === 0);
  const upNextEpisode = continueWatching && watchPct === 0;
  const offlineResume =
    resumeEp && offlineMap[resumeEp.id]?.status === 'ready' ? resumeEp : null;
  const isAiring = (anime.status || '').toLowerCase().includes('air');

  const handleDownloadEpisode = async (ep: AnimeEpisode) => {
    if (!anime || !id) return;
    playTap();
    const existing = offlineMap[ep.id];
    if (existing?.status === 'ready') {
      setToast('Already downloaded');
      return;
    }
    if (existing?.status === 'downloading') {
      pauseAnimeEpisodeDownload(String(id), ep.id);
      setToast('Download paused');
      return;
    }
    if (existing?.status === 'paused') {
      resumeAnimeEpisodeDownload(String(id), ep.id);
      setToast('Resuming download… keep Sakura open on Wi‑Fi');
      try {
        await downloadAnimeEpisode({
          animeId: String(id),
          episodeId: ep.id,
          episodeNumber: ep.number,
          episodeTitle: ep.title,
          title: anime.title,
          cover: anime.cover || anime.image || '',
          episodeThumbnail: ep.thumbnail,
        });
        setToast('Episode downloaded');
      } catch (e) {
        setToast(e instanceof Error ? e.message : 'Download failed');
      }
      return;
    }
    setToast('Starting download… keep Sakura open on Wi‑Fi');
    try {
      await downloadAnimeEpisode({
        animeId: String(id),
        episodeId: ep.id,
        episodeNumber: ep.number,
        episodeTitle: ep.title,
        title: anime.title,
        cover: anime.cover || anime.image || '',
        episodeThumbnail: ep.thumbnail,
      });
      setToast('Episode downloaded');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Download failed');
    }
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />

      {/* Sticky blurred header (visible after scrolling) */}
      <View style={[s.stickyHeader, { paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View style={[s.stickyHeaderFill, headerOpacity]} pointerEvents="none">
          <BlurView intensity={90} tint={colors.blurTint} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={s.navRow}>
          <TouchableOpacity onPress={onTap(() => router.back())} style={s.navBtn} activeOpacity={0.85}>
            <BackIcon />
          </TouchableOpacity>
          <Animated.Text style={[s.navTitle, headerOpacity]} numberOfLines={1}>
            {anime.title}
          </Animated.Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <TouchableOpacity onPress={handleShare} style={s.navBtn} activeOpacity={0.85}>
              <ShareIcon />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSave} style={[s.navBtn, saved && s.navBtnSaved]} activeOpacity={0.85}>
              <BookmarkIcon saved={saved} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Floating nav over hero banner (fades out on scroll) */}
      <Animated.View
        style={[s.floatNav, { top: insets.top + 8 }, floatNavOpacity]}
        pointerEvents="box-none"
      >
        <TouchableOpacity onPress={onTap(() => router.back())} style={s.navBtn} activeOpacity={0.85}>
          <BackIcon />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <TouchableOpacity onPress={handleShare} style={s.navBtn} activeOpacity={0.85}>
            <ShareIcon />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSave} style={[s.navBtn, saved && s.navBtnSaved]} activeOpacity={0.85}>
            <BookmarkIcon saved={saved} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <Animated.View style={[s.heroWrap, heroStyle]}>
          <Image
            source={anime.localCover || { uri: anime.cover || anime.image }}
            style={s.heroImg}
            contentFit="cover"
            transition={400}
            placeholder={{ blurhash: 'L02?U100~A~qIURjofWB~qxuRjWB' }}
          />
          <LinearGradient
            colors={['rgba(0,0,0,0.1)', 'transparent', 'rgba(0,0,0,0.35)', colors.background]}
            locations={[0, 0.32, 0.72, 1]}
            style={s.heroGrad}
          />
        </Animated.View>

        {/* Content */}
        <View style={s.content}>

          {/* Type + status badges */}
          <Animated.View entering={FadeInDown.delay(40).duration(300)} style={s.badgeRow}>
            {anime.type && (
              <View style={s.typeBadge}>
                <Text style={s.typeBadgeText}>{anime.type}</Text>
              </View>
            )}
            {anime.status && (
              <View style={[s.typeBadge, { borderColor: isAiring ? '#34C75940' : colors.border }]}>
                <Text style={[s.typeBadgeText, { color: isAiring ? '#34C759' : colors.textSecondary }]}>
                  {anime.status}
                </Text>
              </View>
            )}
            {anime.year && <Text style={s.yearText}>{anime.year}</Text>}
          </Animated.View>

          {/* Title */}
          <Animated.Text entering={FadeInDown.delay(75).duration(320)} style={s.title}>
            {anime.title}
          </Animated.Text>

          {/* Rating + episode count */}
          {anime.score != null && (
            <Animated.View entering={FadeInDown.delay(105).duration(300)} style={s.ratingRow}>
              <StarIcon goldColor={colors.gold} />
              <Text style={s.rating}>{anime.score}</Text>
              <Text style={s.ratingMax}>/10</Text>
              <View style={s.ratingDivider} />
              <Text style={s.episodeCount}>{episodes.length} eps</Text>
            </Animated.View>
          )}

          {/* Genre chips */}
          {!!anime.genres?.length && (
            <Animated.View entering={FadeInDown.delay(130).duration(300)} style={s.genreRow}>
              {anime.genres.slice(0, 6).map((g) => (
                <View key={g} style={s.genreChip}>
                  <Text style={s.genreChipText}>{g}</Text>
                </View>
              ))}
            </Animated.View>
          )}

          {/* Synopsis */}
          {!!anime.description && (
            <Animated.View entering={FadeInDown.delay(155).duration(320)}>
              <Text style={s.synopsis} numberOfLines={expanded ? undefined : 3}>
                {anime.description}
              </Text>
              <TouchableOpacity onPress={() => setExpanded(!expanded)} activeOpacity={0.7}>
                <Text style={s.seeMore}>{expanded ? 'Show less' : 'More'}</Text>
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* Tabs */}
          <View style={s.tabs}>
            {(
              [
                'episodes',
                'info',
                ...(originalAuthor ? (['authors'] as const) : []),
              ] as const
            ).map((tab) => (
              <TouchableOpacity
                key={tab}
                onPress={() => { playTap(); setActiveTab(tab); }}
                style={[s.tab, activeTab === tab && s.tabActive]}
              >
                <Text style={[s.tabText, activeTab === tab && s.tabTextActive]}>
                  {tab === 'episodes' ? 'Episodes' : tab === 'info' ? 'Info' : 'Authors'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Episodes tab */}
          {activeTab === 'episodes' && (
            <Animated.View entering={FadeInDown.delay(50).duration(300)}>
              {episodes.length === 0 ? (
                <View style={s.noEps}>
                  <Text style={s.noEpsTitle}>No streaming source found</Text>
                  <Text style={s.noEpsText}>
                    {anime.episodeLoadError || 'Try again later — sometimes the provider is slow.'}
                  </Text>
                </View>
              ) : (
                episodes.map((ep, i) => (
                  <Animated.View key={ep.id} entering={FadeInDown.delay(i < 8 ? i * 35 : 0).duration(280)}>
                    <EpisodeRow
                      // Native can fetch anything; on web only Sakura
                      // Originals are reachable, because everything else is
                      // a third-party HLS stream behind a Referer check.
                      downloadable={Platform.OS !== 'web' || isSakuraOriginal(String(id))}
                      ep={ep}
                      cover={anime.localCover ? undefined : (anime.cover || anime.image)}
                      progress={watchProgress?.episodeId === ep.id ? watchProgress.progress : undefined}
                      offline={offlineMap[ep.id]}
                      onPress={() => {
                        playTap();
                        const off = offlineMap[ep.id];
                        router.push({
                          pathname: '/anime/watch',
                          params: {
                            id,
                            ep: ep.id,
                            ...(off?.status === 'ready' ? { offline: '1' } : {}),
                          },
                        });
                      }}
                      onDownload={() => handleDownloadEpisode(ep)}
                    />
                  </Animated.View>
                ))
              )}
            </Animated.View>
          )}

          {/* Info tab */}
          {activeTab === 'info' && (
            <Animated.View entering={FadeInDown.delay(50).duration(300)} style={s.infoTab}>
              {[
                { label: 'Status', value: anime.status },
                { label: 'Type', value: anime.type },
                { label: 'Year', value: anime.year ? String(anime.year) : null },
                { label: 'Episodes', value: episodes.length > 0 ? String(episodes.length) : null },
                { label: 'Score', value: anime.score ? `${anime.score} / 10` : null },
                { label: 'Genres', value: anime.genres?.join(', ') },
              ].map(({ label, value }) =>
                value ? (
                  <View key={label} style={s.infoRow}>
                    <Text style={s.infoLabel}>{label}</Text>
                    <Text style={s.infoValue}>{value}</Text>
                  </View>
                ) : null,
              )}
            </Animated.View>
          )}

          {/* Authors tab — Sakura Originals only */}
          {activeTab === 'authors' && originalAuthor && (
            <CreatorTab
              creatorWallet={originalAuthor.wallet}
              displayName={originalAuthor.name}
              avatarImage={originalAuthor.avatarImage}
              tipLabel="Donate"
              showPass={false}
            />
          )}

          <CommentsSection contentId={`anime:${id}`} title="Discussion" />

          <View style={{ height: 120 }} />
        </View>
      </Animated.ScrollView>

      {/* Sticky CTA */}
      {playEp && (
        <View style={[s.cta, { paddingBottom: insets.bottom + 10 }]}>
          <BlurView intensity={90} tint={colors.blurTint} style={StyleSheet.absoluteFill} />
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 12, paddingHorizontal: Spacing.md, flexDirection: 'row', gap: 8 }}>
            <GlowButton
              fullWidth
              label={
                upNextEpisode
                  ? `Next · Ep ${playEp.number}`
                  : continueWatching
                    ? `Continue Ep ${playEp.number}`
                    : offlineResume
                      ? `Play Offline · Ep ${offlineResume.number}`
                      : episodes.length > 0
                        ? 'Start Watching'
                        : 'No Stream Available'
              }
              onPress={() => {
                if (!playEp) return;
                playTap();
                const off = offlineMap[playEp.id];
                router.push({
                  pathname: '/anime/watch',
                  params: {
                    id,
                    ep: playEp.id,
                    ...(off?.status === 'ready' ? { offline: '1' } : {}),
                  },
                });
              }}
            />
            <TouchableOpacity onPress={handleSave} style={[s.saveBtn, saved && s.saveBtnActive]}>
              <BookmarkIcon saved={saved} color={saved ? colors.primary : colors.text} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      <Toast message={toast} visible={!!toast} onHide={() => setToast('')} bottomOffset={insets.bottom + 80} />
    </View>
  );
}
