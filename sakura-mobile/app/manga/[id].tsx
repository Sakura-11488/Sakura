import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { Dimensions } from 'react-native';
import {
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
  TouchableOpacity,
  StatusBar,
  Platform,
  FlatList,
  Alert,
  ScrollView,
  type ListRenderItemInfo,
} from 'react-native';
import { Image } from 'expo-image';
import CoverImage from '@/components/ui/CoverImage';
import MangaDetailWeb from '@/components/discovery/MangaDetailWeb';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  withRepeat,
  withTiming,
  withSequence,
  withSpring,
  interpolate,
  Extrapolation,
  Easing,
} from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Path, Polygon } from 'react-native-svg';
import * as Haptics from 'expo-haptics';

import { Toast } from '@/components/ui/Toast';
import { Radius, FontSize, FontWeight, Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { shareContentLink } from '@/lib/share-link';
import { Library } from '@/lib/storage';
import {
  atsuGenreId,
  MangaDetail as MangaData,
  MangaChapter,
  type MangaRelatedTitle,
} from '@/lib/manga';
import { getMangaPreview, loadMangaChapters, loadMangaDetail, runWhenIdle } from '@/lib/manga-prefetch';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { formatReleaseDate } from '@/lib/format-release-date';
import {
  downloadScrapedChapter,
  downloadAllScrapedChapters,
  getScrapedBatchState,
  getScrapedOfflineMap,
  subscribeScrapedOffline,
  subscribeScrapedBatch,
  pauseScrapedBatchDownload,
  pauseScrapedChapterDownload,
  resumeScrapedBatchDownload,
  resumeScrapedChapterDownload,
  type ScrapedSource,
} from '@/lib/scraped-offline';
import {
  downloadMangaChapter,
  downloadAllMangaChapters,
  getOfflineMapForManga,
  getMangaBatchState,
  getOfflineMangaPageUris,
  pauseMangaBatchDownload,
  pauseMangaChapterDownload,
  resumeMangaBatchDownload,
  resumeMangaChapterDownload,
  subscribeOfflineManga,
  subscribeMangaBatch,
  type OfflineMangaChapter,
} from '@/lib/manga-offline';
import {
  getOfflineTitle,
  saveOfflineTitle,
  type OfflineTitleDetail,
  type OfflineTitleSnapshot,
} from '@/lib/offline-titles';
import { fetchOfflineChapterList, prefetchChapterPages } from '@/lib/chapter-pages';
import { warmReaderImage } from '@/components/reader/warm-reader-image';
import { isOnline, useOnline } from '@/lib/use-online';
import { confirmAction } from '@/lib/confirm-alert';
import { useWallet } from '@/lib/wallet/context';
import { checkPassStatus } from '@/lib/wallet/pass';
import { playTap, onTap } from '@/lib/sound';
import {
  getMangaReadProgress,
  subscribeReadingProgress,
  type MangaProgress,
} from '@/lib/reader-progress';
import ResumeReadingHint from '@/components/ui/ResumeReadingHint';
import ContentCard from '@/components/ui/ContentCard';
import { getReadChapterIds, setChaptersRead, subscribeChapterReadState } from '@/lib/chapter-read-state';
import {
  chapterReadPercent,
  chapterTime,
  effectiveReadIds,
  isNewChapter,
  previousChapterIds,
  resolveResume,
  sortChaptersAsc,
} from '@/lib/chapter-progress';
import { noteSeriesChapters, seedReadMarksFromProgress } from '@/lib/library-updates';
import { readStore, writeStore } from '@/lib/kv-store';
import CommentsSection from '@/components/social/CommentsSection';
import { useFocusEffect } from 'expo-router';
import { useFocusedSubscription } from '@/lib/hooks/useFocusedSubscription';
// import CreatorTab from '@/components/ui/CreatorTab';
import { supabase } from '@/lib/supabase';
import { getGatedChapterIds } from '@/lib/pass-gate';
import { contentWidth, isWideWeb, MAX_CONTENT_WIDTH } from '@/constants/layout';

/**
 * Cap on the hero at desktop widths.
 *
 * `W * 0.68` is a phone ratio: on a 1920px window it resolves to a 1306px-tall
 * cover, so the title, the chapter count and the read button all start below
 * the fold and the page opens as a full-screen image with no visible content.
 * The anime detail screen caps at 560 for the same reason.
 */
const DESKTOP_HERO_H = 560;
const HEADER_FADE_DISTANCE = 48;

/**
 * Everything that depends on the window, read reactively.
 *
 * These were module-level `Dimensions.get('window')` constants, evaluated once
 * when the bundle was first required and never again — no listener re-reads
 * them anywhere in the app. The damage was not a slightly stale number: the
 * desktop-vs-phone branch below was decided at bundle-evaluation time, so
 * resizing across the 1000px breakpoint, or loading the tab in a window that
 * was later resized, left the whole page in the wrong layout mode.
 *
 * W is the CONTENT width, not the window width. On desktop web the sidebar is a
 * sibling of this column rather than an overlay, so anything sized off the raw
 * window overflows by exactly SIDEBAR_WIDTH (232px).
 */
/**
 * Height is captured once per mount, NOT tracked live.
 *
 * CHAPTER_LIST_MAX_H becomes an EXPLICIT height on an in-flow FlatList, so
 * anything that moves it relays out the page. Converting this file off a
 * bundle-frozen constant was right for WIDTH — that decided a desktop layout
 * mode — but taking HEIGHT from the live hook went too far: portrait lock
 * freezes width, not height, and react-native-web binds Dimensions to
 * visualViewport and hands out a brand-new object on every event with no
 * equality guard, so consumers re-render even when nothing changed.
 *
 * Reading it in a useState initialiser keeps the per-session correctness the
 * conversion was for, without subscribing an explicit box height to viewport
 * noise.
 */
function useDetailMetrics() {
  const { width: windowW } = useWindowDimensions();
  const [windowH] = useState(() => Dimensions.get('window').height);
  return useMemo(() => {
    const wide = isWideWeb(windowW);
    const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    const HERO_H = wide ? Math.min(W * 0.68, DESKTOP_HERO_H) : W * 0.68;
    return {
      wide,
      W,
      HERO_H,
      HEADER_TRIGGER: Math.round(HERO_H * 0.35),
      CHAPTER_LIST_MAX_H: Math.min(windowH * 0.42, 400),
    };
  }, [windowW, windowH]);
}
const CHAPTER_ITEM_H = 64;

type ChapterSort = 'oldest' | 'newest';
type ChapterFilter = 'all' | 'unread' | 'downloaded';

/**
 * The chapter order you last chose, per source. It used to reset to "Oldest
 * first" on every visit, so a reader on chapter 280 of 281 who prefers the
 * newest at the top had to flip it each time.
 */
const SORT_STORE = 'sakura_chapter_sort.json';
let sortPrefs: Record<string, ChapterSort> | null = null;
async function loadSortPref(source: string): Promise<ChapterSort | null> {
  if (!sortPrefs) {
    try {
      const raw = await readStore(SORT_STORE);
      const parsed = raw ? JSON.parse(raw) : null;
      sortPrefs = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      sortPrefs = {};
    }
  }
  const value = sortPrefs?.[source];
  return value === 'oldest' || value === 'newest' ? value : null;
}
function saveSortPref(source: string, sort: ChapterSort): void {
  sortPrefs = { ...(sortPrefs ?? {}), [source]: sort };
  void writeStore(SORT_STORE, JSON.stringify(sortPrefs));
}

// ─── Download-all sizing ──────────────────────────────────────────────────────
/**
 * Rough bytes per stored page, for the Download-all estimate. Mirrors
 * ESTIMATED_PAGE_BYTES in lib/offline-image-store.web.ts, which a shared
 * screen cannot import (on native that specifier would bundle the web store).
 */
const EST_PAGE_BYTES = 400 * 1024;
/** Pages assumed for a chapter whose source reports no page count. */
const EST_PAGES_PER_CHAPTER = 20;
/**
 * Download all asks first from this many chapters up. Below it the tap is the
 * confirmation; above it, a manhwa can mean hundreds of chapters and gigabytes,
 * which nobody should start by brushing a button.
 */
const CONFIRM_BATCH_FROM = 10;

function approxBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * Free space the browser will give this origin, or null when it won't say
 * (and always on native, whose downloads are not quota-bound the same way).
 */
async function freeWebStorageBytes(): Promise<number | null> {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return null;
  }
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== 'number' || quota <= 0) return null;
    return Math.max(0, quota - (usage ?? 0));
  } catch {
    return null;
  }
}

// ─── Offline copy of a title ──────────────────────────────────────────────────
function sortChapters(list: MangaChapter[]): MangaChapter[] {
  return [...list].sort((a, b) => a.number - b.number);
}

/** What the title snapshot keeps of the page's detail (lib/offline-titles). */
function snapshotDetail(m: MangaData): OfflineTitleDetail {
  return {
    id: m.id,
    title: m.title,
    cover: m.cover,
    description: m.description,
    genres: m.genres,
    status: m.status,
    type: m.type,
    ...(m.rating != null ? { rating: m.rating } : {}),
  };
}

interface OfflineCopy {
  snapshot: OfflineTitleSnapshot | null;
  /** Ready chapters rebuilt from the store, for downloads that predate snapshots. */
  downloadedChapters: MangaChapter[];
  /** Title and cover from any download row, for the same case. */
  row: { title: string; cover: string } | null;
}

/**
 * Everything this device holds for a title, read without the network: the
 * snapshot saved alongside its downloads, plus the download rows themselves.
 * Downloads made before snapshots existed have only the rows, which still
 * carry a title and cover, so they get a page too rather than an error.
 */
async function loadOfflineCopy(scraped: ScrapedSource | null, mangaId: string): Promise<OfflineCopy> {
  const rows: Promise<Record<string, { title: string; cover: string }>> = scraped
    ? getScrapedOfflineMap(scraped, mangaId)
    : getOfflineMapForManga(mangaId);
  const [snapshot, downloadedChapters, map] = await Promise.all([
    getOfflineTitle(scraped ?? 'atsu', mangaId).catch(() => null),
    fetchOfflineChapterList(scraped, mangaId).catch(() => [] as MangaChapter[]),
    rows.catch(() => ({}) as Record<string, { title: string; cover: string }>),
  ]);
  const values = Object.values(map);
  const first = values.find((r) => !!r.title) ?? values[0] ?? null;
  return {
    snapshot,
    downloadedChapters,
    row: first ? { title: first.title || 'Downloaded chapters', cover: first.cover || '' } : null,
  };
}

function detailFromCopy(copy: OfflineCopy, mangaId: string): MangaData | null {
  const d = copy.snapshot?.detail;
  if (d) {
    return {
      id: d.id || mangaId,
      title: d.title,
      cover: d.cover || '',
      description: d.description ?? '',
      genres: Array.isArray(d.genres) ? d.genres : [],
      status: d.status ?? '',
      type: d.type ?? '',
      ...(typeof d.rating === 'number' ? { rating: d.rating } : {}),
    };
  }
  if (copy.row) {
    return { id: mangaId, title: copy.row.title, cover: copy.row.cover, description: '', genres: [], status: '', type: '' };
  }
  return null;
}

/**
 * The snapshot's full list, so the page still shows the whole series, plus any
 * downloaded chapter the snapshot does not list (it was saved before that
 * chapter existed, or the source has since renumbered); without a snapshot,
 * just the downloads.
 */
function chaptersFromCopy(copy: OfflineCopy): MangaChapter[] {
  const listed = copy.snapshot?.chapters ?? [];
  if (!listed.length) return copy.downloadedChapters;
  const ids = new Set(listed.map((c) => c.id));
  const missing = copy.downloadedChapters.filter((c) => !ids.has(c.id));
  return missing.length ? [...listed, ...missing] : listed;
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

const BookmarkIcon = ({ saved }: { saved: boolean }) => (
  <Svg width={19} height={19} viewBox="0 0 24 24" fill={saved ? '#fff' : 'none'}>
    <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
      stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const StarIcon = ({ goldColor }: { goldColor: string }) => (
  <Svg width={11} height={11} viewBox="0 0 24 24">
    <Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill={goldColor} />
  </Svg>
);

const BookIcon = () => (
  <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
    <Path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const LockIcon = ({ color = '#fff', size = 13 }: { color?: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M6 10V8a6 6 0 1 1 12 0v2M5 10h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

const DownloadIcon = ({ color = '#fff', size = 18 }: { color?: string; size?: number }) => (
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

const ChevronIcon = ({ color }: { color: string }) => (
  <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
    <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const SortIcon = ({ color, size = 14 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M4 6h16M8 12h8M10 18h4" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);

// ─── Skeleton loader ──────────────────────────────────────────────────────────
function DetailSkeleton() {
  const { W, HERO_H } = useDetailMetrics();
  const { colors } = useTheme();
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) })
      ),
      -1
    );
  }, []);
  const anim = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const Bar = ({ h, w = '100%' as any, r = 8, mb = 10 }: any) => (
    <Animated.View style={[anim, { height: h, width: w, backgroundColor: colors.border, borderRadius: r, marginBottom: mb }]} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Animated.View style={[{ width: W, height: HERO_H, backgroundColor: colors.surfaceSecondary }, anim]} />
      <View style={{ marginTop: -24, backgroundColor: colors.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14, padding: 18, paddingTop: 22 }}>
        <Bar h={28} mb={8} />
        <Bar h={14} w="50%" mb={16} />
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
          <Bar h={24} w={60} r={12} mb={0} />
          <Bar h={24} w={72} r={12} mb={0} />
          <Bar h={24} w={52} r={12} mb={0} />
        </View>
        <Bar h={13} mb={7} />
        <Bar h={13} mb={7} />
        <Bar h={13} w="65%" mb={22} />
        <Bar h={46} r={24} mb={26} />
        <Bar h={18} w="40%" mb={12} />
        <Bar h={54} r={10} mb={8} />
        <Bar h={54} r={10} mb={8} />
        <Bar h={54} r={10} mb={0} />
      </View>
    </View>
  );
}

// ─── Glow CTA ─────────────────────────────────────────────────────────────────
function GlowButton({
  label,
  onPress,
  flex,
}: {
  label: string;
  onPress: () => void;
  flex?: boolean;
}) {
  const scale = useSharedValue(1);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = async () => {
    scale.value = withSequence(withSpring(0.96, { damping: 14 }), withSpring(1, { damping: 12 }));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <View style={[gb.glow, flex && gb.flex, flex && gb.shrink, gb.wrap]}>
      <Animated.View style={[scaleStyle, flex && gb.flex, flex && gb.shrink]}>
        <TouchableOpacity onPress={handlePress} activeOpacity={1} style={[gb.btn, flex && gb.flex]}>
          <View style={gb.iconWrap}>
            <BookIcon />
          </View>
          <Text style={gb.label} numberOfLines={1} ellipsizeMode="tail">
            {label}
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const ChapterRow = memo(function ChapterRow({
  ch,
  mangaId,
  offline,
  onDownload,
  isResume,
  onOpen,
  onMenu,
  hideDownload,
  offlineOnly,
  unavailableReason,
  locked,
  read,
  readPercent,
  isNew,
}: {
  ch: MangaChapter;
  mangaId: string;
  offline?: OfflineMangaChapter | null;
  onDownload: (ch: MangaChapter) => void;
  isResume?: boolean;
  onOpen: (ch: MangaChapter, resume: boolean) => void;
  /** Long press: mark read / unread / previous as read. Absent where marks are not kept (18+). */
  onMenu?: (ch: MangaChapter) => void;
  hideDownload?: boolean;
  /** No network: only a thumbnail already on the device may be shown. */
  offlineOnly?: boolean;
  /** Why this row cannot be opened right now; dims it and replaces the status line. */
  unavailableReason?: string;
  locked?: boolean;
  /** Finished: dimmed, with a check in the number tile. */
  read?: boolean;
  /** The part-read chapter: how far in, 1–100. */
  readPercent?: number | null;
  /** Released in the last week. */
  isNew?: boolean;
}) {
  const { colors } = useTheme();
  const [thumbUri, setThumbUri] = useState<string | null>(
    offlineOnly ? null : (ch.coverUrl ?? null),
  );

  // "NEW · 12 pages · Jul 18, 2026", or whichever parts exist. Page count and
  // date are both optional: some sources report no page count until a
  // chapter is opened, and synthesised and offline-rebuilt lists carry no
  // date. One line on purpose — see the note on the row height below.
  const metaLine = [
    readPercent ? `${readPercent}% read` : read ? 'Read' : '',
    ch.pageCount > 0 ? `${ch.pageCount} pages` : '',
    formatReleaseDate(ch.createdAt),
  ]
    .filter(Boolean)
    .join(' · ');

  // No network here, ever. Rows used to fill their thumbnail by asking atsu
  // for the chapter's page list and then loading its whole first page
  // (100–250 KB) — 12+ API calls and 1–3 MB on every series open, more as
  // the list scrolled — for a 40 px picture of a speech bubble. A thumbnail
  // the list already carries (ch.coverUrl) or a downloaded first page on the
  // device is still shown; everything else gets its number.
  useEffect(() => {
    let cancelled = false;
    if (ch.coverUrl && !offlineOnly) {
      setThumbUri(ch.coverUrl);
      return;
    }
    setThumbUri(null);
    if (offline?.status !== 'ready') return;
    void getOfflineMangaPageUris(mangaId, ch.id)
      .then((local) => { if (!cancelled && local?.[0]) setThumbUri(local[0]); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mangaId, ch.id, ch.coverUrl, offline?.status, offlineOnly]);

  const ch_s = useMemo(() => StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      height: CHAPTER_ITEM_H - 6,
      backgroundColor: colors.surfaceSecondary,
      borderRadius: Radius.sm,
      paddingHorizontal: 10,
      paddingVertical: 9,
      gap: 10,
    },
    thumb: {
      width: 40,
      height: 52,
      borderRadius: 6,
      backgroundColor: colors.surfaceTertiary,
    },
    thumbFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    thumbFallbackNum: {
      fontFamily: Fonts.display,
      fontWeight: FontWeight.heavy,
      fontSize: 11,
      color: colors.primary,
    },
    thumbCheck: {
      position: 'absolute',
      right: 3,
      bottom: 3,
      fontSize: 10,
      fontWeight: FontWeight.heavy,
      color: colors.success,
    },
    info: { flex: 1, minWidth: 0 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    title: {
      flexShrink: 1,
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: colors.text,
      marginBottom: 1,
    },
    newPill: {
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: 4,
      backgroundColor: colors.primary,
    },
    newPillText: { fontSize: 8, fontWeight: FontWeight.heavy, color: '#fff', letterSpacing: 0.4 },
    sub: {
      fontSize: 10,
      color: colors.textTertiary,
    },
    subProgress: { color: colors.primary, fontWeight: FontWeight.semibold },
    dlLabel: {
      fontSize: 10,
      color: colors.primary,
      marginTop: 2,
    },
    unavailableLabel: {
      fontSize: 10,
      color: colors.textSecondary,
      marginTop: 2,
    },
    dimmed: { opacity: 0.45 },
    readDim: { opacity: 0.55 },
    dlBtn: {
      padding: 6,
      marginLeft: 4,
    },
    resumeBadge: {
      marginTop: 3,
      alignSelf: 'flex-start',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: `${colors.primary}18`,
    },
    resumeBadgeText: {
      fontSize: 9,
      fontWeight: FontWeight.bold,
      color: colors.primary,
    },
    passPill: {
      marginTop: 3,
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: '#5856D622',
    },
    passPillText: {
      fontSize: 9,
      fontWeight: FontWeight.bold,
      color: '#7B79E8',
      letterSpacing: 0.3,
    },
  }), [colors]);

  const numberLabel = Number.isFinite(ch.number) ? String(ch.number) : '';
  const a11yState = readPercent ? `, ${readPercent}% read` : read ? ', read' : isNew ? ', new' : '';

  return (
    <TouchableOpacity
      onPress={() => onOpen(ch, !!isResume)}
      onLongPress={onMenu ? () => onMenu(ch) : undefined}
      delayLongPress={350}
      activeOpacity={0.85}
      accessibilityLabel={`${ch.title}${a11yState}`}
      accessibilityHint={unavailableReason ?? (onMenu ? 'Long press for read options' : undefined)}
      style={[
        ch_s.row,
        isResume && { borderWidth: 1, borderColor: `${colors.primary}55` },
        !!unavailableReason && ch_s.dimmed,
      ]}
    >
      <View style={read && !unavailableReason ? ch_s.readDim : undefined}>
        {thumbUri ? (
          <Image
            source={{ uri: thumbUri }}
            style={ch_s.thumb}
            contentFit="cover"
            transition={200}
            recyclingKey={`${mangaId}-${ch.id}`}
          />
        ) : (
          <View style={[ch_s.thumb, ch_s.thumbFallback]}>
            <Text style={ch_s.thumbFallbackNum} numberOfLines={1}>{numberLabel}</Text>
          </View>
        )}
        {read ? <Text style={ch_s.thumbCheck}>✓</Text> : null}
      </View>
      <View style={[ch_s.info, read && !unavailableReason && !isResume ? ch_s.readDim : null]}>
        <View style={ch_s.titleRow}>
          <Text style={ch_s.title} numberOfLines={1}>{ch.title}</Text>
          {isNew && !read ? (
            <View style={ch_s.newPill}><Text style={ch_s.newPillText}>NEW</Text></View>
          ) : null}
        </View>
        {/* One line, not two: the row height is fixed by CHAPTER_ITEM_H, which
            also feeds getItemLayout, so a third line would clip and
            desynchronise scroll offsets. */}
        {!!metaLine && <Text style={[ch_s.sub, readPercent ? ch_s.subProgress : null]} numberOfLines={1}>{metaLine}</Text>}
        {/* The status line. "tap to pause" used to follow these, but tapping
            the row opens the reader; only the download icon pauses. */}
        {unavailableReason ? (
          <Text style={ch_s.unavailableLabel} numberOfLines={1}>{unavailableReason}</Text>
        ) : (
          <>
            {offline?.status === 'downloading' && (
              <Text style={ch_s.dlLabel}>Downloading {Math.round(offline.progress * 100)}%</Text>
            )}
            {offline?.status === 'paused' && (
              <Text style={ch_s.dlLabel}>Paused at {Math.round(offline.progress * 100)}%</Text>
            )}
            {offline?.status === 'error' && (
              <Text style={[ch_s.dlLabel, { color: colors.red }]} numberOfLines={1}>Download failed · tap ↓ to retry</Text>
            )}
            {offline?.status === 'ready' && <Text style={[ch_s.dlLabel, { color: '#34C759' }]}>Downloaded</Text>}
          </>
        )}
        {isResume && !offline?.status && (
          <View style={ch_s.resumeBadge}>
            <Text style={ch_s.resumeBadgeText}>{readPercent ? 'Continue here' : 'Up next'}</Text>
          </View>
        )}
        {locked && (
          <View style={ch_s.passPill}>
            <LockIcon color="#7B79E8" size={10} />
            <Text style={ch_s.passPillText}>PASS</Text>
          </View>
        )}
      </View>
      {locked && <LockIcon color={colors.textTertiary} size={15} />}
      {!hideDownload && (
        <TouchableOpacity
          onPress={(e) => {
            e.stopPropagation?.();
            onDownload(ch);
          }}
          style={ch_s.dlBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${offline?.status === 'downloading' ? 'Pause download of' : offline?.status === 'paused' ? 'Resume download of' : offline?.status === 'error' ? 'Retry download of' : 'Download'} ${ch.title}`}
          disabled={offline?.status === 'ready'}
        >
          <DownloadIcon color={colors.primary} size={16} />
        </TouchableOpacity>
      )}
      <ChevronIcon color={colors.textTertiary} />
    </TouchableOpacity>
  );
});

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MangaDetail() {
  const { wide, W, HERO_H, HEADER_TRIGGER, CHAPTER_LIST_MAX_H } = useDetailMetrics();
  const { id, source } = useLocalSearchParams<{ id: string; source?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const mangaId = String(id || '');
  // Droplet-scraped sources reuse this screen with their own download store
  // (lib/scraped-offline) and skip the atsu-only features: pass-gating and
  // chapter-thumbnail fetches. `adapter` is null for ordinary atsu manga.
  const adapter = getScrapedAdapter(source);
  const isExternal = adapter !== null;
  // Distinct from isExternal: gates the surfaces an adult read must not touch
  // (library, history, lock-screen activity). Manhwa is scraped but SFW.
  const isAdult = adapter?.adult === true;
  const online = useOnline();
  const { address } = useWallet();

  const [manga, setManga] = useState<MangaData | null>(null);
  const [chapters, setChapters] = useState<MangaChapter[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * Each half of the page is still on its way. The live detail and chapter
   * list are drawn as each arrives rather than when both have (the page used
   * to wait for the slower of two ~660 ms proxy calls), so each half has its
   * own skeleton.
   */
  const [detailLoading, setDetailLoading] = useState(true);
  const [chaptersLoading, setChaptersLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [chaptersError, setChaptersError] = useState('');
  const [reloadAttempt, setReloadAttempt] = useState(0);
  /**
   * The page is showing what this device holds (the title snapshot and the
   * downloads) rather than a live load — because the browser is offline, or
   * because the source failed while downloads exist. Distinct from `online`:
   * connectivity can come back while this copy is still on screen.
   */
  const [offlineMode, setOfflineMode] = useState(false);
  /**
   * A live load is still out. The downloaded copy is read from the device, so
   * it usually shows before the live answer, and without this the notice said
   * "Couldn't reach this title's source" on every visit to a downloaded title
   * until the live page swapped in a moment later. Only once the live load
   * has actually settled does the copy mean the source failed.
   */
  const [liveChecking, setLiveChecking] = useState(false);
  /** Same-origin cover stored with the snapshot (web only). */
  const [offlineCoverUri, setOfflineCoverUri] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState('');
  const [toastDuration, setToastDuration] = useState<number | undefined>(undefined);

  const [offlineMap, setOfflineMap] = useState<Record<string, OfflineMangaChapter>>({});
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [batchPaused, setBatchPaused] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [mangaProgress, setMangaProgress] = useState<MangaProgress | null>(null);
  const [chapterSort, setChapterSortState] = useState<ChapterSort>('oldest');
  const [chapterFilter, setChapterFilter] = useState<ChapterFilter>('all');
  /**
   * Chapters marked read (lib/chapter-read-state). Never for 18+ titles: the
   * store refuses them, and the page shows no read state there at all.
   */
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Only checked while some chapter is pass-gated; see lib/pass-gate.ts. */
  const [passValid, setPassValid] = useState(false);
  // const [activeTab, setActiveTab] = useState<'chapters' | 'author'>('chapters');
  // const [creatorWallet, setCreatorWallet] = useState<string | null>(null);

  /**
   * What the card that opened this page already showed: title and cover,
   * from lib/manga-prefetch. Drawn in the first frame, before any request
   * returns, and only while the live load is out — a title that then fails
   * to load says so rather than keeping a preview of nothing.
   */
  const preview = useMemo(() => getMangaPreview(mangaId, adapter?.key ?? null), [mangaId, adapter]);
  const shownManga = useMemo<MangaData | null>(() => manga ?? (loading && preview
    ? { id: mangaId, title: preview.title, cover: preview.cover, description: '', genres: [], status: '', type: '' }
    : null), [manga, loading, preview, mangaId]);
  /** Only the title's own details are missing (the hero is a preview). */
  const detailPending = detailLoading && !manga;
  /** The chapter list has not arrived and nothing has failed yet. */
  const chaptersPending = chaptersLoading && chapters.length === 0 && !chaptersError;

  const backScale = useSharedValue(1);
  const scrollY = useSharedValue(0);
  /**
   * Set before bumping reloadAttempt to refetch WITHOUT clearing the page:
   * used when connectivity returns while the downloaded copy is on screen, so
   * the reader keeps their place and the live page swaps in only if it loads.
   */
  const silentReloadRef = useRef(false);

  useEffect(() => {
    if (!mangaId) { setLoading(false); setDetailLoading(false); setChaptersLoading(false); return; }
    let active = true;
    const silent = silentReloadRef.current;
    silentReloadRef.current = false;
    if (!silent) {
      setLoading(true);
      setDetailLoading(true);
      setChaptersLoading(true);
      setLoadError('');
      setChaptersError('');
      setManga(null);
      setChapters([]);
      setOfflineMode(false);
      setOfflineCoverUri(null);
    }
    const scraped = adapter?.key ?? null;
    const savedFetch = isAdult ? Promise.resolve(false) : Library.isSaved(mangaId, 'manga');
    const noteSaved = (isSaved: boolean) => {
      setSaved(isSaved);
      // Library items saved before `source` was stored reopen as atsu; this
      // visit knows better, so record it.
      if (isSaved && adapter) void Library.setSource(mangaId, 'manga', adapter.key).catch(() => {});
    };
    /** null keeps that half as it is: a live half already on screen. */
    const showOfflineCopy = (copy: OfflineCopy, detail: MangaData | null, list: MangaChapter[] | null) => {
      if (detail) setManga(detail);
      if (list) setChapters(sortChapters(list));
      setOfflineCoverUri(copy.snapshot?.coverUri ?? null);
      setOfflineMode(true);
      setLoadError('');
      setChaptersError('');
    };

    // Known offline: render what the device holds straight away. Waiting on
    // the network first only adds a skeleton that ends in an error — and on a
    // bad connection supabase.functions.invoke has no timeout at all.
    if (!isOnline()) {
      setLiveChecking(false);
      Promise.all([loadOfflineCopy(scraped, mangaId), savedFetch.catch(() => false)]).then(([copy, isSaved]) => {
        if (!active) return;
        noteSaved(isSaved);
        const detail = detailFromCopy(copy, mangaId);
        if (detail) showOfflineCopy(copy, detail, chaptersFromCopy(copy));
        else if (!silent) {
          setLoadError("You're offline, and this title isn't downloaded on this device. Reconnect and try again.");
        }
        setLoading(false);
        setDetailLoading(false);
        setChaptersLoading(false);
      });
      return () => { active = false; };
    }

    // navigator.onLine can stay true while a source or connection hangs.
    // Show the saved title immediately, then replace it only with a live result.
    let liveLoadFinished = false;
    // The halves of the live answer already on screen (see detailLoading).
    // The downloaded copy, which usually resolves first, must not replace one
    // that happens to come back before it.
    let liveDetailShown = false;
    let liveChaptersShown = false;
    const offlineCopy = loadOfflineCopy(scraped, mangaId);
    void offlineCopy.then((copy) => {
      if (!active || liveLoadFinished) return;
      const detail = detailFromCopy(copy, mangaId);
      if (!detail) return;
      const copyChapters = chaptersFromCopy(copy);
      showOfflineCopy(
        copy,
        liveDetailShown ? null : detail,
        liveChaptersShown ? null : copyChapters,
      );
      setLoading(false);
      setDetailLoading(false);
      if (liveChaptersShown || copyChapters.length) setChaptersLoading(false);
    });
    // Through lib/manga-prefetch, so a prefetch started by hovering or
    // pressing the card is joined rather than repeated. A Retry asks afresh.
    const fresh = reloadAttempt > 0;
    const detailFetch = loadMangaDetail(mangaId, scraped, { fresh });
    const chaptersFetch = loadMangaChapters(mangaId, scraped, { fresh });
    // Each half shows as soon as it arrives. Not on a silent reload: that
    // refetch replaces the downloaded copy on screen only once BOTH halves
    // have loaded, below.
    if (!silent) {
      detailFetch.then((detail) => {
        if (!active || liveLoadFinished || !detail) return;
        liveDetailShown = true;
        setManga(detail);
        setDetailLoading(false);
      }, () => {});
      chaptersFetch.then((list) => {
        if (!active || liveLoadFinished || !list?.length) return;
        liveChaptersShown = true;
        setChapters(sortChapters(list));
        setChaptersLoading(false);
      }, () => {});
    }
    setLiveChecking(true);
    Promise.allSettled([detailFetch, chaptersFetch, savedFetch]).then(async ([detail, chapterResult, savedResult]) => {
      liveLoadFinished = true;
      // A superseded load leaves the flag to the run that replaced it.
      if (!active) return;
      setLiveChecking(false);
      setDetailLoading(false);
      setChaptersLoading(false);
      noteSaved(savedResult.status === 'fulfilled' && savedResult.value);
      // The fetchers report failure as a rejection or as null/[], so both
      // count as "did not load" here — and below, where nothing on the
      // device covers it, both are shown as errors.
      const liveDetail = detail.status === 'fulfilled' ? detail.value : null;
      const liveChapters = chapterResult.status === 'fulfilled' ? chapterResult.value : [];

      if (liveDetail && liveChapters.length > 0) {
        setManga(liveDetail);
        if (!liveChaptersShown) setChapters(sortChapters(liveChapters));
        setOfflineMode(false);
        setOfflineCoverUri(null);
        setLoadError('');
        setChaptersError('');
        setLoading(false);
        return;
      }

      // Part of the page did not load. Before reporting that, use what the
      // device holds: a title with downloads must never land on "Could not
      // load this title" — that was the whole of the offline experience,
      // including the reader's Back button, once the API cache had expired.
      const copy = await offlineCopy;
      if (!active) return;
      const deviceDetail = liveDetail ? null : detailFromCopy(copy, mangaId);
      const deviceChapters = liveChapters.length ? [] : chaptersFromCopy(copy);
      const shownDetail = liveDetail ?? deviceDetail;
      if (shownDetail && (deviceDetail || deviceChapters.length)) {
        showOfflineCopy(copy, shownDetail, liveChapters.length ? liveChapters : deviceChapters);
        // A Retry (or reconnect) that changed nothing visible still deserves
        // an answer.
        if (silent) setToast("Still can't reach this title's source");
        setLoading(false);
        return;
      }
      // A refetch after reconnecting found nothing better; keep what is shown.
      if (silent) return;

      // Nothing on the device either: report what did not load. Comics is
      // the one loader that still REJECTS when its request fails, and that
      // is worded as the source being down, with Browse comics as a way out.
      const comicsDown = adapter?.key === 'comics'
        ? 'This comic source is temporarily unavailable. Try again later or choose another comic from Browse.'
        : null;
      setManga(liveDetail);
      if (detail.status === 'rejected') {
        setLoadError(comicsDown ?? 'Could not load this title. Please try again.');
      }
      setChapters(sortChapters(liveChapters));
      // An EMPTY list is an error too, not just a rejection. The chapter
      // loaders resolve [] when the source fails (they catch outside the
      // cache so the failure is never cached), so waiting for 'rejected' meant
      // a failed list rendered as "No chapters yet" with no Retry, on every
      // source. A failed source and a title with nothing in it look the same
      // from here; offering a retry costs the second case nothing. Retry
      // chapters is a full reload, which really asks the source again: the
      // loaders throw on an empty answer INSIDE getOrSetCached, so no empty
      // list is stored for the retry to be served from.
      if (liveChapters.length === 0) {
        setChaptersError(chapterResult.status === 'rejected' && comicsDown
          ? comicsDown
          : 'Could not load chapters. Please try again.');
      }
      setOfflineMode(false);
      setLoading(false);
    });
    return () => { active = false; };
  }, [mangaId, adapter, isAdult, reloadAttempt]);

  // Connectivity came back while the downloaded copy is on screen: refetch in
  // place, so new chapters, comments and downloads come back without a reload.
  const wasOnlineRef = useRef(online);
  useEffect(() => {
    const was = wasOnlineRef.current;
    wasOnlineRef.current = online;
    if (online && !was && offlineMode) {
      silentReloadRef.current = true;
      setReloadAttempt((value) => value + 1);
    }
  }, [online, offlineMode]);

  const retryLive = useCallback(() => {
    silentReloadRef.current = true;
    setReloadAttempt((value) => value + 1);
  }, []);

  const offlineRequestRef = useRef(0);
  const refreshOffline = useCallback(() => {
    if (!mangaId) return;
    const request = ++offlineRequestRef.current;
    const lookup = adapter
      ? getScrapedOfflineMap(adapter.key, mangaId)
      : getOfflineMapForManga(mangaId);
    void lookup.then((map) => {
      if (request === offlineRequestRef.current) setOfflineMap(map);
    }, () => {});
  }, [mangaId, adapter]);

  useEffect(() => {
    setOfflineMap({});
    if (!mangaId) return;
    refreshOffline();
    const unsubscribe = adapter ? subscribeScrapedOffline(refreshOffline) : subscribeOfflineManga(refreshOffline);
    return () => {
      offlineRequestRef.current++;
      unsubscribe();
    };
  }, [mangaId, adapter, refreshOffline]);

  /** The running or paused Download all for this title, from whichever store owns it. */
  const getBatchState = useCallback(
    () => (adapter ? getScrapedBatchState(adapter.key, mangaId) : getMangaBatchState(mangaId)),
    [adapter, mangaId],
  );

  // Batch progress lives in the store, not here, so leaving the page and
  // coming back shows the same Pause/Resume. Scraped sources used to return
  // early from this effect: only atsu had a Download all, and on web not even
  // that.
  useEffect(() => {
    if (!mangaId) return;
    const refreshBatch = () => {
      const state = getBatchState();
      setBatchPaused(!!state?.paused);
      setBatchProgress(state ? { done: state.done, total: state.total } : null);
      if (state && !state.paused && state.done < state.total) {
        setBulkDownloading(true);
      } else if (!state?.paused) {
        setBulkDownloading(false);
      }
    };
    refreshBatch();
    const unsubscribe = adapter ? subscribeScrapedBatch(refreshBatch) : subscribeMangaBatch(refreshBatch);
    return () => { unsubscribe(); };
  }, [mangaId, adapter, getBatchState]);

  const loadMangaProgress = useCallback(() => {
    if (!mangaId) return;
    getMangaReadProgress(mangaId).then(setMangaProgress);
  }, [mangaId]);

  // Listening only while this page is focused: the reader opened from it
  // saves progress on every page turn, and each save used to re-render this
  // whole page underneath it. Focus reloads it (including the first focus).
  useFocusedSubscription(subscribeReadingProgress, loadMangaProgress);
  useFocusEffect(
    useCallback(() => {
      loadMangaProgress();
    }, [loadMangaProgress]),
  );

  /** The read-marks store's key for this series: the route's source, 'manga' for atsu. */
  const readSource = adapter?.key ?? 'manga';
  const tracksRead = !isAdult;
  const loadReadIds = useCallback(() => {
    if (!mangaId || !tracksRead) { setReadIds(new Set()); return; }
    void getReadChapterIds(readSource, mangaId).then(setReadIds, () => {});
  }, [mangaId, readSource, tracksRead]);
  // Same focus rule as progress: the reader marks chapters while this page
  // sits underneath it, and the focus reload picks them up on return.
  useFocusedSubscription(subscribeChapterReadState, loadReadIds);
  useFocusEffect(
    useCallback(() => {
      loadReadIds();
    }, [loadReadIds]),
  );

  // The order you last chose for this source. Not for 18+: a saved
  // preference under that source's name would itself be a trace of it.
  useEffect(() => {
    if (isAdult) return;
    let cancelled = false;
    void loadSortPref(readSource).then((pref) => { if (!cancelled && pref) setChapterSortState(pref); });
    return () => { cancelled = true; };
  }, [readSource, isAdult]);
  const toggleChapterSort = useCallback(() => {
    setChapterSortState((prev) => {
      const next = prev === 'oldest' ? 'newest' : 'oldest';
      if (!isAdult) saveSortPref(readSource, next);
      return next;
    });
  }, [readSource, isAdult]);

  // Latest chapters of an ongoing series sit behind the monthly pass. Comics
  // are never gated (separate catalogue, no editorial ongoing signal).
  const gatedChapterIds = useMemo(
    () => (isExternal ? new Set<string>() : getGatedChapterIds(manga?.status, chapters)),
    [isExternal, manga?.status, chapters],
  );

  // Whether this wallet may download gated chapters. Only asked while some
  // chapter is gated — which, with AUTO_GATE_LATEST_CHAPTERS off, is never —
  // so the page makes no pass check at all in the normal case.
  const needsPass = gatedChapterIds.size > 0;
  useEffect(() => {
    if (!needsPass || !address) {
      setPassValid(false);
      return;
    }
    let cancelled = false;
    setPassValid(false);
    checkPassStatus(address)
      .then((status) => { if (!cancelled) setPassValid(status.valid); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [needsPass, address]);

  /** May this chapter be downloaded? Locked rows need a valid pass. */
  const canDownload = useCallback(
    (chapterId: string) => !gatedChapterIds.has(chapterId) || passValid,
    [gatedChapterIds, passValid],
  );

  /**
   * Keep this title's offline snapshot (lib/offline-titles) current: the
   * detail, the full chapter list and the cover, which is what lets the page
   * render with no network at all. Saved when a download starts (`force`) and
   * on any live visit to a title that already has downloads, so chapters
   * released since the first download show up offline too.
   *
   * Never from the offline copy itself — rewriting a snapshot with its own
   * contents gains nothing, and a copy rebuilt from download rows alone would
   * replace a full chapter list with just the downloaded ones.
   */
  const lastSnapshotRef = useRef<MangaData | null>(null);
  const rememberTitle = useCallback((force: boolean) => {
    if (!manga || offlineMode || chapters.length === 0) return;
    if (!force && lastSnapshotRef.current === manga) return;
    lastSnapshotRef.current = manga;
    void saveOfflineTitle({
      source: adapter?.key ?? 'atsu',
      contentId: mangaId,
      detail: snapshotDetail(manga),
      chapters,
    });
  }, [manga, offlineMode, chapters, adapter, mangaId]);

  const hasDownloads = useMemo(() => Object.keys(offlineMap).length > 0, [offlineMap]);
  useEffect(() => {
    if (hasDownloads) rememberTitle(false);
  }, [hasDownloads, rememberTitle]);

  const openMangaChapter = useCallback((ch: MangaChapter, resume = false) => {
    if (!shownManga) return;
    const off = offlineMap[ch.id];
    const downloaded = off?.status === 'ready';
    if (!online && !downloaded) {
      setToast("This chapter isn't downloaded. Reconnect to read it.");
      return;
    }
    router.push({
      pathname: '/chapter/[id]',
      params: {
        id: `${mangaId}~${ch.id}`,
        title: shownManga.title,
        cover: (shownManga as { image?: string }).image || shownManga.cover || '',
        chapter: ch.title,
        ...(isExternal ? { source } : {}),
        // A downloaded chapter opens without the pass check. Downloading it
        // already required access (the button is hidden on locked rows
        // without a pass), and the check needs the network — the one thing a
        // download exists to do without. Downloads and the reader follow the
        // same rule.
        ...(gatedChapterIds.has(ch.id) && !downloaded ? { gated: '1' } : {}),
        // Resume wherever you stopped IN THIS chapter, however you opened it.
        // Previously `p` was only sent from the Continue button, so tapping the
        // chapter you were halfway through restarted it from page 1.
        ...(mangaProgress && mangaProgress.chapterId === ch.id && mangaProgress.page > 1
          ? { p: String(mangaProgress.page) }
          : {}),
        ...(downloaded ? { offline: '1' } : {}),
      },
    });
  }, [shownManga, mangaId, offlineMap, mangaProgress, router, isExternal, source, gatedChapterIds, online]);

  const handleDownloadChapter = useCallback(async (ch: MangaChapter) => {
    if (!shownManga) return;
    playTap();
    // Every source downloads on web and native alike, through stores that
    // export the native module's exact surface: lib/scraped-offline.web.ts for
    // scraped sources, lib/manga-offline.web.ts for atsu. Both keep pages in
    // Cache Storage under same-origin URLs the service worker serves, so the
    // reader loads them through the same `<Image source={{ uri }}>` and cannot
    // tell the difference.
    //
    // atsu's button used to be hidden on web: cdn.atsu.moe sends no CORS
    // header, so the browser could never read the bytes. Its pages now come
    // through the same-origin /api/manga-page/ proxy instead.
    const existing = offlineMap[ch.id];
    if (existing?.status === 'ready') {
      setToast('Chapter already downloaded');
      return;
    }
    const cover = (shownManga as { image?: string }).image || shownManga.cover || '';
    // Scraped sources persist through the scraped-offline store; atsu manga
    // through manga-offline. Both expose the same status shape so the row UI is
    // shared.
    const scrapedSource: ScrapedSource | null = adapter?.key ?? null;

    if (existing?.status === 'downloading') {
      if (scrapedSource) pauseScrapedChapterDownload(scrapedSource, mangaId, ch.id);
      else pauseMangaChapterDownload(mangaId, ch.id);
      setToast('Download paused');
      return;
    }

    // The button is hidden in both cases; these guard a stale tap.
    if (!online) {
      setToast("You're offline. Reconnect to download.");
      return;
    }
    if (!canDownload(ch.id)) {
      setToast('This chapter needs a Sakura Pass.');
      return;
    }

    if (existing?.status === 'paused') {
      if (scrapedSource) resumeScrapedChapterDownload(scrapedSource, mangaId, ch.id);
      else resumeMangaChapterDownload(mangaId, ch.id);
      setToast('Resuming download…');
    } else {
      setToast('Downloading chapter…');
    }
    rememberTitle(true);

    try {
      const result = scrapedSource
        ? await downloadScrapedChapter({
            source: scrapedSource,
            contentId: mangaId,
            chapterId: ch.id,
            chapterNumber: ch.number,
            chapterTitle: ch.title,
            title: shownManga.title,
            cover,
          })
        : await downloadMangaChapter({
            mangaId,
            chapterId: ch.id,
            chapterNumber: ch.number,
            chapterTitle: ch.title,
            title: shownManga.title,
            cover,
          });
      setToast(result.paused ? 'Download paused' : 'Chapter downloaded');
      refreshOffline();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Download failed');
      refreshOffline();
    }
  }, [shownManga, mangaId, offlineMap, refreshOffline, adapter, online, canDownload, rememberTitle]);

  /**
   * The chapters of the batch last started from this page. Resume walks the
   * same list again — the stores skip what is already downloaded — so its
   * progress continues from "15/40" rather than restarting at "0/25".
   */
  const batchListRef = useRef<MangaChapter[] | null>(null);
  useEffect(() => { batchListRef.current = null; }, [mangaId, adapter]);

  /** What Download all would fetch: chapters this user may download that aren't downloaded yet. */
  const pendingDownloads = useCallback(
    () => chapters.filter((ch) => canDownload(ch.id) && offlineMap[ch.id]?.status !== 'ready'),
    [chapters, canDownload, offlineMap],
  );

  const runBatchDownload = useCallback(async (list: MangaChapter[]) => {
    if (!shownManga || list.length === 0) return;
    batchListRef.current = list;
    setBulkDownloading(true);
    setToast(
      `Downloading ${list.length} ${list.length === 1 ? 'chapter' : 'chapters'}… ` +
        (Platform.OS === 'web' ? 'keep this tab open' : 'keep the app open'),
    );
    rememberTitle(true);
    const batch = {
      title: shownManga.title,
      cover: (shownManga as { image?: string }).image || shownManga.cover || '',
      chapters: list.map((ch) => ({ id: ch.id, number: ch.number, title: ch.title })),
    };
    try {
      // Sequential in both stores: each chapter already keeps three pages in
      // flight, which is one client's share of the droplet.
      const { ok, failed, paused } = adapter
        ? await downloadAllScrapedChapters({ source: adapter.key, contentId: mangaId, ...batch })
        : await downloadAllMangaChapters({ mangaId, ...batch });
      if (paused) {
        setToast(`Paused · ${ok} of ${list.length} downloaded`);
      } else {
        setToast(failed > 0
          ? `Downloaded ${ok} of ${list.length} · ${failed} failed, tap ↓ on one to retry`
          : `Downloaded ${ok} ${ok === 1 ? 'chapter' : 'chapters'}`);
      }
      refreshOffline();
    } catch (e) {
      // On web a batch stops at an error every later chapter would hit too —
      // out of space, offline — and stays paused, so Resume picks it up. The
      // message says which.
      setToast(e instanceof Error ? e.message : 'Download failed');
      refreshOffline();
    } finally {
      if (!getBatchState()?.paused) {
        setBulkDownloading(false);
      }
    }
  }, [shownManga, mangaId, adapter, refreshOffline, rememberTitle, getBatchState]);

  const handleDownloadAll = async () => {
    if (!shownManga || chapters.length === 0) return;

    if (batchPaused) {
      playTap();
      if (adapter) resumeScrapedBatchDownload(adapter.key, mangaId);
      else resumeMangaBatchDownload(mangaId);
      setBatchPaused(false);
      // Recompute access when resuming: the wallet or its pass may have changed.
      void runBatchDownload((batchListRef.current ?? pendingDownloads()).filter((ch) => canDownload(ch.id)));
      return;
    }

    if (bulkDownloading) {
      playTap();
      if (adapter) pauseScrapedBatchDownload(adapter.key, mangaId);
      else pauseMangaBatchDownload(mangaId);
      // The batch checks its flag between chapters, so the one in flight
      // finishes first; the toast after that says how far it got.
      setToast('Pausing after this chapter…');
      return;
    }

    playTap();
    const list = pendingDownloads();
    if (list.length === 0) {
      setToast(chapters.some((ch) => !canDownload(ch.id))
        ? 'Everything you can download is already downloaded'
        : 'All chapters are already downloaded');
      return;
    }

    // Big batches ask first, with the count and a rough size, and on web with
    // a warning when the browser's quota is clearly too small — the stores
    // stop cleanly when space runs out, but a 2,000-chapter manhwa should not
    // get as far as finding that out by accident.
    const estimate =
      list.reduce((sum, ch) => sum + (ch.pageCount > 0 ? ch.pageCount : EST_PAGES_PER_CHAPTER), 0) *
      EST_PAGE_BYTES;
    const free = await freeWebStorageBytes();
    const short = free !== null && estimate > free;
    if (list.length >= CONFIRM_BATCH_FROM || short) {
      const lines = [`That's roughly ${approxBytes(estimate)}, downloaded one chapter at a time.`];
      if (Platform.OS === 'web') lines.push('Keep this tab open until it finishes. You can pause and resume.');
      if (short && free !== null) {
        lines.push(`Your browser has only about ${approxBytes(free)} free for downloads, so this will likely stop partway.`);
      }
      const proceed = await confirmAction(
        `Download ${list.length} ${list.length === 1 ? 'chapter' : 'chapters'}?`,
        lines.join(' '),
        'Download',
      );
      if (!proceed) return;
    }
    await runBatchDownload(list);
  };

  const handleSave = async () => {
    if (!shownManga) return;
    playTap();
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = await Library.toggle({
      id: mangaId,
      title: shownManga.title,
      cover: shownManga.cover,
      type: 'manga',
      savedAt: 0,
      // So Library reopens it on this source rather than as atsu.
      ...(adapter ? { source: adapter.key } : {}),
    });
    setSaved(next);
    setToast(next ? 'Added to library' : 'Removed from library');
  };

  const handleShare = () => {
    if (!shownManga) return;
    playTap();
    // With the source, or a shared manhwa or comic opens as an atsu title —
    // the same mistake Library used to make.
    shareContentLink(
      `Check out "${shownManga.title}" on Sakura!`,
      `/manga/${encodeURIComponent(String(mangaId))}${adapter ? `?source=${adapter.key}` : ''}`,
    );
  };

  const backAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: backScale.value }] }));
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
  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    stickyHeader: {
      position: 'absolute',
      top: 0, left: 0, right: 0,
      zIndex: 40,
      overflow: 'hidden',
    },
    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
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
    floatNav: {
      position: 'absolute',
      left: 0, right: 0,
      zIndex: 30,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
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

    heroWrap: { width: W, height: HERO_H, backgroundColor: '#181818' },
    heroImg: { width: '100%', height: '100%' },
    heroGrad: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '80%' },
    heroContent: {
      position: 'absolute',
      bottom: 26,
      left: 16,
      right: 16,
    },
    heroTitle: {
      fontFamily: Fonts.display,
      fontWeight: FontWeight.heavy,
      fontSize: 24,
      color: '#fff',
      letterSpacing: 0.1,
      marginBottom: 7,
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 5,
    },
    heroMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    heroMetaTxt: { color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: FontWeight.medium },
    heroMetaSep: { color: 'rgba(255,255,255,0.38)', fontSize: 12 },

    card: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      marginTop: -24,
      paddingTop: 20,
      paddingHorizontal: 16,
      // Cap and centre the body on desktop for the same reason as the CTA: a
      // synopsis and a chapter list run edge to edge across a 1920px window are
      // unreadable line lengths, and the page stops looking like a page.
      ...(wide
        ? { alignSelf: 'center', width: '100%', maxWidth: MAX_CONTENT_WIDTH }
        : null),
    },

    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginBottom: 12,
      flexWrap: 'wrap',
    },
    metaPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.surfaceSecondary,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: Radius.full,
    },
    metaRating: {
      fontSize: 12,
      fontWeight: FontWeight.bold,
      color: colors.gold,
    },
    metaRatingSub: {
      fontSize: 10,
      color: colors.textTertiary,
    },
    metaTxt: {
      fontSize: 11,
      color: colors.textSecondary,
      fontWeight: FontWeight.medium,
    },

    genreRow: {
      flexDirection: 'row',
      gap: 5,
      flexWrap: 'wrap',
      marginBottom: 14,
    },
    genreChip: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    genreChipText: {
      fontSize: FontSize.xs,
      fontWeight: FontWeight.medium,
      color: colors.textSecondary,
    },

    synWrap: { marginBottom: 18 },
    syn: {
      fontSize: 13.5,
      color: colors.textSecondary,
      lineHeight: 20,
      fontFamily: Fonts.body,
    },
    seeMore: {
      color: colors.primary,
      fontWeight: FontWeight.semibold,
      fontSize: 12,
      marginTop: 4,
    },

    bottomBar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: Spacing.md,
      paddingTop: 10,
      backgroundColor: colors.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      gap: 8,
      // Centre and cap on desktop. Stretched edge to edge across a 1920px
      // window the button reads as a site-wide banner rather than an action
      // belonging to this title. Matches app/anime/[id].tsx.
      ...(wide
        ? { alignSelf: 'center', width: '100%', maxWidth: MAX_CONTENT_WIDTH, left: undefined, right: undefined }
        : null),
    },
    bottomCtaRow: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: 10,
    },
    dlOutlineBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 13,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.primary,
      backgroundColor: colors.surface,
    },
    dlOutlineText: {
      color: colors.primary,
      fontSize: FontSize.sm,
      fontWeight: FontWeight.bold,
    },

    tabRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: Spacing.md,
      marginBottom: 16,
      marginTop: 4,
    },
    tabBtn: {
      paddingHorizontal: 18,
      paddingVertical: 8,
      borderRadius: Radius.full,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: 1,
      borderColor: colors.border,
    },
    tabBtnActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    tabBtnText: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyMedium,
      color: colors.textSecondary,
    },
    tabBtnTextActive: {
      color: '#fff',
      fontFamily: Fonts.bodyBold,
    },

    chaptersSection: {
      marginBottom: 8,
    },
    secHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
    },
    secTitle: {
      fontFamily: Fonts.display,
      fontWeight: FontWeight.heavy,
      fontSize: 17,
      color: colors.text,
    },
    countBadge: {
      backgroundColor: `${colors.primary}14`,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: Radius.full,
    },
    countTxt: {
      color: colors.primary,
      fontSize: 11,
      fontWeight: FontWeight.bold,
    },
    sortLink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    sortLinkText: {
      fontSize: 12,
      fontWeight: FontWeight.semibold,
      color: colors.primary,
    },
    latestLine: {
      fontSize: 11.5,
      color: colors.textSecondary,
      marginTop: -4,
      marginBottom: 10,
    },
    filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    filterChip: {
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    filterChipText: { fontSize: 11.5, fontWeight: FontWeight.semibold, color: colors.textSecondary },
    filterChipTextActive: { color: '#fff' },
    emptyFilter: { fontSize: 12.5, color: colors.textSecondary, paddingVertical: 14 },
    credits: { fontSize: 12.5, color: colors.textSecondary, marginBottom: 12, lineHeight: 18 },
    creditsName: { color: colors.text, fontWeight: FontWeight.semibold },
    altTitles: { fontSize: 11.5, color: colors.textTertiary, lineHeight: 17, marginTop: 6 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
    tagChip: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: Radius.full,
      backgroundColor: colors.surfaceSecondary,
    },
    tagChipText: { fontSize: 10.5, color: colors.textSecondary },
    railSection: { marginTop: 6, marginBottom: 18, marginHorizontal: -16 },
    railTitle: {
      fontFamily: Fonts.display,
      fontWeight: FontWeight.heavy,
      fontSize: 17,
      color: colors.text,
      paddingHorizontal: 16,
      marginBottom: 10,
    },
    railList: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
    relationLabel: {
      fontSize: 10,
      fontWeight: FontWeight.bold,
      color: colors.primary,
      marginTop: 4,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    chaptersListBox: {
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceSecondary,
      overflow: 'hidden',
    },

    offlineNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 14,
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceSecondary,
    },
    offlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.warning },
    offlineText: { flex: 1, fontSize: 12.5, lineHeight: 17, color: colors.text },
    offlineAction: { fontSize: 12.5, fontWeight: FontWeight.bold, color: colors.primary },
  }), [colors, wide, W, HERO_H]);

  const chaptersAsc = useMemo(() => sortChaptersAsc(chapters), [chapters]);
  /** Marks plus what the progress row says was finished (lib/chapter-progress). */
  const readSet = useMemo(
    () => (tracksRead ? effectiveReadIds(chaptersAsc, readIds, mangaProgress) : new Set<string>()),
    [tracksRead, chaptersAsc, readIds, mangaProgress],
  );
  /**
   * Where Start / Continue opens: the part-read chapter, else the next unread
   * one after the last read, else (all read) the newest. Finishing a chapter
   * used to turn this back into "Start Reading" at chapter 0.
   */
  const resume = useMemo(
    () => resolveResume(chaptersAsc, readSet, tracksRead ? mangaProgress : null),
    [chaptersAsc, readSet, tracksRead, mangaProgress],
  );
  const unreadCount = useMemo(
    () => (tracksRead ? chaptersAsc.reduce((n, c) => n + (readSet.has(c.id) ? 0 : 1), 0) : 0),
    [tracksRead, chaptersAsc, readSet],
  );
  const downloadedCount = useMemo(
    () => chaptersAsc.reduce((n, c) => n + (offlineMap[c.id]?.status === 'ready' ? 1 : 0), 0),
    [chaptersAsc, offlineMap],
  );
  // A filter whose chips are gone (no downloads left) must not leave an empty list.
  const activeFilter: ChapterFilter =
    chapterFilter === 'downloaded' && downloadedCount === 0 ? 'all' :
    chapterFilter === 'unread' && !tracksRead ? 'all' : chapterFilter;
  const displayedChapters = useMemo(() => {
    const filtered = activeFilter === 'unread'
      ? chaptersAsc.filter((c) => !readSet.has(c.id))
      : activeFilter === 'downloaded'
        ? chaptersAsc.filter((c) => offlineMap[c.id]?.status === 'ready')
        : chaptersAsc;
    return chapterSort === 'oldest' ? filtered : [...filtered].reverse();
  }, [chaptersAsc, chapterSort, activeFilter, readSet, offlineMap]);
  const firstChapter = chaptersAsc[0] ?? null;
  const chapterListHeight = Math.min(
    Math.max(1, displayedChapters.length) * CHAPTER_ITEM_H,
    CHAPTER_LIST_MAX_H,
  );
  /** A chapter is part-read: Continue, with its page. */
  const canContinueManga = resume.kind === 'continue';
  /** The chapter Continue / Up next points at, highlighted in the list and the target of Jump to current. */
  const resumeChapter = resume.kind === 'continue' || resume.kind === 'next' ? resume.chapter : null;
  const resumeChapterId = resumeChapter?.id ?? null;

  // With no network, a chapter is only worth showing as openable if it is
  // downloaded; the rest stay listed, dimmed, so the series still reads as a
  // whole. Downloading needs the network too, so those buttons go.
  const restrictToDownloads = !online;
  // The cover stored with the snapshot whenever the page is not live — the
  // remote one would not load, or (on a failed source) likely not either.
  const displayCover = offlineCoverUri && (offlineMode || !online) ? offlineCoverUri : shownManga?.cover;

  /**
   * Mark chapters read or unread, showing the change at once. The store
   * notifies subscribers (this page included) once it has written.
   */
  const markChapters = useCallback((ids: string[], read: boolean, message?: string) => {
    if (!tracksRead || !mangaId || ids.length === 0) return;
    setReadIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (read) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    void setChaptersRead(readSource, mangaId, ids, read).catch(() => loadReadIds());
    if (message) setToast(message);
  }, [tracksRead, mangaId, readSource, loadReadIds]);

  const markChapterRead = useCallback((ch: MangaChapter, read: boolean) => {
    markChapters([ch.id], read, read ? 'Marked as read' : 'Marked as unread');
  }, [markChapters]);

  const markPreviousRead = useCallback((ch: MangaChapter) => {
    const ids = previousChapterIds(chaptersAsc, ch.id);
    if (!ids.length) {
      setToast('No earlier chapters');
      return;
    }
    markChapters(ids, true, `Marked ${ids.length} earlier ${ids.length === 1 ? 'chapter' : 'chapters'} as read`);
  }, [chaptersAsc, markChapters]);

  /** Native: long-press a row. Web has its own row menu (MangaDetailWeb). */
  const openChapterMenu = useCallback((ch: MangaChapter) => {
    const isRead = readSet.has(ch.id);
    const hasPrevious = previousChapterIds(chaptersAsc, ch.id).length > 0;
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(ch.title || `Chapter ${ch.number}`, undefined, [
      { text: isRead ? 'Mark as unread' : 'Mark as read', onPress: () => markChapterRead(ch, !isRead) },
      ...(hasPrevious ? [{ text: 'Mark previous as read', onPress: () => markPreviousRead(ch) }] : []),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }, [readSet, chaptersAsc, markChapterRead, markPreviousRead]);

  // History from before per-chapter marks existed becomes marks once (see
  // seedReadMarksFromProgress), and a saved series hands the library its
  // fresh list — which also clears its NEW badge, since opening the series is
  // how you see what is new. Live lists only: the downloaded copy may be old.
  useEffect(() => {
    if (!tracksRead || !mangaId || offlineMode || chaptersAsc.length === 0) return;
    let cancelled = false;
    void (async () => {
      if (mangaProgress) await seedReadMarksFromProgress(readSource, mangaId, chaptersAsc, mangaProgress);
      if (saved && !cancelled) await noteSeriesChapters(readSource, mangaId, chaptersAsc, { seen: true });
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [tracksRead, mangaId, readSource, chaptersAsc, mangaProgress, saved, offlineMode]);

  const renderChapter = useCallback(
    ({ item: ch }: ListRenderItemInfo<MangaChapter>) => {
      const locked = gatedChapterIds.has(ch.id);
      const downloaded = offlineMap[ch.id]?.status === 'ready';
      return (
        <ChapterRow
          ch={ch}
          mangaId={mangaId}
          offline={offlineMap[ch.id]}
          onDownload={handleDownloadChapter}
          onOpen={openMangaChapter}
          onMenu={tracksRead ? openChapterMenu : undefined}
          isResume={ch.id === resumeChapterId}
          // Every source can download on web now (atsu through the
          // /api/manga-page/ proxy). Hidden only where a tap could not work:
          // offline, or a pass-locked chapter without a pass — downloading it
          // would sidestep the gate, since a downloaded chapter opens without
          // a pass check.
          hideDownload={restrictToDownloads || (locked && !passValid)}
          offlineOnly={restrictToDownloads}
          unavailableReason={restrictToDownloads && !downloaded ? 'Not downloaded · needs a connection' : undefined}
          locked={locked}
          read={readSet.has(ch.id)}
          readPercent={tracksRead ? chapterReadPercent(ch, mangaProgress) : null}
          isNew={isNewChapter(ch)}
        />
      );
    },
    [
      mangaId,
      offlineMap,
      handleDownloadChapter,
      openMangaChapter,
      openChapterMenu,
      tracksRead,
      resumeChapterId,
      gatedChapterIds,
      restrictToDownloads,
      passValid,
      readSet,
      mangaProgress,
    ],
  );
  // FlatList only re-renders rows when data or extraData change.
  const chapterListExtra = useMemo(
    () => [offlineMap, restrictToDownloads, passValid, readSet, mangaProgress, resumeChapterId],
    [offlineMap, restrictToDownloads, passValid, readSet, mangaProgress, resumeChapterId],
  );

  /**
   * Bring the chapter you are on into view. The list used to open at
   * chapter 0 whatever you were reading, so someone on chapter 280 of 281
   * scrolled the whole series to get back to it.
   */
  const chapterListRef = useRef<FlatList<MangaChapter>>(null);
  const jumpToCurrent = useCallback((animated = true) => {
    if (!resumeChapterId) return false;
    const index = displayedChapters.findIndex((c) => c.id === resumeChapterId);
    if (index < 0) return false;
    chapterListRef.current?.scrollToIndex({ index, viewPosition: 0.35, animated });
    return true;
  }, [resumeChapterId, displayedChapters]);
  // Once per title, when the list and the reader's place are both known.
  const autoJumpedRef = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS === 'web' || !resumeChapterId || autoJumpedRef.current === mangaId) return;
    const timer = setTimeout(() => {
      if (jumpToCurrent(false)) autoJumpedRef.current = mangaId;
    }, 250);
    return () => clearTimeout(timer);
  }, [resumeChapterId, mangaId, jumpToCurrent]);

  const chapterKeyExtractor = useCallback((ch: MangaChapter) => ch.id, []);

  const getChapterLayout = useCallback(
    (_: ArrayLike<MangaChapter> | null | undefined, index: number) => ({
      length: CHAPTER_ITEM_H,
      offset: CHAPTER_ITEM_H * index,
      index,
    }),
    [],
  );

  /**
   * What Start/Continue opens. Live, that is the resume chapter or the first.
   * From the offline copy it must be a chapter that will actually open: the
   * resume chapter if it is downloaded, else the first downloaded one from
   * there on, else the first downloaded at all. Fully offline with nothing
   * downloaded there is nothing to start, so the button goes; when only the
   * source failed, the live target is still worth a try.
   */
  const playChapter = useMemo(() => {
    const live = resume.chapter || firstChapter;
    if (!offlineMode && !restrictToDownloads) return live;
    const isReady = (c: MangaChapter) => offlineMap[c.id]?.status === 'ready';
    if (live && isReady(live)) return live;
    const ready = chaptersAsc.filter(isReady);
    const next = live ? ready.find((c) => c.number >= live.number) : undefined;
    return next ?? ready[0] ?? (restrictToDownloads ? null : live);
  }, [resume.chapter, firstChapter, offlineMode, restrictToDownloads, offlineMap, chaptersAsc]);
  /**
   * Fetch what Start/Continue opens before it is tapped: the chapter's page
   * list (a ~600 ms proxy call plus its preflight on the live site, which the
   * reader used to wait on before it could even request page 1) and the page
   * it opens on, so the reader starts from memory and the HTTP cache. Tap to
   * first page measured 1.2–1.4 s before this.
   *
   * At idle, after this page's own requests. Never for 18+ titles, for a
   * pass-gated chapter (the reader checks the pass before loading it), or
   * from the downloaded copy; prefetchChapterPages itself skips a chapter
   * that is downloaded, since the reader opens that from disk.
   */
  const playChapterId = playChapter?.id ?? null;
  const playPage = playChapterId && mangaProgress?.chapterId === playChapterId && mangaProgress.page > 1
    ? mangaProgress.page
    : 1;
  const playGated = !!playChapterId && gatedChapterIds.has(playChapterId);
  useEffect(() => {
    if (!playChapterId || isAdult || playGated || !online || offlineMode) return;
    let cancelled = false;
    const idle = runWhenIdle(() => {
      void prefetchChapterPages({ contentId: mangaId, chapterId: playChapterId, source: adapter?.key ?? null })
        .then((urls) => {
          if (cancelled || !urls?.length) return;
          warmReaderImage(urls[Math.min(playPage, urls.length) - 1]);
        });
    }, 1500);
    return () => {
      cancelled = true;
      idle.cancel();
    };
  }, [mangaId, adapter, playChapterId, playPage, isAdult, playGated, online, offlineMode]);

  const playTitle = playChapter ? playChapter.title || `Chapter ${playChapter.number}` : '';
  const playIsResume = !!playChapter && playChapter.id === resume.chapter?.id;
  const playLabel = !playChapter
    ? ''
    : playIsResume && resume.kind === 'continue'
      ? `Continue · ${playTitle}`
      : playIsResume && resume.kind === 'next'
        ? `Up next · ${playTitle}`
        : playIsResume && resume.kind === 'caught-up'
          ? `Caught up · ${playTitle}`
          : firstChapter && playChapter.id !== firstChapter.id
            ? `Read · ${playTitle}`
            : 'Start Reading';
  /** "Chapter 280 · 3d ago · 2 unread": the state of the series at a glance. */
  const latest = chaptersAsc[chaptersAsc.length - 1] ?? null;
  const latestSummary = latest
    ? [
        `Latest: ${latest.title || `Chapter ${latest.number}`}`,
        chapterTime(latest.createdAt) ? formatReleaseDate(latest.createdAt) : '',
        tracksRead && readSet.size > 0 ? (unreadCount > 0 ? `${unreadCount} unread` : 'all read') : '',
      ].filter(Boolean).join(' · ')
    : '';
  const genres = shownManga ? (shownManga.genres.length > 0 ? shownManga.genres : [shownManga.type].filter(Boolean)) : [];
  /** "Story: Chu-Gong · Art: Seong-Rak Jang", or just the names when there is no separate art credit. */
  const credits = useMemo(() => {
    const story = shownManga?.authors ?? [];
    const art = shownManga?.artists ?? [];
    if (!story.length && !art.length) return '';
    if (!art.length) return `By ${story.join(', ')}`;
    return [story.length ? `Story: ${story.join(', ')}` : '', `Art: ${art.join(', ')}`].filter(Boolean).join(' · ');
  }, [shownManga?.authors, shownManga?.artists]);
  const toCard = useCallback((r: MangaRelatedTitle, badge?: string) => ({
    id: r.id,
    title: r.title,
    cover: r.cover,
    type: 'manga' as const,
    ...(badge ? { badge } : {}),
    ...(typeof r.rating === 'number' && r.rating > 0 ? { score: r.rating } : {}),
  }), []);
  // atsu titles only: relations and similar ids are atsu ids.
  const relatedCards = useMemo(
    () => (isExternal ? [] : (shownManga?.related ?? []).map((r) => toCard(r, r.relation?.toUpperCase()))),
    [isExternal, shownManga?.related, toCard],
  );
  const similarCards = useMemo(
    () => (isExternal ? [] : (shownManga?.similar ?? []).map((r) => toCard(r))),
    [isExternal, shownManga?.similar, toCard],
  );

  const statusColor =
    (manga?.status || '').toLowerCase().includes('ongoing') ? colors.success :
    (manga?.status || '').toLowerCase().includes('complet') ? '#3B82F6' :
    colors.textSecondary;

  // Shared by both layouts so they cannot drift. Offline the notice explains
  // the dimmed rows; online it means this is the downloaded copy, with a
  // Retry: while the live load is still out (see liveChecking), and then
  // because the source failed. Retry stays during the check too, since a
  // native request has no timeout and can hang there.
  const offlineNotice = !online
    ? "You're offline — showing your downloaded chapters."
    : !offlineMode
      ? null
      : liveChecking
        ? "Checking this title's source — showing your downloaded chapters."
        : "Couldn't reach this title's source — showing your downloaded chapters.";
  // Download all, for every source: scraped sources used to have no batch
  // download at all (runBatchDownload routes them through scraped-offline).
  // Hidden offline, and on the offline copy of a title whose source just
  // failed, unless a batch is already under way — then it is how you pause it.
  const showBatchDownload = chapters.length > 0 && online && (!offlineMode || bulkDownloading || batchPaused);

  // Web has its own layout but follows the same rules as the native one
  // below. It replaced that layout wholesale, so each of these props carries
  // a native behaviour the web page would otherwise silently lack: the
  // offline / source-failed notice and its Retry, Download all with its
  // Pause / Resume (the web-only "keep this tab open" toast and storage-quota
  // prompt live in handleDownloadAll / runBatchDownload), the dimmed
  // "needs a connection" rows offline, no download button on a pass-locked
  // row without a pass (downloading it would sidestep the gate, since a
  // downloaded chapter opens without a pass check), and the error states'
  // ways out. Also as native: every source downloads (atsu through
  // /api/manga-page/) unless the browser is offline, the cover is the stored
  // snapshot's when the page is not live, Continue only when the play target
  // really is the resume chapter, and the discussion is network-only.
  if (Platform.OS === 'web') {
    const browseComics = { label: 'Browse comics', onPress: () => router.push('/browse') };
    return <MangaDetailWeb
      manga={shownManga && displayCover && displayCover !== shownManga.cover ? { ...shownManga, cover: displayCover } : shownManga}
      loading={loading && !shownManga} error={loadError || ''} chaptersError={chaptersError || ''}
      detailPending={detailPending} chaptersPending={chaptersPending} placeholderCover={preview?.cover}
      chapters={displayedChapters} sort={chapterSort} onSort={toggleChapterSort}
      totalChapters={chapters.length}
      filter={activeFilter} onFilter={setChapterFilter} unreadCount={unreadCount} downloadedCount={downloadedCount}
      readEnabled={tracksRead} readIds={readSet} onMarkRead={markChapterRead} onMarkPrevious={markPreviousRead}
      currentChapterId={resumeChapterId} resumeKind={resume.kind} playLabel={playLabel} latestSummary={latestSummary}
      sourceLabel={adapter?.label ?? 'Manga'} credits={credits} showRelated={!isExternal && online}
      browsableGenre={isExternal ? undefined : (name) => atsuGenreId(name) !== null}
      onBrowseGenre={(name) => { const genre = atsuGenreId(name); if (genre) router.push({ pathname: '/browse', params: { title: name, source: 'manga', genre } } as any); }}
      saved={saved} canSave={!isAdult} onSave={handleSave} onShare={handleShare}
      onBack={() => router.canGoBack() ? router.back() : router.replace('/home')}
      onRetry={() => setReloadAttempt(value => value + 1)} onOpen={openMangaChapter}
      playChapter={playChapter} resume={canContinueManga && !!playChapter && playChapter.id === resumeChapterId} progress={mangaProgress}
      offline={offlineMap} canDownload={!restrictToDownloads} onDownload={handleDownloadChapter} gated={gatedChapterIds}
      canDownloadChapter={canDownload} downloadsOnly={restrictToDownloads}
      notice={offlineNotice ? { text: offlineNotice, ...(online ? { actionLabel: 'Retry', onAction: onTap(retryLive) } : {}) } : undefined}
      batch={showBatchDownload ? {
        state: batchPaused ? 'paused' : bulkDownloading ? 'running' : 'idle',
        progress: batchProgress,
        onPress: () => { void handleDownloadAll(); },
      } : undefined}
      errorLinks={[
        ...(adapter?.key === 'comics' && online ? [browseComics] : []),
        ...(!online ? [{ label: 'Open your downloads', onPress: () => router.push('/downloads') }] : []),
      ]}
      chaptersErrorLinks={adapter?.key === 'comics' ? [browseComics] : []}
      discussion={online ? <CommentsSection contentId={`manga:${mangaId}`} title="Discussion" /> : null}
      feedback={<Toast message={toast} visible={!!toast} onHide={() => { setToast(''); setToastDuration(undefined); }} durationMs={toastDuration} />}
    />;
  }

  // Only when there is nothing at all to draw; a preview (the card's title
  // and cover) or either half of the live answer is drawn straight away.
  if (loading && !shownManga) return <DetailSkeleton />;

  if (!shownManga) {
    return (
      <View style={[s.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
        <TouchableOpacity
          style={[s.navBtn, { position: 'absolute', top: insets.top + 10, left: 16 }]}
          onPress={onTap(() => router.back())}
        >
          <BackIcon />
        </TouchableOpacity>
        <Text style={{ color: colors.textSecondary, fontSize: FontSize.md, textAlign: 'center', paddingHorizontal: 24 }}>
          {loadError || 'Could not load this title. Please try again.'}
        </Text>
        <TouchableOpacity accessibilityRole="button" onPress={() => setReloadAttempt((value) => value + 1)} style={{ padding: 16 }}>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>Try again</Text>
        </TouchableOpacity>
        {adapter?.key === 'comics' && online && (
          <TouchableOpacity accessibilityRole="button" onPress={() => router.push('/browse')} style={{ padding: 12 }}>
            <Text style={{ color: colors.primary }}>Browse comics</Text>
          </TouchableOpacity>
        )}
        {!online && (
          <TouchableOpacity accessibilityRole="button" onPress={() => router.push('/downloads')} style={{ padding: 12 }}>
            <Text style={{ color: colors.primary }}>Open your downloads</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />

      {/* Sticky blurred header */}
      <View style={[s.stickyHeader, { paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View style={[StyleSheet.absoluteFill, headerOpacity]}>
          <BlurView intensity={80} tint={colors.blurTint} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={s.navRow}>
          <TouchableOpacity
            style={s.navBtn}
            onPress={onTap(() => router.back())}
            onPressIn={() => { backScale.value = withSpring(0.85); }}
            onPressOut={() => { backScale.value = withSpring(1); }}
            activeOpacity={1}
          >
            <BackIcon />
          </TouchableOpacity>
          <Animated.Text style={[s.navTitle, headerOpacity]} numberOfLines={1}>
            {shownManga.title}
          </Animated.Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <TouchableOpacity style={s.navBtn} onPress={handleShare} activeOpacity={0.8}>
              <ShareIcon />
            </TouchableOpacity>
            {!isAdult && (
              <TouchableOpacity
                style={[s.navBtn, saved && s.navBtnSaved]}
                onPress={handleSave}
                activeOpacity={1}
              >
                <BookmarkIcon saved={saved} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {/* Floating nav */}
      <Animated.View
        style={[s.floatNav, { top: insets.top + 8 }, floatNavOpacity]}
        pointerEvents="box-none"
      >
        <Animated.View style={backAnimStyle}>
          <TouchableOpacity
            style={s.navBtn}
            onPress={onTap(() => router.back())}
            onPressIn={() => { backScale.value = withSpring(0.85); }}
            onPressOut={() => { backScale.value = withSpring(1); }}
            activeOpacity={1}
          >
            <BackIcon />
          </TouchableOpacity>
        </Animated.View>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <TouchableOpacity style={s.navBtn} onPress={handleShare} activeOpacity={0.8}>
            <ShareIcon />
          </TouchableOpacity>
          {!isAdult && (
            <TouchableOpacity
              style={[s.navBtn, saved && s.navBtnSaved]}
              onPress={handleSave}
              activeOpacity={1}
            >
              <BookmarkIcon saved={saved} />
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>

      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        bounces
      >
        {/* ── Hero ── */}
        <View style={s.heroWrap}>
          <CoverImage
            source={{ uri: displayCover || shownManga.cover }}
            thumbnailWidth={512}
            priority="high"
            style={s.heroImg}
            contentFit="cover"
            transition={400}
            // The card's cover, already in expo-image's cache, until the
            // page's own (larger) cover arrives.
            placeholder={preview?.cover ? { uri: preview.cover } : { blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
            placeholderContentFit="cover"
          />
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0.68)', 'rgba(0,0,0,0.92)']}
            locations={[0.3, 0.52, 0.78, 1]}
            style={s.heroGrad}
          />
          <View style={s.heroContent}>
            <Text style={s.heroTitle} numberOfLines={2}>{shownManga.title}</Text>
            <View style={s.heroMeta}>
              {shownManga.status ? <View style={[s.statusDot, { backgroundColor: statusColor }]} /> : null}
              {shownManga.status ? <Text style={s.heroMetaTxt}>{shownManga.status}</Text> : null}
              {shownManga.status && shownManga.type ? <Text style={s.heroMetaSep}>·</Text> : null}
              {shownManga.type ? <Text style={s.heroMetaTxt}>{shownManga.type}</Text> : null}
            </View>
          </View>
        </View>

        {/* ── Content card ── */}
        <View style={s.card}>

          {/* In flow rather than floating, so it pushes the page down instead
              of covering it. See offlineNotice for what it says when. */}
          {offlineNotice && (
            <View style={s.offlineNotice} accessibilityRole="summary">
              <View style={s.offlineDot} />
              <Text style={s.offlineText}>{offlineNotice}</Text>
              {online ? (
                <TouchableOpacity accessibilityRole="button" onPress={onTap(retryLive)} hitSlop={8}>
                  <Text style={s.offlineAction}>Retry</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}

          {/* Meta pills */}
          <Animated.View entering={FadeInDown.delay(40).duration(300)} style={s.metaRow}>
            {shownManga.rating != null && (
              <View style={s.metaPill}>
                <StarIcon goldColor={colors.gold} />
                <Text style={s.metaRating}>{shownManga.rating.toFixed(1)}</Text>
                <Text style={s.metaRatingSub}>/10</Text>
              </View>
            )}
            {chapters.length > 0 && (
              <View style={s.metaPill}>
                <Text style={[s.metaTxt, { fontSize: 10 }]}>📖</Text>
                <Text style={s.metaTxt}>{chapters.length} ch.</Text>
              </View>
            )}
            {shownManga.views ? (
              <View style={s.metaPill}>
                <Text style={s.metaTxt}>{shownManga.views} views</Text>
              </View>
            ) : null}
            {shownManga.year ? (
              <View style={s.metaPill}>
                <Text style={s.metaTxt}>{shownManga.year}</Text>
              </View>
            ) : null}
          </Animated.View>

          {credits ? <Text style={s.credits} numberOfLines={2}>{credits}</Text> : null}

          {/* Genre chips. atsu genres open that genre's shelf in Browse. */}
          {genres.length > 0 && (
            <Animated.View entering={FadeInDown.delay(70).duration(300)} style={s.genreRow}>
              {genres.slice(0, 7).map((g) => {
                const genreId = !isExternal ? atsuGenreId(g) : null;
                return genreId ? (
                  <TouchableOpacity
                    key={g}
                    style={s.genreChip}
                    accessibilityRole="button"
                    accessibilityLabel={`Browse ${g}`}
                    onPress={() => router.push({ pathname: '/browse', params: { title: g, source: 'manga', genre: genreId } } as any)}
                  >
                    <Text style={s.genreChipText}>{g}</Text>
                  </TouchableOpacity>
                ) : (
                  <View key={g} style={s.genreChip}>
                    <Text style={s.genreChipText}>{g}</Text>
                  </View>
                );
              })}
            </Animated.View>
          )}

          {/* Synopsis */}
          {shownManga.description ? (
            <Animated.View entering={FadeInDown.delay(100).duration(300)} style={s.synWrap}>
              <Text style={s.syn} numberOfLines={expanded ? undefined : 3}>{shownManga.description}</Text>
              {expanded && shownManga.altTitles?.length ? (
                <Text style={s.altTitles}>Also known as: {shownManga.altTitles.join(' · ')}</Text>
              ) : null}
              {expanded && shownManga.tags?.length ? (
                <View style={s.tagRow}>
                  {shownManga.tags.map((tag) => (
                    <View key={tag} style={s.tagChip}><Text style={s.tagChipText}>{tag}</Text></View>
                  ))}
                </View>
              ) : null}
              <TouchableOpacity onPress={() => setExpanded(!expanded)} activeOpacity={0.7}>
                <Text style={s.seeMore}>{expanded ? 'Show less ↑' : 'See more ↓'}</Text>
              </TouchableOpacity>
            </Animated.View>
          ) : null}

          {canContinueManga && mangaProgress && (
            <Animated.View entering={FadeInDown.delay(130).duration(320)} style={{ marginBottom: 14 }}>
              <ResumeReadingHint
                chapterLabel={mangaProgress.chapterLabel}
                detail={`Page ${mangaProgress.page} of ${mangaProgress.totalPages}`}
                progress={mangaProgress.progress}
                colors={colors}
              />
            </Animated.View>
          )}

          {/* Tab switcher */}
          {/* {chapters.length > 0 && (
            <View style={s.tabRow}>
              {(['chapters', ...(creatorWallet ? ['author'] : [])] as const).map((tab) => (
                <TouchableOpacity
                  key={tab}
                  style={[s.tabBtn, activeTab === tab && s.tabBtnActive]}
                  onPress={() => setActiveTab(tab as any)}
                  activeOpacity={0.8}
                >
                  <Text style={[s.tabBtnText, activeTab === tab && s.tabBtnTextActive]}>
                    {tab === 'chapters' ? 'Chapters' : 'Author'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )} */}

          {/* Chapter list */}
          {chaptersError ? (
            <View style={{ paddingVertical: 18, gap: 12 }}>
              <Text accessibilityRole="alert" style={{ color: colors.textSecondary }}>{chaptersError}</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => setReloadAttempt((value) => value + 1)} style={{ paddingVertical: 8 }}>
                <Text style={{ color: colors.primary, fontWeight: '700' }}>Retry chapters</Text>
              </TouchableOpacity>
              {adapter?.key === 'comics' && (
                <TouchableOpacity accessibilityRole="button" onPress={() => router.push('/browse')} style={{ paddingVertical: 8 }}>
                  <Text style={{ color: colors.primary }}>Browse comics</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}
          {/* The list is still on its way while the rest of the page shows. */}
          {chaptersPending && (
            <View style={s.chaptersSection} accessibilityLabel="Loading chapters">
              {[0, 1, 2].map((row) => (
                <View
                  key={row}
                  style={{ height: CHAPTER_ITEM_H - 6, borderRadius: Radius.sm, backgroundColor: colors.surfaceSecondary, marginBottom: 6 }}
                />
              ))}
            </View>
          )}
          {chapters.length > 0 && (
            <View style={s.chaptersSection}>
              <View style={s.secHeader}>
                <Text style={s.secTitle}>Chapters</Text>
                <View style={s.countBadge}>
                  <Text style={s.countTxt}>{chapters.length}</Text>
                </View>
                <View style={{ flex: 1 }} />
                {resumeChapterId ? (
                  <TouchableOpacity
                    style={s.sortLink}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      if (!jumpToCurrent() && activeFilter !== 'all') {
                        setChapterFilter('all');
                        setTimeout(() => jumpToCurrent(), 60);
                      }
                    }}
                  >
                    <Text style={s.sortLinkText}>Jump to current</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={s.sortLink}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Chapter order: ${chapterSort === 'oldest' ? 'oldest first' : 'newest first'}`}
                  onPress={() => {
                    void Haptics.selectionAsync().catch(() => {});
                    toggleChapterSort();
                  }}
                >
                  <SortIcon color={colors.primary} />
                  <Text style={s.sortLinkText}>
                    {chapterSort === 'oldest' ? 'Oldest' : 'Newest'}
                  </Text>
                </TouchableOpacity>
              </View>
              {latestSummary ? <Text style={s.latestLine} numberOfLines={1}>{latestSummary}</Text> : null}
              {(tracksRead || downloadedCount > 0) && (
                <View style={s.filterRow} accessibilityRole="tablist">
                  {([
                    ['all', `All`],
                    ...(tracksRead ? [['unread', `Unread${unreadCount ? ` · ${unreadCount}` : ''}`]] : []),
                    ...(downloadedCount > 0 ? [['downloaded', `Downloaded · ${downloadedCount}`]] : []),
                  ] as [ChapterFilter, string][]).map(([value, label]) => {
                    const active = activeFilter === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: active }}
                        onPress={() => setChapterFilter(value)}
                        style={[s.filterChip, active && s.filterChipActive]}
                        activeOpacity={0.8}
                      >
                        <Text style={[s.filterChipText, active && s.filterChipTextActive]}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              {displayedChapters.length === 0 ? (
                <Text style={s.emptyFilter}>
                  {activeFilter === 'unread' ? "You're all caught up — every chapter is read." : 'No chapters here.'}
                </Text>
              ) : null}
              {displayedChapters.length > 0 ? (
              <FlatList
                ref={chapterListRef}
                onScrollToIndexFailed={({ index }) => {
                  // Rows past the rendered window: jump by offset (rows have a fixed height).
                  chapterListRef.current?.scrollToOffset({ offset: index * CHAPTER_ITEM_H, animated: false });
                }}
                data={displayedChapters}
                keyExtractor={chapterKeyExtractor}
                renderItem={renderChapter}
                style={[s.chaptersListBox, { height: chapterListHeight }]}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                windowSize={5}
                removeClippedSubviews
                getItemLayout={getChapterLayout}
                extraData={chapterListExtra}
                scrollEnabled={displayedChapters.length * CHAPTER_ITEM_H > chapterListHeight}
              />
              ) : null}
            </View>
          )}

          {/* Author tab */}
          {/* {activeTab === 'author' && creatorWallet && (
            <CreatorTab creatorWallet={creatorWallet} />
          )} */}

          {/* Sequels and similar series, from data the detail call already
              returned. Network-only: their covers and pages need it. */}
          {online && relatedCards.length > 0 ? (
            <View style={s.railSection}>
              <Text style={s.railTitle}>Related</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.railList}>
                {relatedCards.map((item) => <ContentCard key={item.id} item={item} />)}
              </ScrollView>
            </View>
          ) : null}
          {online && similarCards.length > 0 ? (
            <View style={s.railSection}>
              <Text style={s.railTitle}>More like this</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.railList}>
                {similarCards.map((item) => <ContentCard key={item.id} item={item} />)}
              </ScrollView>
            </View>
          ) : null}

          {/* Network-only: offline it would sit on a spinner and then fail. */}
          {online ? <CommentsSection contentId={`manga:${mangaId}`} title="Discussion" /> : null}

          <View style={{ height: insets.bottom + (playChapter ? 118 : 24) }} />
        </View>
      </Animated.ScrollView>

      {playChapter && (
        <View style={[s.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
          <View style={s.bottomCtaRow}>
            <GlowButton
              flex
              label={playLabel}
              onPress={() =>
                openMangaChapter(playChapter, canContinueManga && playChapter.id === resumeChapterId)
              }
            />
            {/* See showBatchDownload. Web renders MangaDetailWeb above, which
                gets the same control through its `batch` prop, so this bar
                is native-only. */}
            {showBatchDownload && (
              <TouchableOpacity
                style={s.dlOutlineBtn}
                activeOpacity={0.85}
                onPress={handleDownloadAll}
              >
                {batchPaused ? (
                  <Text style={s.dlOutlineText}>Resume</Text>
                ) : bulkDownloading ? (
                  <Text style={s.dlOutlineText}>
                    Pause{batchProgress ? ` · ${batchProgress.done}/${batchProgress.total}` : ''}
                  </Text>
                ) : (
                  <>
                    <DownloadIcon color={colors.primary} size={16} />
                    <Text style={s.dlOutlineText} numberOfLines={1}>
                      Download
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <Toast
        message={toast}
        visible={!!toast}
        onHide={() => { setToast(''); setToastDuration(undefined); }}

        durationMs={toastDuration}
        bottomOffset={insets.bottom + (playChapter ? 88 : 20)}
      />
    </View>
  );
}

// ─── Static styles ────────────────────────────────────────────────────────────
const gb = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { minWidth: 0 },
  wrap: { width: '100%', alignSelf: 'stretch' },
  glow: {
    borderRadius: Radius.full,
    shadowColor: '#E84545',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  btn: {
    width: '100%',
    backgroundColor: '#E84545',
    borderRadius: Radius.full,
    paddingVertical: 13,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  iconWrap: { flexShrink: 0 },
  label: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    letterSpacing: 0.2,
  },
});
