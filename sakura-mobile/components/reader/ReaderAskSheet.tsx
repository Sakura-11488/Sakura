import React, { useCallback, useRef, useState } from 'react';
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

type Turn = { role: 'user' | 'assistant'; content: string };

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
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const subtitle = describeContext(context);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;

      setInput('');
      const next: Turn[] = [...turns, { role: 'user', content: trimmed }];
      setTurns(next);
      setBusy(true);
      setThinking('');
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

      try {
        const history: ChatMessage[] = next.map((t) => ({ role: t.role, content: t.content }));
        const reply = await sendChatMessage(
          history,
          walletAddress,
          (name) => setThinking(labelForTool(name)),
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
        setTurns((prev) => [...prev, { role: 'assistant', content: reply }]);
      } catch (e: any) {
        // SakuraAiError already carries the server's own wording — the gate
        // copy, the retry hint. Rewriting it here would bury the one sentence
        // that tells the user what to do.
        const content =
          e instanceof SakuraAiError ? e.message : `Something went wrong: ${e?.message ?? 'unknown error'}`;
        setTurns((prev) => [...prev, { role: 'assistant', content }]);
      } finally {
        setBusy(false);
        setThinking('');
        requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      }
    },
    [busy, turns, walletAddress, context, allowSpoilers, dispatchExtra],
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
                turns.map((t, i) => (
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
                ))
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
