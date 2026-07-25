import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  StatusBar,
  Platform,
  Share,
  FlatList,
  type ListRenderItemInfo,
} from 'react-native';
import { Image } from 'expo-image';
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
import { Library } from '@/lib/storage';
import {
  fetchMangaDetail,
  fetchMangaChapters,
  fetchMangaChapterThumbnail,
  MangaDetail as MangaData,
  MangaChapter,
} from '@/lib/manga';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import { formatReleaseDate } from '@/lib/format-release-date';
import {
  downloadScrapedChapter,
  getScrapedOfflineMap,
  subscribeScrapedOffline,
  pauseScrapedChapterDownload,
  resumeScrapedChapterDownload,
  type ScrapedSource,
} from '@/lib/scraped-offline';
import {
  downloadMangaChapter,
  downloadAllMangaChapters,
  fetchChapterPageUrls,
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
import { saveImagesZip } from '@/lib/web-download';
import { playTap, onTap } from '@/lib/sound';
import {
  getMangaReadProgress,
  subscribeReadingProgress,
  isActiveReadingProgress,
  type MangaProgress,
} from '@/lib/reader-progress';
import ResumeReadingHint from '@/components/ui/ResumeReadingHint';
import CommentsSection from '@/components/social/CommentsSection';
import { useFocusEffect } from 'expo-router';
// import CreatorTab from '@/components/ui/CreatorTab';
import { supabase } from '@/lib/supabase';
import { getGatedChapterIds } from '@/lib/pass-gate';

const { width: W, height: SCREEN_H } = Dimensions.get('window');
const HERO_H = W * 0.68;
const HEADER_TRIGGER = Math.round(HERO_H * 0.35);
const HEADER_FADE_DISTANCE = 48;
const CHAPTER_LIST_MAX_H = Math.min(SCREEN_H * 0.42, 400);
const CHAPTER_ITEM_H = 64;

type ChapterSort = 'oldest' | 'newest';

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
  mangaCover,
  offline,
  onDownload,
  isResume,
  onOpen,
  hideDownload,
  disableThumbFetch,
  locked,
}: {
  ch: MangaChapter;
  mangaId: string;
  mangaCover?: string;
  offline?: OfflineMangaChapter | null;
  onDownload: (ch: MangaChapter) => void;
  isResume?: boolean;
  onOpen: (ch: MangaChapter, resume: boolean) => void;
  hideDownload?: boolean;
  disableThumbFetch?: boolean;
  locked?: boolean;
}) {
  const { colors } = useTheme();
  const [thumbUri, setThumbUri] = useState<string | null>(ch.coverUrl ?? null);

  // "12 pages · Jul 18, 2026", or whichever half exists. Both are optional:
  // some sources report no page count until a chapter is opened, and
  // synthesised chapters and offline-rebuilt lists carry no date.
  const metaLine = [
    ch.pageCount > 0 ? `${ch.pageCount} pages` : '',
    formatReleaseDate(ch.createdAt),
  ]
    .filter(Boolean)
    .join(' · ');

  useEffect(() => {
    let cancelled = false;
    if (ch.coverUrl) {
      setThumbUri(ch.coverUrl);
      return;
    }
    if (disableThumbFetch) {
      setThumbUri(null);
      return;
    }
    (async () => {
      const local = offline?.status === 'ready' ? await getOfflineMangaPageUris(mangaId, ch.id) : null;
      if (local?.[0]) {
        if (!cancelled) setThumbUri(local[0]);
        return;
      }
      const url = await fetchMangaChapterThumbnail(mangaId, ch.id);
      if (!cancelled && url) setThumbUri(url);
    })();
    return () => { cancelled = true; };
  }, [mangaId, ch.id, ch.coverUrl, offline?.status, disableThumbFetch]);

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
    sub: {
      fontSize: 10,
      color: colors.textTertiary,
    },
    dlLabel: {
      fontSize: 10,
      color: colors.primary,
      marginTop: 2,
    },
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

  const thumbSource = thumbUri || mangaCover || '';

  return (
    <TouchableOpacity
      onPress={() => onOpen(ch, !!isResume)}
      activeOpacity={0.85}
      style={[ch_s.row, isResume && { borderWidth: 1, borderColor: `${colors.primary}55` }]}
    >
      {thumbSource ? (
        <Image
          source={{ uri: thumbSource }}
          style={ch_s.thumb}
          contentFit="cover"
          transition={200}
          recyclingKey={`${mangaId}-${ch.id}`}
        />
      ) : (
        <View style={[ch_s.thumb, ch_s.thumbFallback]}>
          <Text style={ch_s.thumbFallbackNum}>{ch.number}</Text>
        </View>
      )}
      <View style={ch_s.info}>
        <Text style={ch_s.title} numberOfLines={1}>{ch.title}</Text>
        {/* One line, not two: the row height is fixed by CHAPTER_ITEM_H, which
            also feeds getItemLayout, so a third line would clip and
            desynchronise scroll offsets. */}
        {!!metaLine && <Text style={ch_s.sub}>{metaLine}</Text>}
        {offline?.status === 'downloading' && (
          <Text style={ch_s.dlLabel}>Downloading {Math.round(offline.progress * 100)}% · tap to pause</Text>
        )}
        {offline?.status === 'paused' && (
          <Text style={ch_s.dlLabel}>Paused {Math.round(offline.progress * 100)}% · tap to resume</Text>
        )}
        {offline?.status === 'ready' && <Text style={[ch_s.dlLabel, { color: '#34C759' }]}>Downloaded</Text>}
        {isResume && (
          <View style={ch_s.resumeBadge}>
            <Text style={ch_s.resumeBadgeText}>Continue here</Text>
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
  const { id, source } = useLocalSearchParams<{ id: string; source?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const mangaId = String(id || '');
  // Droplet-scraped sources reuse this screen but skip manga-only features
  // (atsu offline downloads, pass-gating, chapter-thumbnail fetches).
  // `adapter` is null for ordinary atsu-backed manga.
  const adapter = getScrapedAdapter(source);
  const isExternal = adapter !== null;
  // Distinct from isExternal: gates the surfaces an adult read must not touch
  // (library, history, lock-screen activity). Manhwa is scraped but SFW.
  const isAdult = adapter?.adult === true;

  const [manga, setManga] = useState<MangaData | null>(null);
  const [chapters, setChapters] = useState<MangaChapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState('');
  const [offlineMap, setOfflineMap] = useState<Record<string, OfflineMangaChapter>>({});
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [batchPaused, setBatchPaused] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [mangaProgress, setMangaProgress] = useState<MangaProgress | null>(null);
  const [chapterSort, setChapterSort] = useState<ChapterSort>('oldest');
  // const [activeTab, setActiveTab] = useState<'chapters' | 'author'>('chapters');
  // const [creatorWallet, setCreatorWallet] = useState<string | null>(null);

  const backScale = useSharedValue(1);
  const scrollY = useSharedValue(0);

  useEffect(() => {
    if (!mangaId) return;
    const detailFetch = adapter ? adapter.detail(mangaId) : fetchMangaDetail(mangaId);
    const chaptersFetch = adapter ? adapter.chapters(mangaId) : fetchMangaChapters(mangaId);
    Promise.all([
      detailFetch,
      chaptersFetch,
      // Adult titles are never saved to the library (shared 'manga' namespace +
      // no source-aware library rows), so don't bother checking saved state.
      isAdult ? Promise.resolve(false) : Library.isSaved(mangaId, 'manga'),
    ]).then(([detail, chs, isSaved]) => {
      setManga(detail);
      setChapters(chs.sort((a, b) => a.number - b.number));
      setSaved(isSaved);
      // // Look up creator wallet by matching title in creator_works
      // if (detail?.title) {
      //   supabase
      //     .from('creator_works')
      //     .select('creator_wallet')
      //     .eq('kind', 'manga')
      //     .ilike('title', detail.title)
      //     .eq('publication_status', 'published')
      //     .maybeSingle()
      //     .then(({ data }) => { if (data?.creator_wallet) setCreatorWallet(data.creator_wallet); });
      // }
    }).finally(() => setLoading(false));
  }, [mangaId]);

  const refreshOffline = useCallback(() => {
    if (!mangaId) return;
    if (adapter) {
      getScrapedOfflineMap(adapter.key, mangaId).then(setOfflineMap);
    } else {
      getOfflineMapForManga(mangaId).then(setOfflineMap);
    }
  }, [mangaId, adapter]);

  useEffect(() => {
    if (!mangaId) return;
    refreshOffline();
    return adapter ? subscribeScrapedOffline(refreshOffline) : subscribeOfflineManga(refreshOffline);
  }, [mangaId, adapter, refreshOffline]);

  useEffect(() => {
    if (!mangaId || isExternal) return;
    const refreshBatch = () => {
      const state = getMangaBatchState(mangaId);
      setBatchPaused(!!state?.paused);
      setBatchProgress(state ? { done: state.done, total: state.total } : null);
      if (state && !state.paused && state.done < state.total) {
        setBulkDownloading(true);
      } else if (!state?.paused) {
        setBulkDownloading(false);
      }
    };
    refreshBatch();
    return subscribeMangaBatch(refreshBatch);
  }, [mangaId]);

  const loadMangaProgress = useCallback(() => {
    if (!mangaId) return;
    getMangaReadProgress(mangaId).then(setMangaProgress);
  }, [mangaId]);

  useEffect(() => {
    loadMangaProgress();
    return subscribeReadingProgress(loadMangaProgress);
  }, [loadMangaProgress]);

  useFocusEffect(
    useCallback(() => {
      loadMangaProgress();
    }, [loadMangaProgress]),
  );

  // Latest chapters of an ongoing series sit behind the monthly pass. Comics
  // are never gated (separate catalogue, no editorial ongoing signal).
  const gatedChapterIds = useMemo(
    () => (isExternal ? new Set<string>() : getGatedChapterIds(manga?.status, chapters)),
    [isExternal, manga?.status, chapters],
  );

  const openMangaChapter = useCallback((ch: MangaChapter, resume = false) => {
    if (!manga) return;
    const off = offlineMap[ch.id];
    router.push({
      pathname: '/chapter/[id]',
      params: {
        id: `${mangaId}~${ch.id}`,
        title: manga.title,
        cover: (manga as { image?: string }).image || manga.cover || '',
        chapter: ch.title,
        ...(isExternal ? { source } : {}),
        ...(gatedChapterIds.has(ch.id) ? { gated: '1' } : {}),
        // Resume wherever you stopped IN THIS chapter, however you opened it.
        // Previously `p` was only sent from the Continue button, so tapping the
        // chapter you were halfway through restarted it from page 1.
        ...(mangaProgress && mangaProgress.chapterId === ch.id && mangaProgress.page > 1
          ? { p: String(mangaProgress.page) }
          : {}),
        ...(off?.status === 'ready' ? { offline: '1' } : {}),
      },
    });
  }, [manga, mangaId, offlineMap, mangaProgress, router, isExternal, source, gatedChapterIds]);

  const handleDownloadChapter = useCallback(async (ch: MangaChapter) => {
    if (!manga) return;
    playTap();
    // Web has no offline store — fetch the chapter's pages and save them as a
    // single .zip download (works for manga, comics, and 18+ alike).
    if (Platform.OS === 'web') {
      setToast('Preparing pages…');
      try {
        const urls = adapter
          ? await adapter.pages(mangaId, ch.id)
          : await fetchChapterPageUrls(mangaId, ch.id);
        if (!urls.length) throw new Error('No pages found for this chapter.');
        const saved = await saveImagesZip(`${manga.title} - Ch ${ch.number}`, urls);
        setToast(`Saved ${saved} pages to your device`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : 'Download failed');
      }
      return;
    }
    const existing = offlineMap[ch.id];
    if (existing?.status === 'ready') {
      setToast('Chapter already downloaded');
      return;
    }
    const cover = (manga as { image?: string }).image || manga.cover || '';
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

    if (existing?.status === 'paused') {
      if (scrapedSource) resumeScrapedChapterDownload(scrapedSource, mangaId, ch.id);
      else resumeMangaChapterDownload(mangaId, ch.id);
      setToast('Resuming download…');
    } else {
      setToast('Downloading chapter…');
    }

    try {
      const result = scrapedSource
        ? await downloadScrapedChapter({
            source: scrapedSource,
            contentId: mangaId,
            chapterId: ch.id,
            chapterNumber: ch.number,
            chapterTitle: ch.title,
            title: manga.title,
            cover,
          })
        : await downloadMangaChapter({
            mangaId,
            chapterId: ch.id,
            chapterNumber: ch.number,
            chapterTitle: ch.title,
            title: manga.title,
            cover,
          });
      setToast(result.paused ? 'Download paused' : 'Chapter downloaded');
      refreshOffline();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Download failed');
      refreshOffline();
    }
  }, [manga, mangaId, offlineMap, refreshOffline, adapter]);

  const runBatchDownload = useCallback(async () => {
    if (!manga || chapters.length === 0) return;
    setBulkDownloading(true);
    setToast(`Downloading ${chapters.length} chapters… keep app open`);
    try {
      const { ok, failed, paused } = await downloadAllMangaChapters({
        mangaId,
        title: manga.title,
        cover: manga.image || manga.cover || '',
        chapters: chapters.map((ch) => ({ id: ch.id, number: ch.number, title: ch.title })),
      });
      if (paused) {
        setToast(`Paused · ${ok} of ${chapters.length} downloaded`);
      } else {
        setToast(failed > 0 ? `Downloaded ${ok} chapters (${failed} failed)` : `Downloaded ${ok} chapters`);
      }
      refreshOffline();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Download failed');
    } finally {
      if (!getMangaBatchState(mangaId)?.paused) {
        setBulkDownloading(false);
      }
    }
  }, [manga, mangaId, chapters, refreshOffline]);

  const handleDownloadAll = async () => {
    if (!manga || chapters.length === 0) return;

    if (batchPaused) {
      playTap();
      resumeMangaBatchDownload(mangaId);
      setBatchPaused(false);
      void runBatchDownload();
      return;
    }

    if (bulkDownloading) {
      playTap();
      pauseMangaBatchDownload(mangaId);
      setToast('Download paused');
      return;
    }

    playTap();
    await runBatchDownload();
  };

  const handleSave = async () => {
    if (!manga) return;
    playTap();
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = await Library.toggle({ id: mangaId, title: manga.title, cover: manga.cover, type: 'manga', savedAt: 0 });
    setSaved(next);
    setToast(next ? 'Added to library' : 'Removed from library');
  };

  const handleShare = () => {
    if (!manga) return;
    playTap();
    Share.share({ message: `Check out "${manga.title}" on Sakura!\nsakura://manga/${mangaId}` });
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
    chaptersListBox: {
      borderRadius: Radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceSecondary,
      overflow: 'hidden',
    },
  }), [colors]);

  const chaptersAsc = useMemo(
    () => [...chapters].sort((a, b) => a.number - b.number),
    [chapters],
  );
  const displayedChapters = useMemo(
    () => (chapterSort === 'oldest' ? chaptersAsc : [...chaptersAsc].reverse()),
    [chaptersAsc, chapterSort],
  );
  const firstChapter = chaptersAsc[0] ?? null;
  const chapterListHeight = Math.min(
    displayedChapters.length * CHAPTER_ITEM_H,
    CHAPTER_LIST_MAX_H,
  );
  const canContinueManga =
    !!mangaProgress && isActiveReadingProgress(mangaProgress.progress);
  const resumeChapterId = canContinueManga ? mangaProgress!.chapterId : null;

  const renderChapter = useCallback(
    ({ item: ch }: ListRenderItemInfo<MangaChapter>) => (
      <ChapterRow
        ch={ch}
        mangaId={mangaId}
        mangaCover={manga?.cover}
        offline={offlineMap[ch.id]}
        onDownload={handleDownloadChapter}
        onOpen={openMangaChapter}
        isResume={canContinueManga && ch.id === resumeChapterId}
        hideDownload={false}
        disableThumbFetch={isExternal}
        locked={gatedChapterIds.has(ch.id)}
      />
    ),
    [
      mangaId,
      manga?.cover,
      offlineMap,
      handleDownloadChapter,
      openMangaChapter,
      canContinueManga,
      resumeChapterId,
      isExternal,
      gatedChapterIds,
    ],
  );

  const chapterKeyExtractor = useCallback((ch: MangaChapter) => ch.id, []);

  const getChapterLayout = useCallback(
    (_: ArrayLike<MangaChapter> | null | undefined, index: number) => ({
      length: CHAPTER_ITEM_H,
      offset: CHAPTER_ITEM_H * index,
      index,
    }),
    [],
  );

  const resumeChapter = canContinueManga
    ? chapters.find((c) => c.id === mangaProgress!.chapterId) ?? null
    : null;
  const playChapter = resumeChapter || firstChapter;
  const genres = manga ? (manga.genres.length > 0 ? manga.genres : [manga.type].filter(Boolean)) : [];

  const statusColor =
    (manga?.status || '').toLowerCase().includes('ongoing') ? colors.success :
    (manga?.status || '').toLowerCase().includes('complet') ? '#3B82F6' :
    colors.textSecondary;

  if (loading) return <DetailSkeleton />;

  if (!manga) {
    return (
      <View style={[s.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
        <TouchableOpacity
          style={[s.navBtn, { position: 'absolute', top: insets.top + 10, left: 16 }]}
          onPress={onTap(() => router.back())}
        >
          <BackIcon />
        </TouchableOpacity>
        <Text style={{ color: colors.textSecondary, fontSize: FontSize.md }}>Could not load manga</Text>
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
            {manga.title}
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
          <Image
            source={{ uri: manga.cover }}
            style={s.heroImg}
            contentFit="cover"
            transition={400}
            placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
          />
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0.68)', 'rgba(0,0,0,0.92)']}
            locations={[0.3, 0.52, 0.78, 1]}
            style={s.heroGrad}
          />
          <View style={s.heroContent}>
            <Text style={s.heroTitle} numberOfLines={2}>{manga.title}</Text>
            <View style={s.heroMeta}>
              {manga.status ? <View style={[s.statusDot, { backgroundColor: statusColor }]} /> : null}
              {manga.status ? <Text style={s.heroMetaTxt}>{manga.status}</Text> : null}
              {manga.status && manga.type ? <Text style={s.heroMetaSep}>·</Text> : null}
              {manga.type ? <Text style={s.heroMetaTxt}>{manga.type}</Text> : null}
            </View>
          </View>
        </View>

        {/* ── Content card ── */}
        <View style={s.card}>

          {/* Meta pills */}
          <Animated.View entering={FadeInDown.delay(40).duration(300)} style={s.metaRow}>
            {manga.rating != null && (
              <View style={s.metaPill}>
                <StarIcon goldColor={colors.gold} />
                <Text style={s.metaRating}>{manga.rating.toFixed(1)}</Text>
                <Text style={s.metaRatingSub}>/10</Text>
              </View>
            )}
            {chapters.length > 0 && (
              <View style={s.metaPill}>
                <Text style={[s.metaTxt, { fontSize: 10 }]}>📖</Text>
                <Text style={s.metaTxt}>{chapters.length} ch.</Text>
              </View>
            )}
          </Animated.View>

          {/* Genre chips */}
          {genres.length > 0 && (
            <Animated.View entering={FadeInDown.delay(70).duration(300)} style={s.genreRow}>
              {genres.slice(0, 7).map((g) => (
                <View key={g} style={s.genreChip}>
                  <Text style={s.genreChipText}>{g}</Text>
                </View>
              ))}
            </Animated.View>
          )}

          {/* Synopsis */}
          {manga.description ? (
            <Animated.View entering={FadeInDown.delay(100).duration(300)} style={s.synWrap}>
              <Text style={s.syn} numberOfLines={expanded ? undefined : 3}>{manga.description}</Text>
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
          {chapters.length > 0 && (
            <View style={s.chaptersSection}>
              <View style={s.secHeader}>
                <Text style={s.secTitle}>Chapters</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <TouchableOpacity
                    style={s.sortLink}
                    activeOpacity={0.7}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setChapterSort((prev) => (prev === 'oldest' ? 'newest' : 'oldest'));
                    }}
                  >
                    <SortIcon color={colors.primary} />
                    <Text style={s.sortLinkText}>
                      {chapterSort === 'oldest' ? 'Oldest first' : 'Newest first'}
                    </Text>
                  </TouchableOpacity>
                  <View style={s.countBadge}>
                    <Text style={s.countTxt}>{chapters.length}</Text>
                  </View>
                </View>
              </View>
              <FlatList
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
                extraData={offlineMap}
                scrollEnabled={displayedChapters.length * CHAPTER_ITEM_H > chapterListHeight}
              />
            </View>
          )}

          {/* Author tab */}
          {/* {activeTab === 'author' && creatorWallet && (
            <CreatorTab creatorWallet={creatorWallet} />
          )} */}

          <CommentsSection contentId={`manga:${mangaId}`} title="Discussion" />

          <View style={{ height: insets.bottom + (playChapter ? 118 : 24) }} />
        </View>
      </Animated.ScrollView>

      {playChapter && (
        <View style={[s.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
          <View style={s.bottomCtaRow}>
            <GlowButton
              flex
              label={
                canContinueManga && resumeChapter
                  ? `Continue · ${mangaProgress!.chapterLabel}`
                  : 'Start Reading'
              }
              onPress={() =>
                openMangaChapter(playChapter, canContinueManga && !!resumeChapter)
              }
            />
            {chapters.length > 0 && !isExternal && Platform.OS !== 'web' && (
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
        onHide={() => setToast('')}
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
