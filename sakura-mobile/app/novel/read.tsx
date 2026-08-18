import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  useAnimatedScrollHandler,
  Extrapolation,
  runOnJS,
} from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { BlurView } from 'expo-blur';
import { Colors, Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { parseChapterContent } from '@/lib/allnovel';
import { upsertReadingActivity, endReadingActivity } from '@/lib/reading-activity';
import { getNovelReadProgress, setNovelReadProgress } from '@/lib/reader-progress';
import { recordReadingEvent } from '@/lib/gamification';
import { getOfflineNovelChapterContent } from '@/lib/novel-offline';
import { AppSettings } from '@/lib/settings';
import { playTap, onTap } from '@/lib/sound';
import ReaderAskSheet from '@/components/reader/ReaderAskSheet';
import { buildReaderContext } from '@/lib/ai-context';
import { useWallet } from '@/lib/wallet/context';

const BackIcon = () => (
  <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke={Colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const FONT_SIZES = [13, 15, 17, 19, 21];
const BG_THEMES = [
  { bg: '#FAFAF5', text: '#1A1A1A', label: 'Light' },
  { bg: '#F5F0E8', text: '#2C1F14', label: 'Sepia' },
  { bg: '#1A1A2E', text: '#E8E4D8', label: 'Dark' },
  { bg: '#0D1117', text: '#C9D1D9', label: 'Night' },
];

export default function NovelReader() {
  const { path, o, title, cover, chapter, offline, novelPath } = useLocalSearchParams<{
    path: string;
    o?: string;
    title?: string;
    cover?: string;
    chapter?: string;
    offline?: string;
    novelPath?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [fontIdx, setFontIdx] = useState(1);
  const [themeIdx, setThemeIdx] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [readingMode, setReadingMode] = useState<'page' | 'scroll'>('page');
  const [readDirection, setReadDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [readProgress, setReadProgress] = useState(0);
  const [readOffsetY, setReadOffsetY] = useState(0);
  const [restoreOffsetY, setRestoreOffsetY] = useState(0);
  const [didRestore, setDidRestore] = useState(false);
  const scrollY = useSharedValue(0);
  const lastProgress = useSharedValue(0);
  const lastOffset = useSharedValue(0);

  const decodedPath = path ? decodeURIComponent(path) : '';
  const theme = BG_THEMES[themeIdx];
  const fontSize = FONT_SIZES[fontIdx];
  const deeplinkProgress = Math.min(1, Math.max(0, Number(o || 0)));

  useEffect(() => {
    AppSettings.getReadingMode()
      .then((mode) => setReadingMode(mode === 'scroll' ? 'scroll' : 'page'))
      .catch(() => setReadingMode('page'));
    AppSettings.getReadDirection()
      .then((direction) => setReadDirection(direction === 'rtl' ? 'rtl' : 'ltr'))
      .catch(() => setReadDirection('ltr'));
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!decodedPath) return;
      const persisted = await getNovelReadProgress(decodedPath);
      if (!mounted) return;
      if (persisted?.progress) setReadProgress(persisted.progress);
      if (persisted?.offsetY) setRestoreOffsetY(persisted.offsetY);
      if (deeplinkProgress > 0 && persisted?.offsetY && persisted.progress > 0) {
        const scaledOffset = persisted.offsetY * (deeplinkProgress / persisted.progress);
        setRestoreOffsetY(Number.isFinite(scaledOffset) ? Math.max(0, scaledOffset) : persisted.offsetY);
      } else if (deeplinkProgress > 0 && !persisted?.offsetY) {
        setReadProgress(deeplinkProgress);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [decodedPath, deeplinkProgress]);

  useEffect(() => {
    if (!decodedPath) return;
    let cancelled = false;

    (async () => {
      if (offline === '1' && novelPath) {
        const local = await getOfflineNovelChapterContent(
          decodeURIComponent(novelPath),
          decodedPath,
        );
        if (cancelled) return;
        if (local) {
          setContent(local);
          setLoading(false);
          return;
        }
      }
      try {
        const text = await parseChapterContent(decodedPath);
        if (!cancelled) {
          setContent(text || 'No content available.');
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setContent('Failed to load chapter content.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [decodedPath, offline, novelPath]);

  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
    const max = e.contentSize.height - e.layoutMeasurement.height;
    if (max <= 0) return;
    const y = Math.max(0, e.contentOffset.y);
    const next = Math.min(1, Math.max(0, e.contentOffset.y / max));
    if (Math.abs(y - lastOffset.value) > 24) {
      lastOffset.value = y;
      runOnJS(setReadOffsetY)(y);
    }
    if (Math.abs(next - lastProgress.value) > 0.04) {
      lastProgress.value = next;
      runOnJS(setReadProgress)(next);
    }
  });

  const headerStyle = useAnimatedStyle(() => ({
    opacity: showControls ? withTiming(1, { duration: 200 }) : withTiming(0, { duration: 200 }),
    transform: [{ translateY: showControls ? withTiming(0, { duration: 200 }) : withTiming(-60, { duration: 200 }) }],
  }));

  const footerStyle = useAnimatedStyle(() => ({
    opacity: showControls ? withTiming(1, { duration: 200 }) : withTiming(0, { duration: 200 }),
    transform: [{ translateY: showControls ? withTiming(0, { duration: 200 }) : withTiming(60, { duration: 200 }) }],
  }));

  const { address } = useWallet();
  const [askOpen, setAskOpen] = useState(false);
  const [allowSpoilers, setAllowSpoilers] = useState(false);

  const novelTitle = typeof title === 'string' && title ? title : '';
  const novelCover = typeof cover === 'string' ? cover : undefined;
  const chapterTitle =
    typeof chapter === 'string' && chapter
      ? chapter
      : decodedPath.split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? '';
  const displayTitle = novelTitle || chapterTitle;

  /**
   * What Sakura is looking at, for a novel.
   *
   * Novels have no numeric chapter list here — the route is path-based and
   * `novelPath` identifies the series, not an ordered index — so chapterNumber
   * is left null on purpose and buildReaderContext parses the label instead.
   * That is the same fallback the manga reader relies on whenever its chapter
   * list has not resolved, and since E2 it refuses to guess rather than
   * grabbing a number out of the title.
   *
   * No dispatchExtra: turning "chapter 40" into a target needs an ordered
   * chapter list, which this reader does not have. open_in_app's series and tab
   * targets still work through the shared dispatcher.
   */
  const aiContext = useMemo(
    () =>
      buildReaderContext({
        medium: 'novel',
        seriesId: typeof novelPath === 'string' && novelPath ? novelPath : undefined,
        seriesTitle: novelTitle || undefined,
        chapterId: decodedPath || undefined,
        chapterLabel: chapterTitle || undefined,
        chapterNumber: null,
        allowSpoilers,
      }),
    [novelPath, novelTitle, decodedPath, chapterTitle, allowSpoilers],
  );

  useEffect(() => {
    if (loading || !decodedPath) return;
    upsertReadingActivity(
      {
        title: 'Novel Reader',
        subtitle: chapterTitle || 'Reading chapter',
        progressText: `${Math.round(readProgress * 100)}%`,
        progressPercent: readProgress,
        kind: 'novel',
      },
      decodedPath
        ? `sakura://novel/read?path=${encodeURIComponent(decodedPath)}&o=${readProgress.toFixed(3)}`
        : undefined,
    );
  }, [chapterTitle, decodedPath, loading, readProgress]);

  useEffect(() => {
    if (loading || !decodedPath) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
      setNovelReadProgress(decodedPath, {
        offsetY: readOffsetY,
        progress: readProgress,
        title: displayTitle,
        cover: novelCover,
        chapterLabel: chapterTitle,
        novelSeriesPath: novelPath ? decodeURIComponent(novelPath) : undefined,
      });
    }, 300);
  }, [decodedPath, loading, readOffsetY, readProgress, displayTitle, novelCover, chapterTitle]);

  useEffect(() => {
    if (loading || didRestore || !decodedPath) return;
    if (restoreOffsetY <= 0) {
      setDidRestore(true);
      return;
    }
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: restoreOffsetY, animated: false });
      setDidRestore(true);
    }, 80);
    return () => clearTimeout(t);
  }, [decodedPath, didRestore, loading, restoreOffsetY]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (decodedPath) {
        setNovelReadProgress(decodedPath, {
          offsetY: readOffsetY,
          progress: readProgress,
          title: displayTitle,
          cover: novelCover,
          chapterLabel: chapterTitle,
          novelSeriesPath: novelPath ? decodeURIComponent(novelPath) : undefined,
        });
      }
      endReadingActivity();
    };
  }, [decodedPath, readOffsetY, readProgress, displayTitle, novelCover, chapterTitle]);

  // ── Reading gamification: report the read on exit (dwell + completion). ──
  const novelGamStartRef = useRef(Date.now());
  const novelGamProgressRef = useRef(0);
  useEffect(() => {
    novelGamStartRef.current = Date.now();
  }, [decodedPath]);
  useEffect(() => {
    novelGamProgressRef.current = readProgress;
  });
  useEffect(() => {
    return () => {
      if (!decodedPath) return;
      const series = novelPath ? decodeURIComponent(novelPath) : decodedPath;
      const progress = novelGamProgressRef.current;
      void recordReadingEvent({
        kind: 'novel',
        contentId: series,
        chapterId: decodedPath,
        seriesId: series,
        progress,
        dwellMs: Date.now() - novelGamStartRef.current,
        completed: progress >= 0.9,
      });
    };
  }, [decodedPath, novelPath]);

  const topPad = insets.top;
  const botPad = insets.bottom;

  return (
    <View style={[s.root, { backgroundColor: theme.bg }]}>
      {/* Header — BlurView + inset-aware padding applied directly */}
      <Animated.View style={[s.header, headerStyle]}>
        <BlurView
          intensity={80}
          tint={themeIdx >= 2 ? 'dark' : 'systemMaterialLight'}
          style={StyleSheet.absoluteFill}
        />
        <View style={[s.headerRow, { paddingTop: topPad + 6 }]}>
          <TouchableOpacity onPress={onTap(() => router.back())} style={s.headerBtn}>
            <BackIcon />
          </TouchableOpacity>
          <Text style={[s.headerTitle, { color: theme.text }]} numberOfLines={1}>
            {displayTitle}
          </Text>
          <View style={s.fontControls}>
            <TouchableOpacity
              onPress={() => { playTap(); setFontIdx((i) => Math.max(0, i - 1)); }}
              style={s.fontBtn}
              disabled={fontIdx === 0}
            >
              <Text style={[s.fontBtnText, { color: fontIdx === 0 ? Colors.textTertiary : Colors.primary }]}>A-</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { playTap(); setFontIdx((i) => Math.min(FONT_SIZES.length - 1, i + 1)); }}
              style={s.fontBtn}
              disabled={fontIdx === FONT_SIZES.length - 1}
            >
              <Text style={[s.fontBtnText, { color: fontIdx === FONT_SIZES.length - 1 ? Colors.textTertiary : Colors.primary }]}>A+</Text>
            </TouchableOpacity>
            {/* Ask about the chapter without leaving it. Inside the header's
                Animated.View, so it fades with the controls rather than
                becoming invisible-but-tappable. */}
            <TouchableOpacity onPress={onTap(() => setAskOpen(true))} style={s.askBtn}>
              <Text style={s.askBtnText}>Ask</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Animated.View>

      {/* Content */}
      {loading ? (
        <View style={[s.center, { paddingTop: topPad }]}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={[s.loadingText, { color: theme.text }]}>Loading chapter...</Text>
        </View>
      ) : (
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          pagingEnabled={readingMode === 'page'}
          decelerationRate={readingMode === 'page' ? 'fast' : 'normal'}
          contentContainerStyle={[s.scroll, { paddingTop: topPad + 56, paddingBottom: botPad + 80 }]}
          onTouchEnd={() => setShowControls((v) => !v)}
        >
          <Text
            style={[
              s.body,
              {
                fontSize,
                color: theme.text,
                textAlign: readDirection === 'rtl' ? 'right' : 'left',
                writingDirection: readDirection,
              },
            ]}
          >
            {content}
          </Text>
        </Animated.ScrollView>
      )}

      {/* Footer — inset-aware padding applied directly */}
      <Animated.View style={[s.footer, footerStyle]}>
        <BlurView
          intensity={80}
          tint={themeIdx >= 2 ? 'dark' : 'systemMaterialLight'}
          style={StyleSheet.absoluteFill}
        />
        <View style={[s.footerRow, { paddingBottom: botPad + 6 }]}>
          <Text style={[s.footerLabel, { color: theme.text, opacity: 0.5 }]}>Theme</Text>
          {BG_THEMES.map((t, i) => (
            <TouchableOpacity
              key={t.label}
              onPress={() => setThemeIdx(i)}
              style={[
                s.themeChip,
                { backgroundColor: t.bg, borderColor: i === themeIdx ? Colors.primary : Colors.border },
              ]}
            >
              <Text style={[s.themeChipText, { color: t.text }]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Animated.View>

      <ReaderAskSheet
        visible={askOpen}
        onClose={() => setAskOpen(false)}
        context={aiContext}
        walletAddress={address ?? undefined}
        allowSpoilers={allowSpoilers}
        onChangeAllowSpoilers={setAllowSpoilers}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    gap: 8,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  askBtn: {
    marginLeft: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(232,69,69,0.85)',
  },
  askBtnText: {
    color: Colors.white,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  headerTitle: {
    flex: 1,
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyMedium,
    textAlign: 'center',
    textTransform: 'capitalize',
  },
  fontControls: { flexDirection: 'row', gap: 4 },
  fontBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.sm,
    backgroundColor: Colors.primary + '15',
  },
  fontBtnText: {
    fontSize: FontSize.sm,
    fontFamily: Fonts.bodyBold,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontFamily: Fonts.body, fontSize: FontSize.sm },
  scroll: {
    paddingHorizontal: 22,
  },
  body: {
    fontFamily: Fonts.body,
    lineHeight: 30,
    letterSpacing: 0.2,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    overflow: 'hidden',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    gap: 8,
  },
  footerLabel: {
    fontSize: FontSize.xs,
    fontFamily: Fonts.bodyMedium,
    marginRight: 4,
  },
  themeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  themeChipText: {
    fontSize: 11,
    fontFamily: Fonts.bodyMedium,
  },
});
