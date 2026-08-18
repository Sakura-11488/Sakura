import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInLeft,
  FadeInRight,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  runOnJS,
} from 'react-native-reanimated';
import { useRouter, useFocusEffect } from 'expo-router';
import LottieView from 'lottie-react-native';
import Svg, { Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { sendChatMessage, SakuraAiError, type ChatMessage, type ConfirmSummary } from '@/lib/sakura-ai';
import { type DiscoveryCard } from '@/lib/ai-discovery';
import { useWallet } from '@/lib/wallet/context';
import { fetchGamificationState } from '@/lib/gamification';
import {
  hasSakuraAiAccess,
  SAKURA_AI_MIN_HOLDING,
  SAKURA_AI_MIN_XP,
  formatSakuraAiRequirement,
  getSakuraAiProgress,
} from '@/lib/wallet/sakura-ai-access';
import WalletModal from '@/components/wallet/WalletModal';
import EmptyState from '@/components/ui/EmptyState';
import { onTap } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { useI18n } from '@/lib/i18n';
import {
  loadHistory,
  saveMessage,
  listThreads,
  deleteThread,
  makeThreadId,
  formatThreadTime,
  type ChatThread,
} from '@/lib/ai-history';
import { contentWidth } from '@/constants/layout';

const CARD_W = 108;
const CARD_IMG_H = 148;

/**
 * Read reactively. This was a module constant off Dimensions.get('window'),
 * captured once at bundle evaluation and never re-read — no listener exists
 * anywhere in the app. contentWidth() rather than the window width, because on
 * desktop web the sidebar is a sibling of the content column and anything sized
 * off the window overflows by exactly SIDEBAR_WIDTH.
 */
function useAiStyles() {
  const { colors } = useTheme();
  const { width: windowW } = useWindowDimensions();
  const W = Platform.OS === 'web' ? contentWidth(windowW) : windowW;
  const DRAWER_W = W * 0.82;
  return useMemo(() => ({
    DRAWER_W,
    colors,
    td: StyleSheet.create({
      wrap: { flexDirection: 'row', gap: 5, alignItems: 'center', paddingVertical: 4, paddingHorizontal: 2 },
      dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.textSecondary },
      label: { fontSize: FontSize.sm, fontFamily: Fonts.body, color: colors.textSecondary },
    }),
    mb: StyleSheet.create({
      row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 12, paddingHorizontal: Spacing.md },
      rowUser: { flexDirection: 'row-reverse' },
      avatar: {
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: `${colors.primary}20`,
        borderWidth: 1, borderColor: `${colors.primary}35`,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 2,
      },
      avatarText: { fontSize: 11, color: colors.primary },
      bubble: {
        maxWidth: W * 0.76,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingVertical: 10,
        overflow: 'hidden',
      },
      bubbleUser: { borderBottomRightRadius: 4 },
      bubbleAssistant: {
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.border,
        borderBottomLeftRadius: 4,
      },
      text: { fontSize: 14, fontFamily: Fonts.body, color: colors.textSecondary, lineHeight: 21 },
      textUser: { color: '#fff' },
    }),
    dc: StyleSheet.create({
      wrap: { marginBottom: 14 },
      header: {
        fontSize: FontSize.xs,
        fontFamily: Fonts.bodyMedium,
        color: colors.primary,
        letterSpacing: 0.2,
        marginBottom: 8,
        paddingHorizontal: Spacing.md,
      },
      row: { paddingHorizontal: Spacing.md, gap: 10 },
      card: { width: CARD_W },
      imgWrap: { position: 'relative', borderRadius: 6, overflow: 'hidden', marginBottom: 6 },
      img: { width: CARD_W, height: CARD_IMG_H, borderRadius: 6 },
      imgFallback: { backgroundColor: colors.surfaceSecondary, alignItems: 'center', justifyContent: 'center' },
      fallbackText: { fontSize: 22, color: colors.textSecondary },
      kindBadge: {
        position: 'absolute',
        top: 6, left: 6,
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
      },
      kindAnime: { backgroundColor: 'rgba(232,69,69,0.85)' },
      kindManga: { backgroundColor: 'rgba(99,102,241,0.85)' },
      kindNovel: { backgroundColor: 'rgba(16,185,129,0.85)' },
      kindText: { fontSize: 9, fontFamily: Fonts.bodyBold, color: '#fff', letterSpacing: 0.4 },
      title: { fontSize: 11.5, fontFamily: Fonts.bodyMedium, color: colors.text, lineHeight: 16 },
      meta: { fontSize: 10, fontFamily: Fonts.body, color: colors.textTertiary, marginTop: 2 },
    }),
    qc: StyleSheet.create({
      chip: {
        width: (W - Spacing.md * 2 - 10) / 2,
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: Radius.md,
        paddingHorizontal: 14,
        paddingVertical: 12,
      },
      label: { fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium, color: colors.textSecondary, lineHeight: 17 },
    }),
    dr: StyleSheet.create({
      panel: {
        position: 'absolute', right: 0, top: 0, bottom: 0,
        width: DRAWER_W,
        backgroundColor: colors.surface,
        borderLeftWidth: 1,
        borderLeftColor: colors.border,
      },
      header: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 14, paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
        gap: 10,
      },
      closeBtn: {
        width: 34, height: 34, borderRadius: 17,
        backgroundColor: colors.surfaceSecondary,
        alignItems: 'center', justifyContent: 'center',
      },
      title: { flex: 1, fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text, letterSpacing: 0.1 },
      newBtn: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        backgroundColor: `${colors.primary}18`, borderRadius: Radius.full,
        paddingHorizontal: 12, paddingVertical: 7,
        borderWidth: 1, borderColor: `${colors.primary}35`,
      },
      newBtnText: { fontSize: FontSize.xs, fontFamily: Fonts.bodyMedium, color: colors.primary },
      list: { flex: 1 },
      empty: { flex: 1, justifyContent: 'center' },
      row: {
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 14, paddingRight: 10, paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight,
        gap: 8,
      },
      rowActive: { backgroundColor: `${colors.primary}12` },
      activeDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.primary, flexShrink: 0 },
      rowContent: { flex: 1, minWidth: 0 },
      rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
      rowTitle: { flex: 1, fontSize: 13, fontFamily: Fonts.bodyMedium, color: colors.text },
      rowTime: { fontSize: 10, fontFamily: Fonts.body, color: colors.textTertiary, flexShrink: 0 },
      rowPreview: { fontSize: 11.5, fontFamily: Fonts.body, color: colors.textTertiary },
      deleteBtn: { padding: 4, flexShrink: 0 },
    }),
    gate: StyleSheet.create({
      wrap: { alignItems: 'center', paddingVertical: Spacing.lg },
      iconWrap: {
        width: 96,
        height: 96,
        borderRadius: 48,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        borderWidth: 1.5,
        borderColor: `${colors.primary}35`,
        marginBottom: 20,
      },
      lottie: { width: 72, height: 72 },
      title: {
        fontSize: 22,
        fontFamily: Fonts.display,
        fontWeight: '800',
        color: colors.text,
        textAlign: 'center',
        marginBottom: 8,
      },
      sub: {
        fontSize: 14,
        fontFamily: Fonts.body,
        color: colors.textSecondary,
        textAlign: 'center',
        lineHeight: 21,
        marginBottom: 16,
        paddingHorizontal: 8,
      },
      balance: {
        fontSize: 13,
        fontFamily: Fonts.bodyMedium,
        color: colors.text,
        marginBottom: 10,
      },
      track: {
        width: '100%',
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.surfaceSecondary,
        overflow: 'hidden',
        marginBottom: 24,
      },
      fill: {
        height: '100%',
        borderRadius: 3,
        backgroundColor: colors.primary,
      },
      primaryBtn: {
        width: '100%',
        backgroundColor: colors.primary,
        borderRadius: Radius.full,
        paddingVertical: 15,
        alignItems: 'center',
        marginBottom: 10,
      },
      primaryBtnText: {
        color: '#fff',
        fontSize: FontSize.md,
        fontFamily: Fonts.bodyBold,
      },
      secondaryBtn: {
        paddingVertical: 10,
        alignItems: 'center',
        minHeight: 36,
      },
      secondaryBtnText: {
        color: colors.primary,
        fontSize: FontSize.sm,
        fontFamily: Fonts.bodyMedium,
      },
    }),
    s: StyleSheet.create({
      root: { flex: 1, backgroundColor: colors.background },
      topGlow: { position: 'absolute', top: 0, left: 0, right: 0, height: 220, zIndex: 0 },
      header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: Spacing.md, paddingBottom: 12,
        borderBottomWidth: 1, borderBottomColor: colors.border, zIndex: 10,
        backgroundColor: colors.background,
      },
      headerBtn: {
        width: 38, height: 38, borderRadius: 19,
        backgroundColor: colors.surfaceSecondary,
        alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        borderWidth: 1,
        borderColor: colors.border,
      },
      headerCenter: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        minWidth: 0,
        marginHorizontal: 6,
      },
      headerTitles: { flex: 1, minWidth: 0 },
      lottie: { width: 40, height: 40 },
      headerTitle: { fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text, letterSpacing: 0.2 },
      betaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
      headerSub: { fontSize: 10, fontFamily: Fonts.body, color: colors.textSecondary },
      betaChip: {
        backgroundColor: `${colors.primary}22`, borderRadius: Radius.full,
        paddingHorizontal: 5, paddingVertical: 1,
        borderWidth: 1, borderColor: `${colors.primary}40`,
      },
      betaText: { fontSize: 8, fontFamily: Fonts.bodyBold, color: colors.primary, letterSpacing: 0.6 },
      scroll: { flex: 1 },
      scrollContent: { flexGrow: 1, paddingTop: 8 },
      scrollEmpty: { justifyContent: 'center' },
      welcome: { alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: Spacing.lg },
      welcomeIconWrap: {
        width: 96, height: 96, borderRadius: 48,
        alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', borderWidth: 1.5, borderColor: `${colors.primary}30`, marginBottom: 18,
      },
      welcomeLottie: { width: 72, height: 72 },
      welcomeTitle: { fontSize: 26, fontFamily: Fonts.display, fontWeight: '800', color: colors.text, letterSpacing: 0.2, marginBottom: 6 },
      welcomeSub: { fontSize: 13.5, fontFamily: Fonts.body, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 28, paddingHorizontal: 10 },
      promptGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, width: '100%' },
      inputBar: { overflow: 'hidden', zIndex: 20 },
      inputBorder: { position: 'absolute', top: 0, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
      inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingTop: 10, gap: 8 },
      input: {
        flex: 1, minHeight: 42, maxHeight: 120,
        backgroundColor: colors.surface,
        borderRadius: 22,
        borderWidth: 1, borderColor: colors.border,
        paddingHorizontal: 16, paddingVertical: 10,
        fontSize: 14, fontFamily: Fonts.body, color: colors.text, lineHeight: 20,
      },
      sendBtn: {
        width: 42, height: 42, borderRadius: 21,
        backgroundColor: colors.surfaceSecondary,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: colors.border,
      },
      sendBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    }),
  }), [colors, W, DRAWER_W]);
}

// ─── UI message union ─────────────────────────────────────────────────────────
type UiMessage =
  | { kind: 'chat'; role: 'user' | 'assistant'; content: string }
  | { kind: 'cards'; header: string; cards: DiscoveryCard[] };

// ─── Icons ────────────────────────────────────────────────────────────────────
const BackIcon = ({ color }: { color: string }) => (
  <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
    <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const SendIcon = ({ active, dimColor }: { active: boolean; dimColor: string }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
    <Path
      d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"
      stroke={active ? '#fff' : dimColor}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

const HistoryIcon = ({ color }: { color: string }) => (
  <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
    <Path d="M12 8v4l3 3" stroke={color} strokeWidth={2} strokeLinecap="round" />
    <Path d="M3.05 11a9 9 0 1 1 .5 4M3 16v-5h5" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const ComposeIcon = ({ color }: { color: string }) => (
  <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
    <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const TrashIcon = ({ color }: { color: string }) => (
  <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
    <Path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const CloseIcon = ({ color }: { color: string }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
    <Path d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);

// ─── Typing dots ──────────────────────────────────────────────────────────────
function TypingDot({ delay }: { delay: number }) {
  const { td } = useAiStyles();
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(-6, { duration: 320 }), withTiming(0, { duration: 320 })),
        -1,
      ),
    );
  }, []);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return <Animated.View style={[td.dot, style]} />;
}

function TypingDots() {
  const { td } = useAiStyles();
  return (
    <View style={td.wrap}>
      <TypingDot delay={0} />
      <TypingDot delay={160} />
      <TypingDot delay={320} />
    </View>
  );
}

const TOOL_THINKING_LABELS: Record<string, string> = {
  find_similar_anime: 'Finding similar anime…',
  find_similar_manga: 'Finding similar manga…',
  mood_pick: 'Picking recommendations…',
  remember: 'Saving to memory…',
  forget: 'Updating memory…',
  recall_memories: 'Recalling what I know…',
};

function toolThinkingLabel(name: string): string {
  return TOOL_THINKING_LABELS[name] ?? 'Looking that up…';
}

function ThinkingBubble({ label }: { label: string }) {
  const { mb, td } = useAiStyles();
  return (
    <Animated.View entering={FadeInLeft.duration(220)} style={[mb.row, { paddingHorizontal: Spacing.md }]}>
      <View style={mb.avatar}>
        <Text style={mb.avatarText}>桜</Text>
      </View>
      <View style={[mb.bubble, mb.bubbleAssistant, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
        <TypingDots />
        <Text style={td.label}>{label}</Text>
      </View>
    </Animated.View>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg, index }: { msg: { role: string; content: string }; index: number }) {
  const { mb, colors } = useAiStyles();
  const isUser = msg.role === 'user';
  const entering = isUser ? FadeInRight.duration(260) : FadeInLeft.duration(260);

  return (
    <Animated.View entering={entering} style={[mb.row, isUser && mb.rowUser]}>
      {!isUser && (
        <View style={mb.avatar}>
          <Text style={mb.avatarText}>桜</Text>
        </View>
      )}
      <View style={[mb.bubble, isUser ? mb.bubbleUser : mb.bubbleAssistant]}>
        {isUser ? (
          <LinearGradient
            colors={[colors.primary, colors.primaryLight]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <Text style={[mb.text, isUser && mb.textUser]}>{msg.content}</Text>
      </View>
    </Animated.View>
  );
}

// ─── Discovery cards ──────────────────────────────────────────────────────────
function DiscoveryCards({ header, cards }: { header: string; cards: DiscoveryCard[] }) {
  const { dc } = useAiStyles();
  const router = useRouter();
  return (
    <Animated.View entering={FadeInLeft.duration(300)} style={dc.wrap}>
      {header ? (
        <Text style={dc.header} numberOfLines={1}>{header}</Text>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={dc.row}
      >
        {cards.map((card) => (
          <TouchableOpacity
            key={`${card.kind}-${card.id}`}
            style={dc.card}
            activeOpacity={0.8}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              if (card.kind === 'anime') {
                router.push({ pathname: '/anime/[id]', params: { id: card.id } });
              } else if (card.kind === 'novel') {
                router.push({ pathname: '/novel/[id]', params: { id: card.id } });
              } else {
                router.push({ pathname: '/manga/[id]', params: { id: card.id } });
              }
            }}
          >
            <View style={dc.imgWrap}>
              {card.image ? (
                <Image source={{ uri: card.image }} style={dc.img} contentFit="cover" />
              ) : (
                <View style={[dc.img, dc.imgFallback]}>
                  <Text style={dc.fallbackText}>{card.title.slice(0, 2)}</Text>
                </View>
              )}
              <View style={[dc.kindBadge, card.kind === 'anime' ? dc.kindAnime : card.kind === 'novel' ? dc.kindNovel : dc.kindManga]}>
                <Text style={dc.kindText}>{card.kind}</Text>
              </View>
            </View>
            <Text style={dc.title} numberOfLines={2}>{card.title}</Text>
            {(card.year || card.score) ? (
              <Text style={dc.meta}>
                {[
                  card.year,
                  card.score ? `★ ${Number(card.score).toFixed(1)}` : null,
                ].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </TouchableOpacity>
        ))}
        <View style={{ width: 8 }} />
      </ScrollView>
    </Animated.View>
  );
}

// ─── Quick prompt chip ────────────────────────────────────────────────────────
function QuickChip({ label, onPress }: { label: string; onPress: () => void }) {
  const { qc } = useAiStyles();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} style={qc.chip}>
      <Text style={qc.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const QUICK_PROMPTS = [
  'Recommend something like Attack on Titan',
  "I'm in the mood for something cozy",
  "What's trending in anime right now?",
  'Give me a hidden gem manga',
  'Best novel to read tonight?',
  'Something dark and psychological',
];

// ─── History drawer ───────────────────────────────────────────────────────────
function HistoryPanel({
  visible,
  threads,
  currentThreadId,
  onSelectThread,
  onNewChat,
  onDeleteThread,
  onClose,
}: {
  visible: boolean;
  threads: ChatThread[];
  currentThreadId: string;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
  onDeleteThread: (id: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { dr, colors, DRAWER_W } = useAiStyles();
  const [mounted, setMounted] = useState(false);
  const translateX = useSharedValue(DRAWER_W);
  const overlayOpacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateX.value = withTiming(0, { duration: 300 });
      overlayOpacity.value = withTiming(1, { duration: 260 });
    } else {
      translateX.value = withTiming(DRAWER_W, { duration: 280 });
      overlayOpacity.value = withTiming(0, { duration: 260 }, (done) => {
        if (done) runOnJS(setMounted)(false);
      });
    }
    // DRAWER_W in the deps: the off-screen resting position was frozen at
    // the width the drawer was first built at, so after a resize a closed
    // drawer either left a strip on screen or slid further than it needed.
  }, [visible, DRAWER_W]);

  const drawerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlayOpacity.value }));

  if (!mounted) return null;

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }, overlayStyle]}
          pointerEvents="auto"
        >
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
        </Animated.View>

        <Animated.View style={[dr.panel, { paddingTop: insets.top, paddingBottom: insets.bottom + 12 }, drawerStyle]}>
          <View style={dr.header}>
            <TouchableOpacity onPress={onClose} style={dr.closeBtn} activeOpacity={0.75}>
              <CloseIcon color={colors.textSecondary} />
            </TouchableOpacity>
            <Text style={dr.title}>History</Text>
            <TouchableOpacity onPress={onNewChat} style={dr.newBtn} activeOpacity={0.8}>
              <ComposeIcon color={colors.primary} />
              <Text style={dr.newBtnText}>New</Text>
            </TouchableOpacity>
          </View>

          {threads.length === 0 ? (
            <EmptyState
              compact
              style={dr.empty}
              title="No chats yet."
              subtitle="Start a conversation and it'll appear here."
            />
          ) : (
            <ScrollView style={dr.list} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {threads.map((t) => (
                <TouchableOpacity
                  key={t.id}
                  style={[dr.row, t.id === currentThreadId && dr.rowActive]}
                  onPress={() => onSelectThread(t.id)}
                  activeOpacity={0.75}
                >
                  {t.id === currentThreadId && <View style={dr.activeDot} />}
                  <View style={dr.rowContent}>
                    <View style={dr.rowTop}>
                      <Text style={dr.rowTitle} numberOfLines={1}>{t.title || 'New Chat'}</Text>
                      <Text style={dr.rowTime}>{formatThreadTime(t.updatedAt)}</Text>
                    </View>
                    {t.lastMessage ? (
                      <Text style={dr.rowPreview} numberOfLines={1}>{t.lastMessage}</Text>
                    ) : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => onDeleteThread(t.id)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 4 }}
                    style={dr.deleteBtn}
                    activeOpacity={0.7}
                  >
                    <TrashIcon color={colors.textTertiary} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
              <View style={{ height: 16 }} />
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

// ─── Token gate ───────────────────────────────────────────────────────────────
function SakuraAiGate({
  connected,
  sakuraBalance,
  lifetimeXp,
  loadingBalances,
  onRefresh,
  onOpenWallet,
}: {
  connected: boolean;
  sakuraBalance: number | null;
  lifetimeXp: number | null;
  loadingBalances: boolean;
  onRefresh: () => void;
  onOpenWallet: () => void;
}) {
  const { gate, colors } = useAiStyles();
  const { t } = useI18n();
  const progress = getSakuraAiProgress(sakuraBalance, lifetimeXp);
  const balanceText =
    !connected
      ? 'Connect your Sakura wallet to verify holdings.'
      : loadingBalances && sakuraBalance === null
        ? 'Checking balance…'
        : `${(sakuraBalance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${SAKURA_AI_MIN_HOLDING.toLocaleString()} SKR  ·  ${(lifetimeXp ?? 0).toLocaleString()} / ${SAKURA_AI_MIN_XP.toLocaleString()} XP`;

  return (
    <Animated.View entering={FadeIn.duration(400)} style={gate.wrap}>
      <View style={gate.iconWrap}>
        <LinearGradient colors={['rgba(232,69,69,0.22)', 'rgba(232,69,69,0.05)']} style={StyleSheet.absoluteFill} />
        <LottieView
          source={require('@/assets/lottie/AI.json')}
          style={gate.lottie}
          autoPlay
          loop
          speed={0.65}
        />
      </View>
      <Text style={gate.title}>{t('ai.gateTitle')}</Text>
      <Text style={gate.sub}>
        Hold {formatSakuraAiRequirement()} — or reach Level 5 by reading. Either one unlocks Sakura.
      </Text>
      <Text style={gate.balance}>{balanceText}</Text>
      <View style={gate.track}>
        <View style={[gate.fill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
      <TouchableOpacity style={gate.primaryBtn} onPress={onOpenWallet} activeOpacity={0.85}>
        <Text style={gate.primaryBtnText}>{connected ? 'Get SAKURA in Wallet' : 'Connect Wallet'}</Text>
      </TouchableOpacity>
      {connected ? (
        <TouchableOpacity style={gate.secondaryBtn} onPress={onRefresh} activeOpacity={0.7} disabled={loadingBalances}>
          {loadingBalances ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <Text style={gate.secondaryBtnText}>Refresh balance</Text>
          )}
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function AIScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s, mb, colors } = useAiStyles();
  const { t } = useI18n();
  const { address, connected, sakuraBalance, refreshBalances, loadingBalances } = useWallet();
  const [walletVisible, setWalletVisible] = useState(false);
  const [lifetimeXp, setLifetimeXp] = useState<number | null>(null);
  const hasAccess = hasSakuraAiAccess(connected, sakuraBalance, lifetimeXp);

  useFocusEffect(
    useCallback(() => {
      if (!connected) return;
      refreshBalances();
      // read-gamification takes no signature, so checking the XP door here
      // never raises an unlock prompt just for opening the tab.
      if (address) fetchGamificationState(address).then((s) => setLifetimeXp(s?.xp ?? 0)).catch(() => {});
    }, [connected, refreshBalances, address]),
  );
  const scrollRef = useRef<ScrollView>(null);
  const lottieRef = useRef<LottieView>(null);

  const walletKey = address || 'local_guest';

  const [threadId, setThreadId] = useState('default');
  // chatHistory is sent to the AI; uiMessages is what renders (includes card rows)
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [uiMessages, setUiMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState('Thinking…');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{
    summary: ConfirmSummary;
    resolve: (approved: boolean) => void;
  } | null>(null);

  const requireConfirm = useCallback(
    (summary: ConfirmSummary) =>
      new Promise<boolean>((resolve) => setPendingConfirm({ summary, resolve })),
    [],
  );

  const resolveConfirm = useCallback((approved: boolean) => {
    setPendingConfirm((current) => {
      current?.resolve(approved);
      return null;
    });
  }, []);

  useEffect(() => {
    loadHistory(walletKey, threadId).then((stored) => {
      const history: ChatMessage[] = stored.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
      setChatHistory(history);
      setUiMessages(history.map((m) => ({ kind: 'chat', role: m.role as 'user' | 'assistant', content: m.content })));
    });
  }, [walletKey, threadId]);

  const scrollToBottom = useCallback((animated = true) => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated }), 80);
  }, []);

  useEffect(() => {
    if (uiMessages.length > 0 || loading) scrollToBottom();
  }, [uiMessages, loading, thinkingLabel]);

  useEffect(() => {
    if (!loading) {
      setThinkingLabel('Thinking…');
      return;
    }
    setThinkingLabel('Thinking…');
    const slow = setTimeout(() => setThinkingLabel('Still thinking…'), 2500);
    const slower = setTimeout(() => setThinkingLabel('Almost there…'), 6000);
    return () => {
      clearTimeout(slow);
      clearTimeout(slower);
    };
  }, [loading]);

  const openHistory = useCallback(async () => {
    const list = await listThreads(walletKey);
    setThreads(list);
    setHistoryOpen(true);
  }, [walletKey]);

  const handleSelectThread = useCallback((id: string) => {
    setHistoryOpen(false);
    setThreadId(id);
  }, []);

  const handleNewChat = useCallback(() => {
    setHistoryOpen(false);
    setThreadId(makeThreadId());
    setChatHistory([]);
    setUiMessages([]);
  }, []);

  const handleDeleteThread = useCallback(async (id: string) => {
    await deleteThread(walletKey, id);
    const updated = await listThreads(walletKey);
    setThreads(updated);
    if (id === threadId) setThreadId('default');
  }, [walletKey, threadId]);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading || !hasAccess) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInput('');

    const isFirst = chatHistory.length === 0;
    const userChatMsg: ChatMessage = { role: 'user', content: trimmed };
    const nextHistory = [...chatHistory, userChatMsg];

    setChatHistory(nextHistory);
    setUiMessages((prev) => [...prev, { kind: 'chat', role: 'user', content: trimmed }]);
    setLoading(true);

    saveMessage(walletKey, threadId, 'user', trimmed, isFirst).catch(() => {});

    const onToolProgress = (name: string, _args: Record<string, unknown>, result: unknown) => {
      if (result == null) {
        setThinkingLabel(toolThinkingLabel(name));
        return;
      }
      const r = result as any;
      if (Array.isArray(r?.cards) && r.cards.length > 0) {
        setUiMessages((prev) => [
          ...prev,
          { kind: 'cards', header: r.header || '', cards: r.cards },
        ]);
      }
    };

    try {
      const reply = await sendChatMessage(nextHistory, address ?? undefined, onToolProgress, requireConfirm, {
        surface: 'chat',
      });
      const assistantMsg: ChatMessage = { role: 'assistant', content: reply };
      setChatHistory((prev) => [...prev, assistantMsg]);
      setUiMessages((prev) => [...prev, { kind: 'chat', role: 'assistant', content: reply }]);
      saveMessage(walletKey, threadId, 'assistant', reply, false).catch(() => {});
    } catch (e: any) {
      console.error('[Sakura AI]', e?.message ?? e);
      // SakuraAiError carries the server's own wording — the gate copy, the
      // retry hint, the daily-limit note. Wrapping that in "Something went
      // wrong" would bury the one sentence that tells the user what to do.
      const content =
        e instanceof SakuraAiError
          ? e.message
          : `Something went wrong: ${e?.message ?? 'unknown error'}`;
      setUiMessages((prev) => [...prev, { kind: 'chat', role: 'assistant', content }]);
    } finally {
      setLoading(false);
    }
  }, [chatHistory, loading, address, walletKey, threadId, hasAccess, requireConfirm]);

  const isEmpty = uiMessages.length === 0 && !loading;

  return (
    <View style={s.root}>
      <LinearGradient
        colors={['rgba(232,69,69,0.10)', 'transparent']}
        style={s.topGlow}
        pointerEvents="none"
      />

      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={onTap(() => router.back())} style={s.headerBtn} activeOpacity={0.8}>
          <BackIcon color={colors.text} />
        </TouchableOpacity>

        <Animated.View entering={FadeIn.duration(320)} style={s.headerCenter}>
          <LottieView
            ref={lottieRef}
            source={require('@/assets/lottie/AI.json')}
            style={s.lottie}
            autoPlay loop speed={0.75}
          />
          <View style={s.headerTitles}>
            <Text style={s.headerTitle} numberOfLines={1}>Sakura AI</Text>
            <View style={s.betaRow}>
              <Text style={s.headerSub} numberOfLines={1}>Your companion</Text>
              <View style={s.betaChip}>
                <Text style={s.betaText}>BETA</Text>
              </View>
            </View>
          </View>
        </Animated.View>

        <TouchableOpacity onPress={openHistory} style={s.headerBtn} activeOpacity={0.8}>
          <HistoryIcon color={colors.text} />
        </TouchableOpacity>
      </View>

      {!hasAccess ? (
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: Spacing.md }}>
          <SakuraAiGate
            connected={connected}
            sakuraBalance={sakuraBalance}
            lifetimeXp={lifetimeXp}
            loadingBalances={loadingBalances}
            onRefresh={refreshBalances}
            onOpenWallet={() => setWalletVisible(true)}
          />
        </View>
      ) : (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          ref={scrollRef}
          style={s.scroll}
          contentContainerStyle={[s.scrollContent, isEmpty && s.scrollEmpty]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {isEmpty ? (
            <Animated.View entering={FadeIn.duration(400)} style={s.welcome}>
              <View style={s.welcomeIconWrap}>
                <LinearGradient
                  colors={['rgba(232,69,69,0.18)', 'rgba(232,69,69,0.04)']}
                  style={StyleSheet.absoluteFill}
                />
                <LottieView
                  source={require('@/assets/lottie/AI.json')}
                  style={s.welcomeLottie}
                  autoPlay loop speed={0.65}
                />
              </View>
              <Text style={s.welcomeTitle}>Hi, I'm Sakura</Text>
              <Text style={s.welcomeSub}>Ask me about anime, manga, novels — or just chat.</Text>
              <View style={s.promptGrid}>
                {QUICK_PROMPTS.map((p, i) => (
                  <Animated.View key={p} entering={FadeInDown.delay(i * 50 + 100).duration(300)}>
                    <QuickChip label={p} onPress={() => sendMessage(p)} />
                  </Animated.View>
                ))}
              </View>
            </Animated.View>
          ) : (
            <>
              <View style={{ height: 12 }} />
              {uiMessages.map((msg, i) =>
                msg.kind === 'cards' ? (
                  <DiscoveryCards key={i} header={msg.header} cards={msg.cards} />
                ) : (
                  <MessageBubble key={i} msg={msg} index={i} />
                ),
              )}
              {loading && <ThinkingBubble label={thinkingLabel} />}
              <View style={{ height: 16 }} />
            </>
          )}
        </ScrollView>

        {/* Input bar */}
        <View style={[s.inputBar, { paddingBottom: insets.bottom + 10 }]}>
          <BlurView intensity={60} tint={colors.blurTint} style={StyleSheet.absoluteFill} />
          <View style={s.inputBorder} />
          <View style={s.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={t('ai.placeholder')}
              placeholderTextColor={colors.textTertiary}
              style={s.input}
              multiline
              maxLength={1000}
              returnKeyType="default"
              onSubmitEditing={() => sendMessage(input)}
            />
            <TouchableOpacity
              onPress={() => sendMessage(input)}
              style={[s.sendBtn, input.trim().length > 0 && s.sendBtnActive]}
              activeOpacity={0.8}
              disabled={!input.trim() || loading}
            >
              {loading
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <SendIcon active={input.trim().length > 0} dimColor={colors.textTertiary} />
              }
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
      )}

      <WalletModal
        visible={walletVisible}
        onClose={() => {
          setWalletVisible(false);
          refreshBalances();
        }}
      />

      <HistoryPanel
        visible={historyOpen}
        threads={threads}
        currentThreadId={threadId}
        onSelectThread={handleSelectThread}
        onNewChat={handleNewChat}
        onDeleteThread={handleDeleteThread}
        onClose={() => setHistoryOpen(false)}
      />

      <ConfirmActionSheet pending={pendingConfirm} onResolve={resolveConfirm} />
    </View>
  );
}

// ─── On-chain confirmation sheet ──────────────────────────────────────────────
const CONFIRM_LABEL: Record<ConfirmSummary['kind'], string> = {
  transfer_sol: 'CONFIRM TRANSFER',
  send_sakura: 'CONFIRM TRANSFER',
  swap: 'CONFIRM SWAP',
  tip_creator: 'CONFIRM TIP',
};

function ConfirmActionSheet({
  pending,
  onResolve,
}: {
  pending: { summary: ConfirmSummary; resolve: (approved: boolean) => void } | null;
  onResolve: (approved: boolean) => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!pending) return null;
  const { summary } = pending;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onResolve(false)} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay }}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => onResolve(false)} />
        <Animated.View
          entering={FadeInDown.duration(220)}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            paddingHorizontal: Spacing.lg,
            paddingTop: 22,
            paddingBottom: insets.bottom + 20,
            borderTopWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ fontSize: 11, fontFamily: Fonts.bodyBold, color: colors.primary, letterSpacing: 1, marginBottom: 10 }}>
            {CONFIRM_LABEL[summary.kind]}
          </Text>
          <Text style={{ fontSize: 22, fontFamily: Fonts.display, fontWeight: '800', color: colors.text, marginBottom: 6 }}>
            {summary.title}
          </Text>
          <Text style={{ fontSize: 14, fontFamily: Fonts.body, color: colors.textSecondary, lineHeight: 20, marginBottom: 22 }}>
            {summary.detail}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              onPress={() => onResolve(false)}
              activeOpacity={0.85}
              style={{ flex: 1, paddingVertical: 15, borderRadius: Radius.full, alignItems: 'center', backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }}
            >
              <Text style={{ fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.textSecondary }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onResolve(true)}
              activeOpacity={0.85}
              style={{ flex: 1, paddingVertical: 15, borderRadius: Radius.full, alignItems: 'center', backgroundColor: colors.primary }}
            >
              <Text style={{ fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: '#fff' }}>Confirm</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 11, fontFamily: Fonts.body, color: colors.textTertiary, textAlign: 'center', marginTop: 14 }}>
            You'll be asked for biometrics to sign.
          </Text>
        </Animated.View>
      </View>
    </Modal>
  );
}
