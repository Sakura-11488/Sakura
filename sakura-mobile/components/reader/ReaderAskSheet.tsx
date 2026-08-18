import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { sendChatMessage, SakuraAiError, READER_CAPABILITIES, type ChatMessage } from '@/lib/sakura-ai';
import { describeContext, type SakuraContext } from '@/lib/ai-context';

const ACCENT = '#E84545';

export interface ReaderAskSheetProps {
  visible: boolean;
  onClose: () => void;
  /** What the user is looking at. Rebuilt by the reader on every render so the
   *  chapter number is never stale by the time a question is asked. */
  context: SakuraContext;
  walletAddress?: string;
  allowSpoilers: boolean;
  onChangeAllowSpoilers: (value: boolean) => void;
  /**
   * Reader-owned tools. `open_in_app` for a chapter needs the reader's loaded
   * chapter list to turn a number into an id, which lib/sakura-ai.ts cannot do.
   * Must return an object for every tool it owns — returning undefined falls
   * through to the shared dispatcher, which answers "Unknown tool".
   */
  dispatchExtra?: (name: string, args: Record<string, any>) => Promise<unknown> | unknown;
}

type DiscoveryCard = { kind: string; id: string; title: string; image?: string; route: string };

/**
 * A turn is either something said, or a row of cards a tool produced.
 *
 * The system prompt tells the model "discovery results render as cards
 * automatically — do NOT list the titles yourself". That instruction is only
 * true if the surface actually renders them; without this the reader would show
 * "here are a few you might like" followed by nothing at all.
 */
type Turn =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'cards'; header: string; cards: DiscoveryCard[] }
  /**
   * Shown to the reader, never sent back to the model.
   *
   * Errors used to be pushed in as `assistant` turns, and `history` is built
   * from those — so after a 402 the next request carried an assistant message
   * reading "Sakura AI is for holders and readers…" and the model would happily
   * elaborate on its own error copy as though it had said it. app/ai.tsx always
   * kept this split (errors to uiMessages, never chatHistory); the reader did
   * not.
   */
  | { role: 'error'; content: string };

/** The only turns that are conversation. Cards are a rendering of a tool result
 *  the model already has, and errors are ours, not its. */
function isSpeech(t: Turn): t is { role: 'user' | 'assistant'; content: string } {
  return t.role === 'user' || t.role === 'assistant';
}

const SUGGESTIONS = [
  'Recap this chapter',
  'Who is this character again?',
  'Is there an anime?',
];

/**
 * Ask Sakura about the chapter you are on, without leaving it.
 *
 * A plain RN Modal rather than a bottom-sheet library: the reader is a
 * scroll-position-sensitive screen and this must not push a route.
 * `router.push('/ai')` would unmount ChapterReader, discarding segments, scroll
 * offset and the continuous-chapter session — and because the reader never
 * calls `router.setParams`, a remount restores to the page you *entered* on,
 * not the page you were reading.
 *
 * The conversation is deliberately per-open and in-memory. This is a "what's
 * going on here" sidebar, not a second chat history to reconcile with /ai.
 */
export default function ReaderAskSheet({
  visible,
  onClose,
  context,
  walletAddress,
  allowSpoilers,
  onChangeAllowSpoilers,
  dispatchExtra,
}: ReaderAskSheetProps) {
  const { colors } = useTheme();
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  /**
   * The transcript, mirrored in a ref.
   *
   * `setTurns(next)` built from the `turns` in scope is a snapshot
   * replacement: anything appended while the request was in flight — a card row
   * from a tool result, say — is silently overwritten by a list that predates
   * it. Every mutation goes through `pushTurn`, which advances the ref
   * synchronously, so a concurrent append can never lose a message.
   */
  const turnsRef = useRef<Turn[]>([]);
  const pushTurn = useCallback((...added: Turn[]) => {
    turnsRef.current = [...turnsRef.current, ...added];
    setTurns(turnsRef.current);
  }, []);
  /**
   * Bumped by every reset, captured by every send.
   *
   * A reset can land while a request is in flight — closing the sheet does it,
   * and so does E13's navigation, which closes the sheet *because* the tool
   * succeeded. Without this the reply arrives afterwards and is appended to the
   * transcript it was supposed to have been discarded with, so reopening the
   * sheet shows an orphan answer to a question that is no longer on screen —
   * or, after a chapter jump, an answer about chapter 47 sitting under a
   * chapter-52 header.
   */
  const genRef = useRef(0);
  const resetTurns = useCallback(() => {
    genRef.current += 1;
    turnsRef.current = [];
    setTurns([]);
  }, []);

  /** `busy` in the render closure is stale for two taps dispatched in one
   *  batch — and the suggestion chips had no guard at all. */
  const busyRef = useRef(false);

  /**
   * E10 — the transcript is per-open and per-chapter, which the doc comment
   * claimed but nothing implemented. The sheet never unmounts, and
   * goToAdjacentChapter uses router.replace precisely so the reader does *not*
   * remount, so a chapter-47 conversation stayed on screen — and kept being
   * resent as history — while the context block said chapter 52. Worse if
   * spoilers were on earlier: that content sits in the transcript under a fresh
   * SPOILER GUARD: ON header.
   */
  useEffect(() => {
    if (!visible) resetTurns();
  }, [visible, resetTurns]);

  useEffect(() => {
    resetTurns();
  }, [context.chapterId, context.seriesId, resetTurns]);

  const subtitle = describeContext(context);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busyRef.current) return;
      busyRef.current = true;
      const gen = genRef.current;

      setInput('');
      pushTurn({ role: 'user', content: trimmed });
      setBusy(true);
      setThinking('');
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

      /**
       * E12 — cards are held until the reply arrives.
       *
       * Tool results come back mid-turn and the framing sentence only in the
       * final hop, so appending cards as they arrive put them *above* the
       * sentence introducing them: question → cards → "here are a few you might
       * like". Buffering costs nothing and reads correctly.
       */
      const pendingCards: Turn[] = [];

      try {
        const history: ChatMessage[] = turnsRef.current
          .filter(isSpeech)
          .map((t) => ({ role: t.role, content: t.content }));
        const reply = await sendChatMessage(
          history,
          walletAddress,
          (name, _args, result) => {
            if (result == null) {
              setThinking(labelForTool(name));
              return;
            }
            /**
             * E13 — a navigation that succeeded must not happen behind the
             * sheet.
             *
             * Only the reader's own chapter branch used to close it, so
             * `target: 'series'` and every tab target pushed a route while the
             * modal still covered the screen: nothing appeared to happen, and
             * backing out returned to the chapter the user started on. This
             * callback sees the result of *every* tool call — the reader's
             * dispatchExtra and the shared dispatcher alike — so it is the one
             * place that covers all targets. Gated on ok, so a refusal
             * ("Chapter 47 isn't in this series' list") stays on screen.
             */
            if (name === 'open_in_app' && (result as { ok?: boolean })?.ok === true) onClose();

            const cards = (result as { cards?: DiscoveryCard[]; header?: string })?.cards;
            if (Array.isArray(cards) && cards.length > 0) {
              pendingCards.push({
                role: 'cards',
                header: (result as { header?: string }).header || '',
                cards: cards.slice(0, 8),
              });
            }
          },
          undefined, // no confirmation flow: the reader never gets money tools
          {
            capabilities: READER_CAPABILITIES,
            surface: 'reader',
            // Rebuilt from props on every send, so flipping the spoiler switch
            // mid-conversation actually changes the guard rather than leaving
            // the first turn's boundary in force.
            context: { ...context, allowSpoilers },
            dispatchExtra,
          },
        );
        // Sentence first, then the cards it introduces — and only if this
        // conversation is still the one on screen.
        if (genRef.current === gen) pushTurn({ role: 'assistant', content: reply }, ...pendingCards);
      } catch (e: any) {
        // SakuraAiError already carries the server's own wording — the gate
        // copy, the retry hint. Rewriting it here would bury the one sentence
        // that tells the user what to do. It goes in as an `error` turn so it
        // is shown but never replayed to the model as its own speech.
        const content =
          e instanceof SakuraAiError ? e.message : `Something went wrong: ${e?.message ?? 'unknown error'}`;
        if (genRef.current === gen) pushTurn({ role: 'error', content });
      } finally {
        busyRef.current = false;
        setBusy(false);
        setThinking('');
        requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      }
    },
    [walletAddress, context, allowSpoilers, dispatchExtra, pushTurn, onClose],
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.fill}
        // `padding` is right on iOS; on Android the window resizes itself, and
        // on web the behaviour prop makes the card jump on focus.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          <Animated.View
            entering={FadeInDown.duration(200)}
            style={[s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          >
            <View style={s.header}>
              <View style={s.headerText}>
                <Text style={[s.title, { color: colors.text }]}>Ask Sakura</Text>
                {subtitle ? (
                  <Text style={[s.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={10} activeOpacity={0.7}>
                <Text style={[s.close, { color: colors.textSecondary }]}>Done</Text>
              </TouchableOpacity>
            </View>

            {/* The prompt tells the user to "flip the spoiler toggle in this
                sheet" when it refuses. That instruction has to be true. */}
            <View style={[s.spoilerRow, { borderColor: colors.borderLight }]}>
              <View style={s.headerText}>
                <Text style={[s.rowTitle, { color: colors.text }]}>
                  {allowSpoilers ? 'Spoilers allowed' : 'Spoiler-safe'}
                </Text>
                <Text style={[s.rowSub, { color: colors.textSecondary }]}>
                  {allowSpoilers
                    ? 'Sakura may discuss anything, including later chapters.'
                    : context.chapterNumber != null
                      ? `Nothing past chapter ${context.chapterNumber}.`
                      : 'Nothing past where you are.'}
                </Text>
              </View>
              <Switch
                value={allowSpoilers}
                onValueChange={onChangeAllowSpoilers}
                trackColor={{ true: ACCENT, false: colors.surfaceSecondary }}
              />
            </View>

            <ScrollView
              ref={scrollRef}
              style={s.log}
              contentContainerStyle={s.logContent}
              keyboardShouldPersistTaps="handled"
            >
              {turns.length === 0 ? (
                <View style={s.suggestions}>
                  {SUGGESTIONS.map((q) => (
                    <TouchableOpacity
                      key={q}
                      style={[s.chip, { borderColor: colors.borderLight }]}
                      activeOpacity={0.8}
                      onPress={() => ask(q)}
                    >
                      <Text style={[s.chipText, { color: colors.textSecondary }]}>{q}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                turns.map((t, i) =>
                  t.role === 'cards' ? (
                    <View key={i} style={s.cardRowWrap}>
                      {t.header ? (
                        <Text style={[s.cardHeader, { color: colors.textSecondary }]}>{t.header}</Text>
                      ) : null}
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.cardRow}>
                        {t.cards.map((c) => (
                          <TouchableOpacity
                            key={`${c.kind}:${c.id}`}
                            style={s.discCard}
                            activeOpacity={0.85}
                            // Leaving the reader here is fine — it is a deliberate
                            // tap on a recommendation, not the sheet navigating on
                            // its own. Close first so the reader is not left with a
                            // modal over a screen that is unmounting.
                            onPress={() => {
                              onClose();
                              router.push(c.route as never);
                            }}
                          >
                            {c.image ? (
                              <Image source={{ uri: c.image }} style={s.discImg} contentFit="cover" />
                            ) : (
                              <View style={[s.discImg, { backgroundColor: colors.surfaceSecondary }]} />
                            )}
                            <Text style={[s.discTitle, { color: colors.text }]} numberOfLines={2}>
                              {c.title}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  ) : t.role === 'error' ? (
                    <View
                      key={i}
                      style={[s.bubble, s.aiBubble, s.errorBubble, { borderColor: ACCENT }]}
                    >
                      <Text style={[s.bubbleText, { color: colors.textSecondary }]}>{t.content}</Text>
                    </View>
                  ) : (
                    <View
                      key={i}
                      style={[
                        s.bubble,
                        t.role === 'user'
                          ? [s.userBubble, { backgroundColor: ACCENT }]
                          : [s.aiBubble, { backgroundColor: colors.surfaceSecondary }],
                      ]}
                    >
                      <Text style={[s.bubbleText, { color: t.role === 'user' ? '#fff' : colors.text }]}>
                        {t.content}
                      </Text>
                    </View>
                  ),
                )
              )}
              {busy ? (
                <View style={s.thinking}>
                  <ActivityIndicator size="small" color={ACCENT} />
                  <Text style={[s.thinkingText, { color: colors.textSecondary }]}>
                    {thinking || 'Thinking…'}
                  </Text>
                </View>
              ) : null}
            </ScrollView>

            <View style={[s.inputRow, { borderColor: colors.borderLight }]}>
              <TextInput
                style={[s.input, { color: colors.text }]}
                value={input}
                onChangeText={setInput}
                placeholder="Ask about this chapter…"
                placeholderTextColor={colors.textSecondary}
                onSubmitEditing={() => ask(input)}
                returnKeyType="send"
                editable={!busy}
                multiline={false}
              />
              <TouchableOpacity
                style={[s.send, { backgroundColor: input.trim() && !busy ? ACCENT : colors.surfaceSecondary }]}
                onPress={() => ask(input)}
                disabled={!input.trim() || busy}
                activeOpacity={0.85}
              >
                <Text style={[s.sendText, { color: input.trim() && !busy ? '#fff' : colors.textSecondary }]}>
                  Ask
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function labelForTool(name: string): string {
  switch (name) {
    case 'series_facts':
      return 'Checking the series…';
    case 'my_progress':
      return 'Checking where you are…';
    case 'open_in_app':
      return 'Taking you there…';
    case 'find_similar_manga':
    case 'find_similar_anime':
    case 'find_similar_novels':
    case 'mood_pick':
    case 'recommend_for_me':
      return 'Looking for something…';
    default:
      return 'Thinking…';
  }
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '82%',
    borderRadius: 28,
    borderWidth: 1,
    padding: 22,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerText: { flex: 1 },
  title: {
    fontFamily: Fonts.display,
    fontWeight: Fonts.displayWeight,
    fontSize: 20,
  },
  subtitle: { fontSize: FontSize.xs, marginTop: 2 },
  close: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, paddingTop: 4 },
  spoilerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    marginTop: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  rowTitle: { fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  rowSub: { fontSize: FontSize.xs, marginTop: 2, lineHeight: 16 },
  log: { marginTop: 12, minHeight: 120 },
  logContent: { paddingBottom: 8, gap: 10 },
  suggestions: { gap: 8, paddingTop: 4 },
  chip: {
    borderWidth: 1,
    borderRadius: Radius.full,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: FontSize.sm },
  bubble: { borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14, maxWidth: '88%' },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: 6 },
  aiBubble: { alignSelf: 'flex-start', borderBottomLeftRadius: 6 },
  bubbleText: { fontSize: FontSize.sm, lineHeight: 20 },
  errorBubble: { borderWidth: 1, backgroundColor: 'transparent' },
  cardRowWrap: { gap: 6 },
  cardHeader: { fontSize: FontSize.xs },
  cardRow: { gap: 10, paddingRight: 8 },
  discCard: { width: 96 },
  discImg: { width: 96, height: 132, borderRadius: 12, marginBottom: 6 },
  discTitle: { fontSize: FontSize.xs, lineHeight: 15 },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  thinkingText: { fontSize: FontSize.xs },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 4,
  },
  input: { flex: 1, fontSize: FontSize.sm, paddingVertical: 8 },
  send: { borderRadius: Radius.full, paddingVertical: 10, paddingHorizontal: 18 },
  sendText: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
});
