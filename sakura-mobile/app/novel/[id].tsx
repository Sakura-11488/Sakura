import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Platform,
  useWindowDimensions,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { contentWidth, isWideWeb } from '@/constants/layout';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  Easing,
} from 'react-native-reanimated';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path, Polygon } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Spacing, Radius, FontSize, FontWeight, Shadow, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { playTap, onTap } from '@/lib/sound';
import { Library } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { HUMOUR_ME_NOVEL_ID } from '@/lib/sakura-originals';
import {
  findNovelProgressForSeries,
  subscribeReadingProgress,
  isActiveReadingProgress,
  type NovelProgress,
} from '@/lib/reader-progress';
import ResumeReadingHint from '@/components/ui/ResumeReadingHint';
import CommentsSection from '@/components/social/CommentsSection';
// import CreatorTab from '@/components/ui/CreatorTab';

/**
 * The only one of the four detail screens with no desktop branch at all.
 *
 * `W * 0.88` on a 1920px window is a ~1690px hero — taller than the viewport,
 * so the title, the chapter list and the read button all sat below the fold and
 * the page opened as a full-screen cover. manga and anime already capped at 560
 * for exactly this; novels never got the same treatment.
 *
 * Reading it through a hook rather than a module constant matters twice over:
 * the numbers follow a resize, and `isWideWeb` is no longer frozen at
 * bundle-evaluation time, which is what pinned the whole page in one layout
 * mode. W is the content width — the desktop sidebar is a sibling of this
 * column, so raw window width overflows by SIDEBAR_WIDTH.
 */
const DESKTOP_HERO_H = 560;

function useDetailMetrics() {
  const { width: windowW } = useWindowDimensions();
  return useMemo(() => {
    const wide = isWideWeb(windowW);
    const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
    const HERO_H = wide ? Math.min(W * 0.88, DESKTOP_HERO_H) : W * 0.88;
    return { wide, W, HERO_H, HEADER_TRIGGER: HERO_H - 100 };
  }, [windowW]);
}

// ─── Icons ────────────────────────────────────────────────────────────────────

const BackIcon = () => {
  const { colors } = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={colors.text} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
};

const BookmarkIcon = ({ saved }: { saved: boolean }) => {
  const { colors } = useTheme();
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill={saved ? colors.primary : 'none'}>
      <Path
        d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
        stroke={saved ? colors.primary : '#fff'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
};

const StarIcon = () => {
  const { colors } = useTheme();
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24" fill={colors.gold}>
      <Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill={colors.gold} />
    </Svg>
  );
};

const BookOpenIcon = () => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
    <Path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const LockIcon = () => {
  const { colors } = useTheme();
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24" fill="none">
      <Path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z" stroke={colors.textTertiary} strokeWidth={2} />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" stroke={colors.textTertiary} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
};

// ─── Novel detail skeleton ────────────────────────────────────────────────────
function NovelDetailSkeleton() {
  const { W, HERO_H } = useDetailMetrics();
  const { colors } = useTheme();
  const pulse = useSharedValue(0.45);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.82, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
  }, []);

  const anim = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const Block = ({
    h,
    w = '100%',
    r = 10,
    mb = 0,
  }: {
    h: number;
    w?: number | string;
    r?: number;
    mb?: number;
  }) => (
    <Animated.View
      style={[
        anim,
        { height: h, width: w as number, borderRadius: r, marginBottom: mb, backgroundColor: colors.border },
      ]}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
      <Animated.View style={[{ width: W, height: HERO_H, backgroundColor: colors.surfaceSecondary }, anim]} />
      <View
        style={{
          marginTop: -28,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          backgroundColor: colors.background,
          paddingHorizontal: Spacing.md,
          paddingTop: 22,
          paddingBottom: 22,
        }}
      >
        <Block h={18} w="48%" mb={12} />
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          <Block h={28} w={84} r={14} />
          <Block h={28} w={96} r={14} />
          <Block h={28} w={72} r={14} />
        </View>
        <Block h={74} r={14} mb={14} />
        <Block h={14} mb={8} />
        <Block h={14} mb={8} />
        <Block h={14} w="72%" mb={18} />
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 18 }}>
          <Block h={50} w="65%" r={25} />
          <Block h={50} w="32%" r={25} />
        </View>
        <Block h={18} w="38%" mb={10} />
        <View style={{ gap: 8 }}>
          <Block h={64} r={12} />
          <Block h={64} r={12} />
          <Block h={64} r={12} />
        </View>
      </View>
    </View>
  );
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const NOVELS_MAP: Record<string, any> = {
  'humour-me': {
    id: 'humour-me',
    title: 'HUMOR ME',
    cover: 'https://i.postimg.cc/t4dpCnph/IMG-20260502-WA0012.jpg',
    author: 'Sakura Original',
    status: 'ongoing',
    rating: 9.2,
    genres: ['Horror', 'Thriller', 'Supernatural', 'Mystery', 'Drama'],
    synopsis: 'They all just wanted an escape.\n\nThey all just wanted to live, be happy, and laugh, and forget the torment that suffocated them.\n\nBut little did they know something was about to take every bit of peace they had left.\n\nAnd it didn\'t want much. It wanted a good time just like them too. It wanted to be humored in ways that would cost them everything.\n\n— HUMOR ME\nA compilation of short horror stories.',
    chapters: 16,
    readers: '—',
    supabaseId: HUMOUR_ME_NOVEL_ID,
    freeUntilChapter: 17,
    isSakuraOriginal: true,
  },
  'rezero': {
    id: 'rezero',
    title: 'Re:Zero − Starting Life in Another World',
    cover: 'https://cdn.myanimelist.net/images/anime/1522/128039l.jpg',
    author: 'Tappei Nagatsuki',
    status: 'ongoing',
    rating: 8.4,
    genres: ['Fantasy', 'Drama', 'Isekai'],
    synopsis: 'When Subaru Natsuki leaves the convenience store, the last thing he expects is to be wrenched from his everyday life and dropped into a fantasy world. Things are looking grim when he\'s attacked by a few thugs, but fortunately a mysterious silver-haired girl named Satella saves him.\n\nAs a token of gratitude, Subaru offers to help find something she lost. But when they\'re both killed without warning, Subaru awakens to find himself back where he started. And like before, Satella is there to save him.',
    chapters: 43,
    readers: '2.4M',
  },
  'overlord': {
    id: 'overlord',
    title: 'Overlord',
    cover: 'https://cdn.myanimelist.net/images/anime/7/88019l.jpg',
    author: 'Kugane Maruyama',
    status: 'ongoing',
    rating: 8.1,
    genres: ['Fantasy', 'Action', 'Isekai'],
    synopsis: 'The year is 2138. Virtual reality gaming is booming, and Yggdrasil is one of the most popular online role-playing games. The game is shutting down, but when a player named Momonga decides to stay logged in until the end, he finds himself trapped in a fantasy world with his guild\'s NPCs — who have now gained their own personalities and wills.',
    chapters: 17,
    readers: '1.8M',
  },
};

const DEFAULT_NOVEL = {
  id: 'default',
  title: 'Sword Art Online',
  cover: 'https://cdn.myanimelist.net/images/anime/11/39717l.jpg',
  author: 'Reki Kawahara',
  status: 'completed',
  rating: 7.2,
  genres: ['Fantasy', 'Action', 'Adventure'],
  synopsis: 'In the year 2022, a virtual reality massively multiplayer online role-playing game called Sword Art Online (SAO) is released. With the NerveGear, players can control their in-game characters using nothing but their thoughts. But when the game is launched, players find that they cannot log out.',
  chapters: 27,
  readers: '3.2M',
};

const CHAPTER_LIST = [
  { num: 1,  title: 'Prologue: The End of the Beginning',  words: '8,200',  free: true,  read: true  },
  { num: 2,  title: 'The Other Side of the Door',          words: '10,500', free: true,  read: true  },
  { num: 3,  title: 'A New Journey Begins',                words: '9,800',  free: true,  read: false, progress: 0.42 },
  { num: 4,  title: 'Shadows in the Dark',                 words: '11,200', free: false, read: false },
  { num: 5,  title: 'The Price of Power',                  words: '12,000', free: false, read: false },
  { num: 6,  title: 'Bonds That Cannot Break',             words: '9,600',  free: false, read: false },
  { num: 7,  title: 'A Promise Made in the Rain',          words: '10,800', free: false, read: false },
  { num: 8,  title: 'Echoes of the Past',                  words: '11,400', free: false, read: false },
];

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
  const glow = useSharedValue(0.35);
  const glowR = useSharedValue(14);
  const btnScale = useSharedValue(1);

  useEffect(() => {
    glow.value = withRepeat(
      withSequence(
        withTiming(0.7, { duration: 1100, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.3, { duration: 1100, easing: Easing.inOut(Easing.sin) })
      ),
      -1
    );
    glowR.value = withRepeat(
      withSequence(
        withTiming(26, { duration: 1100, easing: Easing.inOut(Easing.sin) }),
        withTiming(10, { duration: 1100, easing: Easing.inOut(Easing.sin) })
      ),
      -1
    );
  }, []);

  const glowStyle = useAnimatedStyle(() => ({
    shadowColor: '#E84545',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: glow.value,
    shadowRadius: glowR.value,
    elevation: 12,
  }));

  const btnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: btnScale.value }],
  }));

  const handlePress = () => {
    btnScale.value = withSequence(
      withSpring(0.94, { damping: 12 }),
      withSpring(1, { damping: 10 })
    );
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    playTap();
    onPress();
  };

  return (
    <Animated.View style={[glowStyle, { borderRadius: Radius.full }, flex && gb.flex, flex && gb.shrink]}>
      <Animated.View style={[btnStyle, flex && gb.flex, flex && gb.shrink]}>
        <TouchableOpacity onPress={handlePress} activeOpacity={1} style={[gb.btn, flex && gb.flex]}>
          <View style={gb.inner}>
            <View style={gb.iconWrap}>
              <BookOpenIcon />
            </View>
            <Text style={gb.label} numberOfLines={1} ellipsizeMode="tail">
              {label}
            </Text>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

// ─── Chapter row ──────────────────────────────────────────────────────────────

function ChapterRow({
  ch,
  index,
}: {
  ch: { num: number; title: string; words: string; free: boolean; read: boolean; progress?: number };
  index: number;
}) {
  const { colors } = useTheme();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const chS = useMemo(() => StyleSheet.create({
    wrap: {
      marginBottom: 8,
      borderRadius: Radius.md,
      backgroundColor: colors.white,
      ...Shadow.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      gap: 12,
    },
    numBadge: {
      width: 36,
      height: 36,
      borderRadius: Radius.sm,
      backgroundColor: colors.primary + '18',
      alignItems: 'center',
      justifyContent: 'center',
    },
    numBadgeRead: {
      backgroundColor: colors.success + '18',
    },
    numText: {
      fontFamily: Fonts.bodyBold,
      fontSize: FontSize.sm,
      color: colors.primary,
    },
    info: { flex: 1 },
    title: {
      fontFamily: Fonts.bodyMedium,
      fontSize: FontSize.sm,
      color: colors.text,
    },
    titleLocked: {
      color: colors.textSecondary,
    },
    words: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.body,
      color: colors.textSecondary,
      marginTop: 2,
    },
    progressWrap: {
      height: 3,
      backgroundColor: colors.border,
      borderRadius: 2,
      marginTop: 6,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: colors.primary,
      borderRadius: 2,
    },
    right: {
      width: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    readDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.success,
    },
  }), [colors]);

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 45).duration(320)}
      style={[style, chS.wrap]}
    >
      <TouchableOpacity
        onPressIn={() => { scale.value = withSpring(0.97); }}
        onPressOut={() => { scale.value = withSpring(1); }}
        activeOpacity={1}
        style={chS.row}
        disabled={!ch.free}
      >
        <View style={[chS.numBadge, ch.read && chS.numBadgeRead]}>
          <Text style={chS.numText}>{ch.num}</Text>
        </View>
        <View style={chS.info}>
          <Text style={[chS.title, !ch.free && chS.titleLocked]} numberOfLines={1}>
            {ch.title}
          </Text>
          <Text style={chS.words}>{ch.words} words</Text>
          {ch.progress !== undefined && ch.progress > 0 && ch.progress < 1 && (
            <View style={chS.progressWrap}>
              <View style={[chS.progressFill, { width: `${ch.progress * 100}%` as any }]} />
            </View>
          )}
        </View>
        <View style={chS.right}>
          {ch.read ? (
            <View style={chS.readDot} />
          ) : !ch.free ? (
            <LockIcon />
          ) : null}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NovelDetail() {
  const { W, HERO_H, HEADER_TRIGGER } = useDetailMetrics();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  // const [activeTab, setActiveTab] = useState<'chapters' | 'author'>('chapters');
  // const [creatorWallet, setCreatorWallet] = useState<string | null>(null);
  const [novelProgress, setNovelProgress] = useState<NovelProgress | null>(null);
  const scrollY = useSharedValue(0);

  const novel = NOVELS_MAP[id ?? ''] ?? { ...DEFAULT_NOVEL, id: id ?? 'default' };
  const novelId = String(novel.id || id || 'default');

  const loadNovelProgress = useCallback(() => {
    findNovelProgressForSeries(novelId).then(setNovelProgress);
  }, [novelId]);

  useEffect(() => {
    loadNovelProgress();
    return subscribeReadingProgress(loadNovelProgress);
  }, [loadNovelProgress]);

  useFocusEffect(
    useCallback(() => {
      loadNovelProgress();
    }, [loadNovelProgress]),
  );
  const [chapterList, setChapterList] = useState<Array<{ num: number; title: string; words: string; free: boolean; read: boolean }>>([]);

  useEffect(() => {
    Library.isSaved(novelId, 'novel').then(setSaved);
    const t = setTimeout(() => setLoading(false), 280);
    return () => clearTimeout(t);
  }, [novelId]);

  // useEffect(() => {
  //   if (!novel.supabaseId) return;
  //   supabase
  //     .from('novels')
  //     .select('creator_wallet')
  //     .eq('id', novel.supabaseId)
  //     .maybeSingle()
  //     .then(({ data }) => { if (data?.creator_wallet) setCreatorWallet(data.creator_wallet); });
  // }, [novel.supabaseId]);

  useEffect(() => {
    if (!novel.supabaseId) {
      setChapterList(CHAPTER_LIST);
      return;
    }
    supabase
      .from('novel_chapters')
      .select('chapter_number, title, word_count')
      .eq('novel_id', novel.supabaseId)
      .eq('published', true)
      .order('chapter_number', { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        setChapterList(
          data.map((ch: any) => ({
            num: ch.chapter_number,
            title: ch.title,
            words: ch.word_count ? `${ch.word_count.toLocaleString()}` : '—',
            free: ch.chapter_number <= (novel.freeUntilChapter ?? 3),
            read: false,
          }))
        );
      });
  }, [novel.supabaseId]);

  const handleSave = async () => {
    playTap();
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const next = await Library.toggle({
      id: novelId,
      title: novel.title,
      cover: novel.cover,
      type: 'novel',
      savedAt: 0,
    });
    setSaved(next);
  };

  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  // Parallax hero
  const heroStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          scrollY.value,
          [0, HERO_H],
          [0, -HERO_H * 0.35],
          Extrapolation.CLAMP
        ),
      },
    ],
  }));

  // Sticky header appearance
  const headerOpacity = useAnimatedStyle(() => ({
    opacity: withTiming(
      interpolate(scrollY.value, [HEADER_TRIGGER, HEADER_TRIGGER + 60], [0, 1], Extrapolation.CLAMP),
      { duration: 80 }
    ),
  }));
  const statusColor = novel.status === 'completed' ? colors.success : novel.status === 'hiatus' ? colors.warning : colors.primary;

  const firstListedChapter =
    chapterList.length > 0
      ? chapterList.reduce((min, ch) => (ch.num < min.num ? ch : min))
      : null;
  const canContinueNovel =
    !!novelProgress && isActiveReadingProgress(novelProgress.progress);
  const usesNovelReader =
    canContinueNovel &&
    !!novelProgress?.path &&
    novelProgress.path !== novelId &&
    novelProgress.path.includes('/');

  const openFromChapterOne = () => {
    playTap();
    router.push(`/chapter/${novel.id}` as any);
  };

  const s = useMemo(() => StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    stickyHeader: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 20,
      overflow: 'hidden',
    },
    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      paddingVertical: 10,
    },
    navTitle: {
      flex: 1,
      fontFamily: Fonts.bodyBold,
      fontSize: FontSize.md,
      color: colors.text,
      textAlign: 'center',
      marginHorizontal: Spacing.sm,
    },
    circleBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: 'rgba(255,255,255,0.1)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    navBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: 'rgba(0,0,0,0.35)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    navBtnSaved: { backgroundColor: colors.primary },
    heroWrap: { width: W, height: HERO_H, overflow: 'hidden' },
    heroImg: { width: '100%', height: HERO_H + 60 },
    heroGrad: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '100%' },
    heroInfo: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      padding: Spacing.md,
      paddingBottom: 20,
    },
    heroTitle: {
      color: '#fff',
      fontSize: FontSize.xl,
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      lineHeight: 26,
      textShadowColor: 'rgba(0,0,0,0.5)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 8,
    },
    heroMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 6,
    },
    heroAuthor: {
      color: 'rgba(255,255,255,0.65)',
      fontSize: FontSize.sm,
      fontFamily: Fonts.body,
    },
    heroRatingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    heroRating: {
      color: colors.gold,
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyBold,
    },
    heroDot: { color: 'rgba(255,255,255,0.35)', fontSize: 12 },
    heroReaders: {
      color: 'rgba(255,255,255,0.55)',
      fontSize: FontSize.sm,
      fontFamily: Fonts.body,
    },
    body: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      marginTop: -28,
      paddingTop: 20,
      paddingBottom: 20,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      marginBottom: Spacing.md,
    },
    genreRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      flex: 1,
      marginRight: 8,
    },
    genreTag: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: Radius.full,
      backgroundColor: colors.primary + '18',
      borderWidth: 1,
      borderColor: colors.primary + '30',
    },
    genreText: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyMedium,
      color: colors.primary,
    },
    statusTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: Radius.full,
      borderWidth: 1,
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    statusText: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.bodyBold,
      textTransform: 'capitalize',
    },
    statsStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: Spacing.md,
      marginBottom: Spacing.md,
      backgroundColor: colors.white,
      borderRadius: Radius.md,
      paddingVertical: 14,
      ...Shadow.sm,
    },
    stat: { flex: 1, alignItems: 'center' },
    statValue: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.lg,
      color: colors.text,
    },
    statLabel: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.body,
      color: colors.textSecondary,
      marginTop: 2,
    },
    statDivider: {
      width: 1,
      height: 32,
      backgroundColor: colors.border,
    },
    synopsisWrap: {
      paddingHorizontal: Spacing.md,
      marginBottom: Spacing.md,
    },
    synopsisLabel: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.xs,
      color: colors.textSecondary,
      letterSpacing: 0.8,
      marginBottom: 8,
    },
    synopsis: {
      fontFamily: Fonts.body,
      fontSize: 14,
      color: colors.text,
      lineHeight: 22,
    },
    expandBtn: {
      marginTop: 6,
      alignSelf: 'flex-start',
    },
    expandText: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyMedium,
      color: colors.primary,
    },
    ctaCol: {
      paddingHorizontal: Spacing.md,
      marginBottom: Spacing.lg,
      gap: 10,
      width: '100%',
    },
    ctaRow: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: 12,
      width: '100%',
    },
    secondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
      paddingHorizontal: 18,
      paddingVertical: 12,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.primary,
      backgroundColor: colors.white,
      ...Shadow.sm,
    },
    secondaryBtnText: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyBold,
      color: colors.primary,
    },
    secondaryBtnTextSaved: {
      color: colors.primary,
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
      paddingHorizontal: Spacing.md,
    },
    chaptersHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    chaptersTitle: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: FontSize.xs,
      color: colors.text,
      letterSpacing: 0.8,
    },
    chaptersCount: {
      fontSize: FontSize.xs,
      fontFamily: Fonts.body,
      color: colors.textSecondary,
    },
    ch1Pill: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: Radius.full,
      backgroundColor: colors.primary + '18',
      borderWidth: 1,
      borderColor: colors.primary + '33',
    },
    ch1PillText: {
      fontSize: 11,
      fontFamily: Fonts.bodyBold,
      color: colors.primary,
    },
    startCh1Btn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      width: '100%',
      paddingVertical: 12,
      borderRadius: Radius.full,
      borderWidth: 1.5,
      borderColor: colors.primary,
      backgroundColor: colors.white,
    },
    startCh1BtnText: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyBold,
      color: colors.primary,
    },
    loadMoreBtn: {
      marginTop: 12,
      paddingVertical: 14,
      alignItems: 'center',
      borderRadius: Radius.md,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.white,
    },
    loadMoreText: {
      fontSize: FontSize.sm,
      fontFamily: Fonts.bodyMedium,
      color: colors.primary,
    },
  }), [colors, W, HERO_H]);

  if (loading) return <NovelDetailSkeleton />;

  if (id === 'humour-me') return null;

  return (
    <View style={s.root}>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />

      {/* ── Sticky header (appears on scroll) ── */}
      <View style={[s.stickyHeader, { paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View style={[StyleSheet.absoluteFill, headerOpacity]}>
          <BlurView intensity={80} tint={colors.blurTint} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={s.navRow}>
          <TouchableOpacity onPress={onTap(() => router.back())} style={s.navBtn} activeOpacity={1}>
            <BackIcon />
          </TouchableOpacity>
          <Animated.Text style={[s.navTitle, headerOpacity]} numberOfLines={1}>
            {novel.title}
          </Animated.Text>
          <TouchableOpacity
            onPress={handleSave}
            style={[s.navBtn, saved && s.navBtnSaved]}
            activeOpacity={1}
          >
            <BookmarkIcon saved={saved} />
          </TouchableOpacity>
        </View>
      </View>

      <Animated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        bounces
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
      >
        {/* ── Hero ── */}
        <View style={s.heroWrap}>
          <Animated.View style={[StyleSheet.absoluteFill, heroStyle]}>
            <Image
              source={{ uri: novel.cover }}
              style={s.heroImg}
              contentFit="cover"
              transition={400}
            />
          </Animated.View>

          <LinearGradient
            colors={['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.1)', 'rgba(10,8,18,0.98)']}
            locations={[0, 0.55, 1]}
            style={s.heroGrad}
          />

          {/* Hero bottom info */}
          <View style={s.heroInfo}>
            <Text style={s.heroTitle}>{novel.title}</Text>
            <View style={s.heroMeta}>
              <Text style={s.heroAuthor}>by {novel.author}</Text>
              <View style={s.heroRatingRow}>
                <StarIcon />
                <Text style={s.heroRating}>{novel.rating.toFixed(1)}</Text>
                <Text style={s.heroDot}>·</Text>
                <Text style={s.heroReaders}>{novel.readers} readers</Text>
              </View>
            </View>
          </View>
        </View>

        {/* ── Content card ── */}
        <View style={s.body}>
          {/* Genre + status row */}
          <Animated.View entering={FadeInDown.duration(340)} style={s.topRow}>
            <View style={s.genreRow}>
              {novel.genres.map((g: string) => (
                <View key={g} style={s.genreTag}>
                  <Text style={s.genreText}>{g}</Text>
                </View>
              ))}
            </View>
            <View style={[s.statusTag, { backgroundColor: statusColor + '22', borderColor: statusColor + '55' }]}>
              <View style={[s.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[s.statusText, { color: statusColor }]}>{novel.status}</Text>
            </View>
          </Animated.View>

          {/* Stats strip */}
          <Animated.View entering={FadeInDown.delay(50).duration(340)} style={s.statsStrip}>
            <View style={s.stat}>
              <Text style={s.statValue}>{novel.chapters}</Text>
              <Text style={s.statLabel}>Chapters</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.stat}>
              <Text style={s.statValue}>{novel.rating.toFixed(1)}</Text>
              <Text style={s.statLabel}>Rating</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.stat}>
              <Text style={s.statValue}>{novel.readers}</Text>
              <Text style={s.statLabel}>Readers</Text>
            </View>
          </Animated.View>

          {/* Synopsis */}
          <Animated.View entering={FadeInDown.delay(90).duration(340)} style={s.synopsisWrap}>
            <Text style={s.synopsisLabel}>SYNOPSIS</Text>
            <Text style={s.synopsis} numberOfLines={expanded ? undefined : 4}>
              {novel.synopsis}
            </Text>
            <TouchableOpacity
              onPress={() => setExpanded((v) => !v)}
              activeOpacity={0.7}
              style={s.expandBtn}
            >
              <Text style={s.expandText}>{expanded ? 'Show less' : 'Read more'}</Text>
            </TouchableOpacity>
          </Animated.View>

          {/* CTA */}
          <Animated.View entering={FadeInDown.delay(130).duration(380)} style={s.ctaCol}>
            {canContinueNovel && novelProgress && (
              <ResumeReadingHint
                chapterLabel={novelProgress.chapterLabel || 'Last chapter'}
                detail={`${Math.round(novelProgress.progress * 100)}% through chapter`}
                progress={novelProgress.progress}
                colors={colors}
              />
            )}
            <View style={s.ctaRow}>
            <GlowButton
              flex
              label={
                canContinueNovel
                  ? `Continue · ${novelProgress!.chapterLabel || 'Reading'}`
                  : 'Start Reading'
              }
              onPress={() => {
                if (usesNovelReader && novelProgress) {
                  router.push({
                    pathname: '/novel/read',
                    params: {
                      path: novelProgress.path,
                      o: String(novelProgress.progress),
                      title: novel.title,
                      cover: novel.cover,
                      chapter: novelProgress.chapterLabel || '',
                      novelPath: novelId,
                    },
                  } as any);
                } else {
                  router.push(`/chapter/${novel.id}` as any);
                }
              }}
            />
            <TouchableOpacity
              style={s.secondaryBtn}
              activeOpacity={0.8}
              onPress={() => {
                handleSave();
                playTap();
              }}
            >
              <BookmarkIcon saved={saved} />
              <Text style={[s.secondaryBtnText, saved && s.secondaryBtnTextSaved]}>
                {saved ? 'Saved' : 'Save'}
              </Text>
            </TouchableOpacity>
            </View>
            {canContinueNovel && firstListedChapter && (
              <TouchableOpacity style={s.startCh1Btn} activeOpacity={0.85} onPress={openFromChapterOne}>
                <Text style={s.startCh1BtnText}>Start from Chapter 1</Text>
              </TouchableOpacity>
            )}
          </Animated.View>

          {/* Tab switcher */}
          {/* <View style={s.tabRow}>
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
          </View> */}

          {/* Chapter list */}
          <Animated.View entering={FadeInDown.delay(160).duration(380)} style={s.chaptersSection}>
            <View style={s.chaptersHeader}>
              <Text style={s.chaptersTitle}>CHAPTERS</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {firstListedChapter && (
                  <TouchableOpacity style={s.ch1Pill} activeOpacity={0.8} onPress={openFromChapterOne}>
                    <Text style={s.ch1PillText}>Ch. 1</Text>
                  </TouchableOpacity>
                )}
                <Text style={s.chaptersCount}>{chapterList.length || novel.chapters} total</Text>
              </View>
            </View>
            {chapterList.map((ch, i) => (
              <ChapterRow key={ch.num} ch={ch} index={i} />
            ))}
          </Animated.View>

          {/* Author tab */}
          {/* {activeTab === 'author' && creatorWallet && (
            <CreatorTab creatorWallet={creatorWallet} />
          )} */}

          <CommentsSection contentId={`novel:${id}`} title="Discussion" />
        </View>

        <View style={{ height: 110 }} />
      </Animated.ScrollView>
    </View>
  );
}

// ─── Static styles (theme-independent) ───────────────────────────────────────

const gb = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { minWidth: 0 },
  btn: {
    backgroundColor: '#E84545',
    borderRadius: Radius.full,
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  iconWrap: { flexShrink: 0 },
  label: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    color: '#fff',
    fontSize: FontSize.md,
    fontFamily: Fonts.bodyBold,
  },
});
