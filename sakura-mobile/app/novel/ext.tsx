import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { Dimensions } from 'react-native';
import {
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
  TouchableOpacity,
  FlatList,
  Platform,
  Modal,
  Pressable,
  ActivityIndicator,
  type ListRenderItemInfo,
} from 'react-native';
import { Image } from 'expo-image';
import { contentWidth, isWideWeb } from '@/constants/layout';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  useAnimatedScrollHandler,
  interpolate,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
  Extrapolation,
} from 'react-native-reanimated';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path, Polygon } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { shareContentLink } from '@/lib/share-link';
import { Toast } from '@/components/ui/Toast';
import { playTap, onTap } from '@/lib/sound';
import {
  fetchNovelChapterList,
  fetchNovelDetailHeader,
  peekNovelChapterList,
  prefetchNovelChapterPage,
  type AllNovelDetail,
  type AllNovelChapter,
} from '@/lib/allnovel';
import { Library } from '@/lib/storage';
import {
  downloadNovelChapter,
  downloadAllNovelChapters,
  getOfflineMapForNovel,
  getNovelBatchState,
  pauseNovelBatchDownload,
  resumeNovelBatchDownload,
  subscribeOfflineNovel,
  subscribeNovelBatch,
  type OfflineNovelChapter,
} from '@/lib/novel-offline';
import {
  findNovelProgressForSeries,
  getAllNovelProgressEntries,
  subscribeReadingProgress,
  isActiveReadingProgress,
  type NovelProgress,
} from '@/lib/reader-progress';
import {
  buildChapterReadState,
  downloadStartIndex,
  planNextDownloads,
  type ChapterReadState,
} from '@/lib/novel-navigation';
import { useFocusedSubscription } from '@/lib/hooks/useFocusedSubscription';
import ResumeReadingHint from '@/components/ui/ResumeReadingHint';
import { isSakuraNovelPath } from '@/lib/sakura-novels';
import NovelDetailWeb from '@/components/novel/NovelDetailWeb';
import { useSafeBack } from '@/components/novel/useSafeBack';

/**
 * Window-dependent metrics, read reactively rather than frozen at bundle
 * evaluation. Same shape as the other three detail screens; see app/novel/[id].tsx
 * for why the desktop cap exists.
 */
const DESKTOP_HERO_H = 560;

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
const HEADER_FADE_DISTANCE = 48;
const CHAPTER_ITEM_H = 64;
const DOWNLOAD_COUNTS = [10, 30, 100] as const;

/**
 * The chapter list of each running or paused batch download, by novel.
 *
 * A paused batch resumes by index into its list (lib/novel-offline keeps only
 * the counters), so resuming must reuse the exact list it started with — not
 * a list recomputed from a reading position that has since moved. Module
 * scope, like the batch state itself, so it survives leaving the screen.
 */
const batchPlans = new Map<string, AllNovelChapter[]>();
/**
 * Novels whose downloadAllNovelChapters call has not returned yet. Pausing
 * only raises a flag that the loop checks between chapters, so for a moment
 * after "Pause" the loop is still finishing the chapter in flight; a resume in
 * that moment must let that loop carry on rather than start a second one.
 */
const runningBatches = new Set<string>();

/** Read marks rarely change; skip the re-render when they did not. */
function readStateSignature(state: ChapterReadState | null): string {
  if (!state) return '';
  let partial = '';
  state.partial.forEach((v, k) => {
    partial += `${k}:${Math.round(v * 100)}|`;
  });
  return `${state.finished.size}#${partial}`;
}

/** Progress rows that belong to this novel's chapters. */
function seriesMatcher(seriesPath: string) {
  const base = seriesPath.replace(/\/$/, '');
  const slug = base.replace(/\.html?$/i, '');
  return (row: { path: string; novelSeriesPath?: string }) => {
    const s = (row.novelSeriesPath || '').replace(/\/$/, '');
    return s === base || s === slug || row.path.startsWith(`${slug}/`);
  };
}

type ChapterSort = 'oldest' | 'newest';

// ─── Icons ────────────────────────────────────────────────────────────────────
const ShareIcon = ({ color = '#fff' }) => (
  <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
    <Path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const BackIcon = ({ white = false }) => {
  const { colors } = useTheme();
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={white ? '#fff' : colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
};

const BookmarkIcon = ({ saved, dark = false }: { saved: boolean; dark?: boolean }) => {
  const { colors } = useTheme();
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill={saved ? colors.primary : 'none'}>
      <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
        stroke={saved ? colors.primary : dark ? colors.text : '#fff'}
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
};

const BookOpenIcon = () => (
  <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
    <Path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const DownloadIcon = ({ color, size = 16 }: { color: string; size?: number }) => (
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

const StarIcon = ({ goldColor }: { goldColor: string }) => (
  <Svg width={11} height={11} viewBox="0 0 24 24">
    <Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill={goldColor} />
  </Svg>
);

function formatStatus(status?: string): string {
  if (!status) return '';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────
function SkeletonBox({ w, h, radius = 8, style: extra }: { w?: number | string; h: number; radius?: number; style?: object }) {
  const { colors } = useTheme();
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(withTiming(0.7, { duration: 750 }), withTiming(0.35, { duration: 750 })),
      -1,
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[{ width: w ?? '100%', height: h, borderRadius: radius, backgroundColor: colors.border }, style, extra]} />
  );
}

function DetailSkeleton({ onBack }: { onBack: () => void }) {
  const { HERO_H } = useDetailMetrics();
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[s.heroContainer, { height: HERO_H }]}>
        <SkeletonBox h={HERO_H + 60} radius={0} />
        <SafeAreaView edges={['top']} style={s.heroButtonsSafe}>
          <View style={s.heroButtons}>
            <TouchableOpacity onPress={onBack} style={s.heroBtn} activeOpacity={0.85}>
              <BackIcon white />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
        <View style={s.heroInfo}>
          <SkeletonBox w="70%" h={20} radius={5} style={{ marginBottom: 8, backgroundColor: 'rgba(255,255,255,0.22)' }} />
          <SkeletonBox w="40%" h={13} radius={5} style={{ backgroundColor: 'rgba(255,255,255,0.16)' }} />
        </View>
      </View>
      <View style={{ backgroundColor: colors.background, borderTopLeftRadius: 14, borderTopRightRadius: 14, marginTop: -24, paddingTop: 18 }}>
        <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: Spacing.md, marginBottom: 14 }}>
          <SkeletonBox w={60} h={22} radius={Radius.full} />
          <SkeletonBox w={52} h={22} radius={Radius.full} />
          <SkeletonBox w={68} h={22} radius={Radius.full} />
        </View>
        <View style={{ flexDirection: 'row', marginHorizontal: Spacing.md, marginBottom: 14, backgroundColor: colors.surfaceSecondary, borderRadius: Radius.sm, paddingVertical: 12 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
              <SkeletonBox w={32} h={16} radius={5} />
              <SkeletonBox w={44} h={10} radius={5} />
            </View>
          ))}
        </View>
        <View style={{ paddingHorizontal: Spacing.md, gap: 7, marginBottom: 18 }}>
          <SkeletonBox h={12} radius={4} />
          <SkeletonBox h={12} radius={4} />
          <SkeletonBox w="80%" h={12} radius={4} />
        </View>
        <View style={{ flexDirection: 'row', paddingHorizontal: Spacing.md, gap: 8, marginBottom: 18 }}>
          <SkeletonBox w={140} h={42} radius={Radius.full} />
          <SkeletonBox w={80} h={42} radius={Radius.full} />
        </View>
        <View style={{ paddingHorizontal: Spacing.md, gap: 7 }}>
          {[0, 1, 2, 3].map((i) => <SkeletonBox key={i} h={50} radius={Radius.sm} />)}
        </View>
      </View>
    </View>
  );
}

// ─── Glow CTA button ──────────────────────────────────────────────────────────
function GlowButton({
  label,
  onPress,
  flex,
}: {
  label: string;
  onPress: () => void;
  flex?: boolean;
}) {
  const btnScale = useSharedValue(1);
  const btnStyle = useAnimatedStyle(() => ({ transform: [{ scale: btnScale.value }] }));

  const handlePress = () => {
    btnScale.value = withSequence(withSpring(0.95, { damping: 12 }), withSpring(1, { damping: 10 }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    playTap();
    onPress();
  };

  return (
    <View style={[gb.glow, flex && gb.flex, flex && gb.shrink, gb.wrap]}>
      <Animated.View style={[btnStyle, flex && gb.flex, flex && gb.shrink]}>
        <TouchableOpacity onPress={handlePress} activeOpacity={1} style={[gb.btn, flex && gb.flex]}>
          <View style={gb.iconWrap}>
            <BookOpenIcon />
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
  offline,
  onDownload,
  onOpen,
  isResume,
  readMark,
}: {
  ch: AllNovelChapter;
  offline?: OfflineNovelChapter | null;
  onDownload: (ch: AllNovelChapter) => void;
  onOpen: (ch: AllNovelChapter, resume: boolean) => void;
  isResume?: boolean;
  /** 'read' when finished, a 0–1 fraction when partly read. */
  readMark?: 'read' | number;
}) {
  const { colors } = useTheme();

  const chStyle = useMemo(() => StyleSheet.create({
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
    numBadge: {
      width: 40,
      height: 52,
      borderRadius: 6,
      backgroundColor: colors.surfaceTertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    numText: {
      fontFamily: Fonts.display,
      fontWeight: FontWeight.heavy,
      fontSize: 10,
      color: colors.primary,
    },
    info: { flex: 1, minWidth: 0 },
    title: {
      fontSize: FontSize.sm,
      fontWeight: FontWeight.semibold,
      color: colors.text,
      marginBottom: 1,
    },
    meta: { fontSize: 10, color: colors.textTertiary },
    dlLabel: { fontSize: 10, color: colors.primary, marginTop: 2 },
    dlBtn: { padding: 6, marginLeft: 4 },
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
  }), [colors]);

  return (
    <TouchableOpacity
      onPress={() => onOpen(ch, !!isResume)}
      // Start fetching the chapter while the finger is still down (~100 ms head start).
      onPressIn={() => prefetchNovelChapterPage(ch.path)}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`${ch.name}${readMark === 'read' ? ', read' : typeof readMark === 'number' ? `, ${Math.round(readMark * 100)}% read` : ''}`}
      style={[chStyle.row, isResume && { borderWidth: 1, borderColor: `${colors.primary}55` }]}
    >
      <View style={chStyle.numBadge}>
        <Text style={chStyle.numText}>{ch.chapterNumber}</Text>
      </View>
      <View style={chStyle.info}>
        <Text style={[chStyle.title, readMark === 'read' && !isResume && { color: colors.textTertiary }]} numberOfLines={1}>{ch.name}</Text>
        {readMark === 'read' && !isResume ? <Text style={chStyle.meta}>Read ✓</Text> : null}
        {typeof readMark === 'number' && !isResume ? <Text style={chStyle.meta}>{Math.round(readMark * 100)}% read</Text> : null}
        {ch.releaseTime ? <Text style={chStyle.meta}>{ch.releaseTime}</Text> : null}
        {offline?.status === 'downloading' && (
          <Text style={chStyle.dlLabel}>Downloading {Math.round(offline.progress * 100)}%</Text>
        )}
        {offline?.status === 'ready' && (
          <Text style={[chStyle.dlLabel, { color: '#34C759' }]}>Downloaded</Text>
        )}
        {isResume && (
          <View style={chStyle.resumeBadge}>
            <Text style={chStyle.resumeBadgeText}>Continue here</Text>
          </View>
        )}
      </View>
      <TouchableOpacity
        onPress={(e) => {
          e.stopPropagation?.();
          onDownload(ch);
        }}
        style={chStyle.dlBtn}
        hitSlop={8}
        disabled={offline?.status === 'downloading' || offline?.status === 'ready'}
      >
        <DownloadIcon color={colors.primary} />
      </TouchableOpacity>
      <ChevronIcon color={colors.textTertiary} />
    </TouchableOpacity>
  );
});

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function NovelExtDetail() {
  const { W, HERO_H, HEADER_TRIGGER, CHAPTER_LIST_MAX_H } = useDetailMetrics();
  const { path, id } = useLocalSearchParams<{ path?: string; id?: string }>();
  const router = useRouter();
  const safeBack = useSafeBack();
  const goBack = useCallback(() => safeBack('/novel'), [safeBack]);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<AllNovelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast] = useState('');
  const [offlineMap, setOfflineMap] = useState<Record<string, OfflineNovelChapter>>({});
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [batchPaused, setBatchPaused] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [novelProgress, setNovelProgress] = useState<NovelProgress | null>(null);
  const [chapterSort, setChapterSort] = useState<ChapterSort>('oldest');
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [chaptersError, setChaptersError] = useState(false);
  const [readState, setReadState] = useState<ChapterReadState | null>(null);
  const readSig = useRef('');
  const [downloadMenu, setDownloadMenu] = useState(false);
  const chapterListRef = useRef<FlatList<AllNovelChapter>>(null);
  const scrollY = useSharedValue(0);

  useEffect(() => {
    if (Platform.OS !== 'web' || !toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const decodedPath = path ? decodeURIComponent(path) : id ? decodeURIComponent(id) : '';

  const loadNovelProgress = useCallback(() => {
    if (!decodedPath) return;
    findNovelProgressForSeries(decodedPath).then(setNovelProgress);
    void getAllNovelProgressEntries().then((rows) => {
      const next = buildChapterReadState(rows, seriesMatcher(decodedPath));
      const sig = readStateSignature(next);
      if (sig === readSig.current) return;
      readSig.current = sig;
      setReadState(next);
    });
  }, [decodedPath]);

  // Only while focused: the reader above this page saves progress every few
  // seconds, and the focus effect below reloads on return (including the
  // first focus).
  useFocusedSubscription(subscribeReadingProgress, loadNovelProgress);

  useFocusEffect(
    useCallback(() => {
      loadNovelProgress();
    }, [loadNovelProgress]),
  );

  /**
   * Header first, chapters second. The title, cover and synopsis render as
   * soon as the detail page parses; the chapter list (one more request, up to
   * ~600 KB for long novels) fills in behind a skeleton. Before, nothing
   * rendered until all three requests had finished in sequence (1.33 s).
   */
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setChaptersError(false);
    if (!decodedPath) { setLoading(false); setLoadError('Choose a novel from the library to get started.'); return; }
    const cachedChapters = peekNovelChapterList(decodedPath);
    fetchNovelDetailHeader(decodedPath)
      .then((header) => {
        if (!active) return;
        if (!header.name) throw new Error('The title is not available.');
        const chapters = header.chapters.length ? header.chapters : cachedChapters ?? [];
        setDetail({ ...header, chapters });
        setLoading(false);
        if (chapters.length || !header.novelId) {
          setChaptersLoading(false);
          return;
        }
        setChaptersLoading(true);
        fetchNovelChapterList(header.novelId, decodedPath)
          .then((list) => {
            if (!active) return;
            setDetail((current) => (current && current.path === header.path ? { ...current, chapters: list } : current));
            setChaptersLoading(false);
          })
          .catch(() => {
            if (!active) return;
            setChaptersLoading(false);
            setChaptersError(true);
          });
      })
      .catch(() => { if (active) { setDetail(null); setLoading(false); setLoadError('Please try again, or choose another title from the library.'); } });
    void Library.isSaved(decodedPath, 'novel').then(value => { if (active) setSaved(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [decodedPath, retry]);

  const handleSave = async () => {
    if (!detail) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playTap();
    const next = await Library.toggle({
      id: decodedPath,
      title: detail.name,
      cover: detail.cover || '',
      type: 'novel',
      savedAt: 0,
    });
    setSaved(next);
    setToast(next ? 'Added to library' : 'Removed from library');
  };

  const handleShare = () => {
    if (!detail) return;
    playTap();
    shareContentLink(`Read "${detail.name}" on Sakura!`, `/novel/ext?path=${encodeURIComponent(decodedPath)}`);
  };

  const refreshOffline = useCallback(() => {
    if (!decodedPath) return;
    getOfflineMapForNovel(decodedPath).then(setOfflineMap);
  }, [decodedPath]);

  useEffect(() => {
    if (!detail) return;
    refreshOffline();
    const unsubscribe = subscribeOfflineNovel(refreshOffline);
    return () => { unsubscribe(); };
  }, [detail, refreshOffline]);

  useEffect(() => {
    if (!decodedPath) return;
    const refreshBatch = () => {
      const state = getNovelBatchState(decodedPath);
      setBatchPaused(!!state?.paused);
      setBatchProgress(state ? { done: state.done, total: state.total } : null);
      if (state && !state.paused && state.done < state.total) {
        setBulkDownloading(true);
      } else if (!state?.paused) {
        setBulkDownloading(false);
      }
    };
    refreshBatch();
    const unsubscribe = subscribeNovelBatch(refreshBatch);
    return () => { unsubscribe(); };
  }, [decodedPath]);

  const openChapter = useCallback((ch: AllNovelChapter, resume = false) => {
    if (!detail) return;
    const off = offlineMap[ch.path];
    router.push({
      pathname: '/novel/read',
      params: {
        path: ch.path,
        title: detail.name,
        cover: detail.cover || '',
        chapter: ch.name,
        novelPath: decodedPath,
        ...(resume && novelProgress ? { o: String(novelProgress.progress) } : {}),
        ...(off?.status === 'ready' ? { offline: '1' } : {}),
      },
    });
  }, [detail, decodedPath, offlineMap, novelProgress, router]);

  const handleDownloadChapter = useCallback(async (ch: AllNovelChapter) => {
    if (!detail) return;
    playTap();
    // Web and native share this path. On web, downloadNovelChapter resolves to
    // lib/novel-offline.web.ts, which stores the chapter text in Cache Storage
    // — so the chapter is readable in the app offline rather than being dumped
    // into the browser's Downloads folder as a .txt the app can never reopen.
    // Batch download, pause/resume and the Downloads screen come with it,
    // because the web store exports the same surface as the native one.
    const existing = offlineMap[ch.path];
    if (existing?.status === 'ready') {
      setToast('Chapter already downloaded');
      return;
    }
    if (existing?.status === 'downloading') {
      setToast('Download in progress');
      return;
    }
    setToast('Downloading chapter…');
    try {
      await downloadNovelChapter({
        novelPath: decodedPath,
        chapterPath: ch.path,
        chapterNumber: ch.chapterNumber,
        chapterTitle: ch.name,
        title: detail.name,
        cover: detail.cover || '',
      });
      setToast('Chapter downloaded');
      refreshOffline();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Download failed');
      refreshOffline();
    }
  }, [detail, decodedPath, offlineMap, refreshOffline]);

  const chaptersAscForDownload = useMemo(
    () => (detail ? [...detail.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber) : []),
    [detail],
  );
  const activeResumePath = novelProgress && isActiveReadingProgress(novelProgress.progress) ? novelProgress.path : null;
  /** Where "Download next N" starts: the chapter being read, else after the last finished one. */
  const downloadStart = useMemo(
    () => downloadStartIndex(chaptersAscForDownload, { resumePath: activeResumePath, finished: readState?.finished }),
    [chaptersAscForDownload, activeResumePath, readState],
  );
  const downloadFromLabel = chaptersAscForDownload[downloadStart]
    ? chaptersAscForDownload[downloadStart].name || `Chapter ${chaptersAscForDownload[downloadStart].chapterNumber}`
    : '';

  const runBatchDownload = useCallback(async (count?: number) => {
    if (!detail || detail.chapters.length === 0) return;
    const paused = getNovelBatchState(decodedPath)?.paused;
    let list = paused ? batchPlans.get(decodedPath) : undefined;
    if (!list) {
      // A paused job resumes by index into its own list; with that list gone,
      // clear the pause so the new plan starts at its first chapter.
      if (paused) resumeNovelBatchDownload(decodedPath);
      list = planNextDownloads(chaptersAscForDownload, downloadStart, count ?? 30, (path) => offlineMap[path]?.status === 'ready');
      if (!list.length) {
        setToast('Those chapters are already downloaded');
        return;
      }
      batchPlans.set(decodedPath, list);
    }
    setBulkDownloading(true);
    setToast(`Downloading ${list.length} chapters… keep the app open`);
    runningBatches.add(decodedPath);
    try {
      const { ok, failed, paused: nowPaused } = await downloadAllNovelChapters({
        novelPath: decodedPath,
        title: detail.name,
        cover: detail.cover || '',
        chapters: list.map((ch) => ({
          path: ch.path,
          chapterNumber: ch.chapterNumber,
          name: ch.name,
        })),
        limit: list.length,
      });
      if (nowPaused) {
        setToast(`Paused · ${ok} of ${list.length} downloaded`);
      } else {
        batchPlans.delete(decodedPath);
        setToast(
          failed > 0 ? `Downloaded ${ok} chapters (${failed} failed)` : `Downloaded ${ok} chapters`,
        );
      }
      refreshOffline();
    } catch (e) {
      batchPlans.delete(decodedPath);
      setToast(e instanceof Error ? e.message : 'Download failed');
    } finally {
      runningBatches.delete(decodedPath);
      if (!getNovelBatchState(decodedPath)?.paused) {
        setBulkDownloading(false);
      }
    }
  }, [detail, decodedPath, refreshOffline, chaptersAscForDownload, downloadStart, offlineMap]);

  /** Pause a running batch or resume a paused one. */
  const toggleBatch = () => {
    if (batchPaused) {
      playTap();
      setBatchPaused(false);
      if (runningBatches.has(decodedPath)) {
        // The paused loop has not reached its pause check yet: un-pausing lets
        // it carry on, instead of a second loop running over the same list.
        resumeNovelBatchDownload(decodedPath);
      } else {
        // Leave the job marked paused. runBatchDownload then reuses the
        // batch's own chapter list, and downloadAllNovelChapters resumes a
        // PAUSED job from where it stopped, with its counts. Clearing the
        // flag first (as this used to) made both start over with a freshly
        // planned 30, so "Download next 100" paused at 20 ended at 50.
        void runBatchDownload();
      }
      return;
    }
    if (bulkDownloading) {
      playTap();
      pauseNovelBatchDownload(decodedPath);
      setToast('Download paused');
    }
  };

  const startDownloadNext = (count: number) => {
    if (!detail || detail.chapters.length === 0) return;
    playTap();
    setDownloadMenu(false);
    void runBatchDownload(count);
  };

  const handleDownloadAll = () => {
    if (!detail || detail.chapters.length === 0) return;
    if (batchPaused || bulkDownloading) {
      toggleBatch();
      return;
    }
    playTap();
    setDownloadMenu(true);
  };

  // "Continue" should open instantly: fetch the resume chapter once the page has settled.
  useEffect(() => {
    if (!activeResumePath || !detail) return;
    const t = setTimeout(() => prefetchNovelChapterPage(activeResumePath), 1200);
    return () => clearTimeout(t);
  }, [activeResumePath, detail]);

  const scrollHandler = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });

  const heroStyle = useAnimatedStyle(() => ({
    transform: [{
      translateY: interpolate(scrollY.value, [0, HERO_H], [0, -HERO_H * 0.3], Extrapolation.CLAMP),
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

  const dynS = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.surface },
    stickyHeader: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 40,
      overflow: 'hidden',
    },
    /** Bleeds past nav row so iOS BlurView does not draw a hairline at the bottom edge. */
    stickyHeaderFill: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: -12,
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
      left: 0,
      right: 0,
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
    heroGrad: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%' },
    heroContent: { position: 'absolute', bottom: 44, left: 16, right: 16 },
    heroTitle: {
      fontFamily: Fonts.display,
      fontWeight: FontWeight.heavy,
      fontSize: 24,
      color: '#fff',
      marginBottom: 10,
      textShadowColor: 'rgba(0,0,0,0.65)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 6,
    },
    heroMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    heroBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: 'rgba(0,0,0,0.50)',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
    },
    heroBadgeSakura: {
      backgroundColor: 'rgba(232,69,69,0.40)',
      borderColor: 'rgba(255,255,255,0.25)',
    },
    heroBadgeTxt: {
      color: '#fff',
      fontSize: 11,
      fontWeight: FontWeight.semibold,
      textShadowColor: 'rgba(0,0,0,0.45)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 2,
    },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    heroMetaTxt: { color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: FontWeight.medium },
    heroMetaSep: { color: 'rgba(255,255,255,0.38)', fontSize: 12 },
    card: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      marginTop: -22,
      paddingTop: 20,
      paddingHorizontal: 16,
    },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 12, flexWrap: 'wrap' },
    metaPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.surfaceSecondary,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: Radius.full,
    },
    metaPillAccent: {
      backgroundColor: `${colors.primary}14`,
      borderWidth: 1,
      borderColor: `${colors.primary}35`,
    },
    metaPillStatus: {
      borderWidth: 1,
      borderColor: `${colors.primary}35`,
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
    metaTxtAccent: {
      fontSize: 11,
      color: colors.primary,
      fontWeight: FontWeight.bold,
    },
    metaTxt: { fontSize: 11, color: colors.textSecondary, fontWeight: FontWeight.medium },
    genreRow: { flexDirection: 'row', gap: 5, flexWrap: 'wrap', marginBottom: 14 },
    genreChip: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: Radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    genreChipText: { fontSize: FontSize.xs, fontWeight: FontWeight.medium, color: colors.textSecondary },
    synWrap: { marginBottom: 18 },
    synopsis: { fontFamily: Fonts.body, fontSize: 13.5, color: colors.textSecondary, lineHeight: 20 },
    expandText: { color: colors.primary, fontWeight: FontWeight.semibold, fontSize: 12, marginTop: 4 },
    chaptersSection: { marginBottom: 8 },
    secHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
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
    countTxt: { color: colors.primary, fontSize: 11, fontWeight: FontWeight.bold },
    sortLink: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, paddingVertical: 2 },
    sortLinkText: { fontSize: 12, fontWeight: FontWeight.semibold, color: colors.primary },
    chaptersListBox: {
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceSecondary,
      overflow: 'hidden',
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
    },
    bottomCtaRow: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
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
    dlOutlineText: { color: colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  }), [colors, W, HERO_H]);

  const chaptersAsc = chaptersAscForDownload;
  const displayedChapters = useMemo(
    () => (chapterSort === 'oldest' ? chaptersAsc : [...chaptersAsc].reverse()),
    [chaptersAsc, chapterSort],
  );
  const chapterListHeight = Math.min(
    displayedChapters.length * CHAPTER_ITEM_H,
    CHAPTER_LIST_MAX_H,
  );

  const canContinueNovel =
    !!novelProgress && isActiveReadingProgress(novelProgress.progress);
  const resumeChapterPath = canContinueNovel ? novelProgress!.path : null;

  const renderChapter = useCallback(
    ({ item: ch }: ListRenderItemInfo<AllNovelChapter>) => (
      <ChapterRow
        ch={ch}
        offline={offlineMap[ch.path]}
        onDownload={handleDownloadChapter}
        onOpen={openChapter}
        isResume={canContinueNovel && ch.path === resumeChapterPath}
        readMark={readState?.finished.has(ch.path) ? 'read' : readState?.partial.get(ch.path)}
      />
    ),
    [offlineMap, handleDownloadChapter, openChapter, canContinueNovel, resumeChapterPath, readState],
  );

  const resumeListIndex = resumeChapterPath ? displayedChapters.findIndex((c) => c.path === resumeChapterPath) : -1;
  const jumpToCurrent = useCallback(() => {
    if (resumeListIndex < 0) return;
    Haptics.selectionAsync();
    chapterListRef.current?.scrollToIndex({ index: resumeListIndex, viewPosition: 0.3, animated: true });
  }, [resumeListIndex]);

  const chapterKeyExtractor = useCallback((ch: AllNovelChapter) => ch.path, []);

  const getChapterLayout = useCallback(
    (_: ArrayLike<AllNovelChapter> | null | undefined, index: number) => ({
      length: CHAPTER_ITEM_H,
      offset: CHAPTER_ITEM_H * index,
      index,
    }),
    [],
  );

  if (Platform.OS === 'web') return <NovelDetailWeb
    detail={detail} loading={loading} error={loadError} saved={saved} original={isSakuraNovelPath(decodedPath)}
    progress={novelProgress} offline={offlineMap} batchDownloading={bulkDownloading} batchPaused={batchPaused} batchProgress={batchProgress} toast={toast}
    onBack={goBack}
    onRetry={() => setRetry(value => value + 1)}
    onSave={() => { void handleSave().catch(() => setToast('This title could not be saved. Please try again.')); }}
    onShare={handleShare} onOpen={openChapter} onDownload={handleDownloadChapter}
    chaptersLoading={chaptersLoading} chaptersError={chaptersError} readState={readState}
    downloadFromLabel={downloadFromLabel} onDownloadNext={startDownloadNext} onToggleBatch={toggleBatch}
  />;

  if (loading || !detail) return <DetailSkeleton onBack={onTap(goBack)} />;

  const genreList = detail.genres ? detail.genres.split(',').map((g) => g.trim()).filter(Boolean) : [];
  const statusColor = detail.status?.includes('complet') ? colors.success
    : detail.status?.includes('hiatus') ? colors.warning
    : colors.primary;
  const isSakura = isSakuraNovelPath(decodedPath);
  const statusLabel = formatStatus(detail.status);

  const firstChapter =
    detail.chapters.length > 0
      ? detail.chapters.reduce((min, ch) => (ch.chapterNumber < min.chapterNumber ? ch : min))
      : null;
  const resumeChapter = canContinueNovel
    ? detail.chapters.find((c) => c.path === novelProgress!.path) ?? null
    : null;
  const playChapter = resumeChapter || firstChapter;

  return (
    <View style={dynS.root}>
      <View style={[dynS.stickyHeader, { paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View style={[dynS.stickyHeaderFill, headerOpacity]} pointerEvents="none">
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />
          <BlurView intensity={80} tint={colors.blurTint as any} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={dynS.navRow}>
          <TouchableOpacity onPress={onTap(goBack)} style={dynS.navBtn} activeOpacity={0.8}>
            <BackIcon />
          </TouchableOpacity>
          <Animated.Text style={[dynS.navTitle, headerOpacity]} numberOfLines={1}>
            {detail.name}
          </Animated.Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <TouchableOpacity onPress={handleShare} style={dynS.navBtn} activeOpacity={0.8}>
              <ShareIcon color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              style={[dynS.navBtn, saved && dynS.navBtnSaved]}
              activeOpacity={0.8}
            >
              <BookmarkIcon saved={saved} dark={saved} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <Animated.View
        style={[dynS.floatNav, { top: insets.top + 8 }, floatNavOpacity]}
        pointerEvents="box-none"
      >
        <TouchableOpacity onPress={onTap(goBack)} style={dynS.navBtn} activeOpacity={0.8}>
          <BackIcon white />
        </TouchableOpacity>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <TouchableOpacity onPress={handleShare} style={dynS.navBtn} activeOpacity={0.8}>
            <ShareIcon />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSave}
            style={[dynS.navBtn, saved && dynS.navBtnSaved]}
            activeOpacity={0.8}
          >
            <BookmarkIcon saved={saved} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        bounces
      >
        <View style={dynS.heroWrap}>
          <Animated.View style={[StyleSheet.absoluteFill, heroStyle]}>
            {detail.cover ? (
              <Image
                source={{ uri: detail.cover }}
                style={dynS.heroImg}
                contentFit="cover"
                transition={400}
                placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
              />
            ) : (
              <View style={[dynS.heroImg, s.heroCoverFallback]} />
            )}
          </Animated.View>
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0.68)', 'rgba(0,0,0,0.92)']}
            locations={[0.3, 0.52, 0.78, 1]}
            style={dynS.heroGrad}
          />
          <View style={dynS.heroContent}>
            <Text style={dynS.heroTitle} numberOfLines={2}>{detail.name}</Text>
            <View style={dynS.heroMeta}>
              {statusLabel ? (
                <View style={dynS.heroBadge}>
                  <View style={[dynS.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={dynS.heroBadgeTxt}>{statusLabel}</Text>
                </View>
              ) : null}
              {isSakura ? (
                <View style={[dynS.heroBadge, dynS.heroBadgeSakura]}>
                  <Text style={dynS.heroBadgeTxt}>Sakura Original</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        <View style={dynS.card}>
          <Animated.View entering={FadeInDown.delay(40).duration(300)} style={dynS.metaRow}>
            {detail.rating != null && (
              <View style={dynS.metaPill}>
                <StarIcon goldColor={colors.gold} />
                <Text style={dynS.metaRating}>{detail.rating.toFixed(1)}</Text>
                <Text style={dynS.metaRatingSub}>/10</Text>
              </View>
            )}
            {detail.chapters.length > 0 && (
              <View style={dynS.metaPill}>
                <Text style={[dynS.metaTxt, { fontSize: 10 }]}>📖</Text>
                <Text style={dynS.metaTxt}>{detail.chapters.length} ch.</Text>
              </View>
            )}
            {statusLabel ? (
              <View style={[dynS.metaPill, dynS.metaPillStatus]}>
                <View style={[dynS.statusDot, { backgroundColor: statusColor }]} />
                <Text style={dynS.metaTxt}>{statusLabel}</Text>
              </View>
            ) : null}
            {isSakura ? (
              <View style={[dynS.metaPill, dynS.metaPillAccent]}>
                <Text style={dynS.metaTxtAccent}>Sakura Original</Text>
              </View>
            ) : null}
          </Animated.View>

          {genreList.length > 0 && (
            <Animated.View entering={FadeInDown.delay(70).duration(300)} style={dynS.genreRow}>
              {genreList.slice(0, 7).map((g) => (
                <View key={g} style={dynS.genreChip}>
                  <Text style={dynS.genreChipText}>{g}</Text>
                </View>
              ))}
            </Animated.View>
          )}

          {detail.summary ? (
            <Animated.View entering={FadeInDown.delay(100).duration(300)} style={dynS.synWrap}>
              <Text style={dynS.synopsis} numberOfLines={expanded ? undefined : 3}>
                {detail.summary}
              </Text>
              <TouchableOpacity onPress={() => setExpanded((v) => !v)} activeOpacity={0.7}>
                <Text style={dynS.expandText}>{expanded ? 'Show less ↑' : 'See more ↓'}</Text>
              </TouchableOpacity>
            </Animated.View>
          ) : null}

          {canContinueNovel && novelProgress && (
            <Animated.View entering={FadeInDown.delay(130).duration(320)} style={{ marginBottom: 14 }}>
              <ResumeReadingHint
                chapterLabel={novelProgress.chapterLabel || 'Last chapter'}
                detail={`${Math.round(novelProgress.progress * 100)}% through chapter`}
                progress={novelProgress.progress}
                colors={colors}
              />
            </Animated.View>
          )}

          {detail.chapters.length === 0 && (chaptersLoading || chaptersError) && (
            <View style={dynS.chaptersSection}>
              <View style={dynS.secHeader}>
                <Text style={dynS.secTitle}>Chapters</Text>
              </View>
              {chaptersError ? (
                <TouchableOpacity accessibilityRole="button" onPress={() => setRetry((v) => v + 1)} style={[dynS.chaptersListBox, { padding: 16, alignItems: 'center' }]}>
                  <Text style={{ color: colors.textSecondary, fontSize: 13 }}>The chapter list could not load. Tap to try again.</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ gap: 6 }} accessibilityLabel="Loading chapters">
                  {[0, 1, 2, 3].map((i) => <SkeletonBox key={i} h={CHAPTER_ITEM_H - 6} radius={Radius.sm} />)}
                </View>
              )}
            </View>
          )}

          {detail.chapters.length > 0 && (
            <View style={dynS.chaptersSection}>
              <View style={dynS.secHeader}>
                <Text style={dynS.secTitle}>Chapters</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {resumeListIndex >= 0 && displayedChapters.length * CHAPTER_ITEM_H > chapterListHeight ? (
                    <TouchableOpacity style={dynS.sortLink} activeOpacity={0.7} onPress={jumpToCurrent} accessibilityRole="button">
                      <Text style={dynS.sortLinkText}>Jump to current</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={dynS.sortLink}
                    activeOpacity={0.7}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setChapterSort((prev) => (prev === 'oldest' ? 'newest' : 'oldest'));
                    }}
                  >
                    <SortIcon color={colors.primary} />
                    <Text style={dynS.sortLinkText}>
                      {chapterSort === 'oldest' ? 'Oldest first' : 'Newest first'}
                    </Text>
                  </TouchableOpacity>
                  <View style={dynS.countBadge}>
                    <Text style={dynS.countTxt}>{detail.chapters.length}</Text>
                  </View>
                </View>
              </View>
              <FlatList
                ref={chapterListRef}
                data={displayedChapters}
                keyExtractor={chapterKeyExtractor}
                renderItem={renderChapter}
                // Opens on the chapter being read, not chapter 1 of 3,956.
                initialScrollIndex={resumeListIndex > 1 ? resumeListIndex - 1 : undefined}
                style={[dynS.chaptersListBox, { height: chapterListHeight }]}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                windowSize={5}
                removeClippedSubviews
                getItemLayout={getChapterLayout}
                extraData={[offlineMap, readState]}
                scrollEnabled={displayedChapters.length * CHAPTER_ITEM_H > chapterListHeight}
              />
            </View>
          )}

          <View style={{ height: insets.bottom + (playChapter ? 118 : 24) }} />
        </View>
      </Animated.ScrollView>

      {playChapter && (
        <View style={[dynS.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
          <View style={dynS.bottomCtaRow}>
            <GlowButton
              flex
              label={
                canContinueNovel && resumeChapter
                  ? `Continue · ${novelProgress!.chapterLabel || resumeChapter.name}`
                  : 'Start Reading'
              }
              onPress={() => openChapter(playChapter, canContinueNovel && !!resumeChapter)}
            />
            {/*
              Available on web too now. This was hidden because web had no
              offline store and the button would have fired one browser file
              download per chapter. A novel chapter is ~8KB, so a whole book is
              roughly 20MB — the storage ceiling that keeps image downloads to
              one chapter at a time simply does not bite here.
            */}
            {detail.chapters.length > 0 && (
              <TouchableOpacity
                style={dynS.dlOutlineBtn}
                activeOpacity={0.85}
                onPress={handleDownloadAll}
              >
                {batchPaused ? (
                  <Text style={dynS.dlOutlineText}>Resume</Text>
                ) : bulkDownloading ? (
                  <Text style={dynS.dlOutlineText}>
                    Pause{batchProgress ? ` · ${batchProgress.done}/${batchProgress.total}` : ''}
                  </Text>
                ) : (
                  <>
                    <DownloadIcon color={colors.primary} size={16} />
                    <Text style={dynS.dlOutlineText} numberOfLines={1}>
                      Download
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* "Download next N" — from the chapter being read, not always chapters 1–30. */}
      <Modal transparent visible={downloadMenu} animationType="fade" onRequestClose={() => setDownloadMenu(false)}>
        <View style={dl.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDownloadMenu(false)} accessibilityLabel="Close" />
          <View style={[dl.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[dl.title, { color: colors.text }]}>Download for offline</Text>
            <Text style={[dl.sub, { color: colors.textSecondary }]} numberOfLines={2}>
              Starting from {downloadFromLabel || 'the first chapter'}. Chapters already downloaded are skipped.
            </Text>
            {DOWNLOAD_COUNTS.map((count) => (
              <TouchableOpacity
                key={count}
                accessibilityRole="button"
                style={[dl.option, { borderColor: colors.border }]}
                activeOpacity={0.85}
                onPress={() => startDownloadNext(count)}
              >
                <DownloadIcon color={colors.primary} size={16} />
                <Text style={[dl.optionText, { color: colors.text }]}>
                  Next {Math.min(count, Math.max(1, chaptersAsc.length - downloadStart))} chapters
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity accessibilityRole="button" style={dl.cancel} onPress={() => setDownloadMenu(false)}>
              <Text style={[dl.cancelText, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Toast
        message={toast}
        visible={!!toast}
        onHide={() => setToast('')}
        bottomOffset={insets.bottom + (playChapter ? 88 : 20)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  // '100%' rather than a frozen pixel width: the hero is full-bleed, so it
  // fills its parent, and the parent is already width-correct.
  heroContainer: { width: '100%', overflow: 'hidden' },
  heroCoverFallback: { backgroundColor: '#1a0a2e' },
  heroButtonsSafe: { position: 'absolute', top: 0, left: 0, right: 0 },
  heroButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.md, paddingTop: 8 },
  heroBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.32)', alignItems: 'center', justifyContent: 'center' },
  heroInfo: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: Spacing.md, paddingBottom: 16 },
});

const dl = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, borderRadius: 22, borderWidth: 1, padding: 20, gap: 10 },
  title: { fontSize: 18, fontWeight: '800' },
  sub: { fontSize: 13, lineHeight: 19, marginBottom: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 14 },
  optionText: { fontSize: 15, fontWeight: '600' },
  cancel: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 20 },
  cancelText: { fontSize: 14, fontWeight: '600' },
});

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
