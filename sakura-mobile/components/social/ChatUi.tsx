import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Platform,
  type TextInputProps,
} from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { hasPlayedEntrance, markEntrancePlayed } from '@/lib/chat-entrance';
import { parseChatMedia } from '@/lib/chat-media';

export function ChatBubble({
  listKey,
  content,
  isMine,
  time,
  readStatus,
  isFirstInGroup,
  isLastInGroup,
  showMeta,
  animate,
  pending,
}: {
  listKey: string;
  content: string;
  isMine: boolean;
  time?: string;
  readStatus?: 'sent' | 'read' | null;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  showMeta?: boolean;
  animate?: boolean;
  pending?: boolean;
}) {
  const { colors, isDark } = useTheme();
  const playedOnMount = useRef(hasPlayedEntrance(listKey)).current;
  const entranceStartedRef = useRef(false);
  const opacity = useSharedValue(playedOnMount || !animate ? 1 : 0);
  const translateY = useSharedValue(playedOnMount || !animate ? 0 : isMine ? 10 : -10);

  useEffect(() => {
    if (!animate) {
      opacity.value = 1;
      translateY.value = 0;
      return;
    }
    if (entranceStartedRef.current) return;
    if (hasPlayedEntrance(listKey)) {
      opacity.value = 1;
      translateY.value = 0;
      return;
    }
    entranceStartedRef.current = true;
    markEntrancePlayed(listKey);
    opacity.value = 0;
    translateY.value = isMine ? 10 : -10;
    opacity.value = withTiming(1, { duration: 220 });
    translateY.value = withSpring(0, { damping: 16, stiffness: 200 });
  }, [animate, isMine, listKey]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const media = parseChatMedia(content);
  const receivedBg = isDark ? colors.surfaceSecondary : '#E9E9EB';
  const receivedText = colors.text;

  const radius = {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: isMine ? 18 : isLastInGroup ? 4 : 18,
    borderBottomRightRadius: isMine ? (isLastInGroup ? 4 : 18) : 18,
  };

  const statusLabel =
    pending
      ? 'Sending'
      : isMine && readStatus === 'read'
        ? 'Read'
        : isMine && readStatus === 'sent'
          ? 'Delivered'
          : null;

  if (media) {
    const maxW = 220;
    const aspect =
      media.width && media.height && media.width > 0
        ? media.height / media.width
        : 1;
    const mediaW = maxW;
    const mediaH = Math.min(280, Math.max(96, mediaW * aspect));

    return (
      <Animated.View
        style={[
          bubble.row,
          isMine && bubble.rowMine,
          isFirstInGroup ? bubble.rowFirst : bubble.rowContinued,
          animStyle,
        ]}
      >
        <View style={[bubble.mediaWrap, pending && { opacity: 0.72 }]}>
          <Image
            source={{ uri: media.url }}
            recyclingKey={media.url}
            style={{
              width: mediaW,
              height: mediaH,
              borderRadius: 16,
              backgroundColor: colors.surfaceSecondary,
            }}
            contentFit="cover"
            autoplay
          />
          {showMeta && (time || statusLabel) ? (
            <View style={[bubble.metaRow, bubble.mediaMeta]}>
              {time ? (
                <Text style={[bubble.time, { color: colors.textTertiary }]}>{time}</Text>
              ) : null}
              {statusLabel ? (
                <Text style={[bubble.read, { color: colors.textTertiary }]}>{statusLabel}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[
        bubble.row,
        isMine && bubble.rowMine,
        isFirstInGroup ? bubble.rowFirst : bubble.rowContinued,
        animStyle,
      ]}
    >
      <View
        style={[
          bubble.bubble,
          radius,
          isMine
            ? { backgroundColor: colors.primary }
            : { backgroundColor: receivedBg },
          pending && { opacity: 0.72 },
        ]}
      >
        <Text style={[bubble.text, { color: isMine ? '#fff' : receivedText }]}>{content}</Text>
        {showMeta && (time || statusLabel) ? (
          <View style={bubble.metaRow}>
            {time ? (
              <Text
                style={[
                  bubble.time,
                  { color: isMine ? 'rgba(255,255,255,0.72)' : colors.textTertiary },
                ]}
              >
                {time}
              </Text>
            ) : null}
            {statusLabel ? (
              <Text style={[bubble.read, { color: 'rgba(255,255,255,0.72)' }]}>{statusLabel}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

function TypingDot({ delay }: { delay: number }) {
  const { colors } = useTheme();
  const y = useSharedValue(0);

  useEffect(() => {
    y.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(-4, { duration: 260 }), withTiming(0, { duration: 260 })),
        -1,
        false,
      ),
    );
  }, [delay, y]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
  }));

  return (
    <Animated.View
      style={[typing.dot, { backgroundColor: colors.textTertiary }, style]}
    />
  );
}

export function TypingIndicator() {
  const { colors, isDark } = useTheme();
  const receivedBg = isDark ? colors.surfaceSecondary : '#E9E9EB';

  return (
    <Animated.View entering={FadeInDown.duration(180)} style={typing.wrap}>
      <View style={[typing.bubble, { backgroundColor: receivedBg }]}>
        <TypingDot delay={0} />
        <TypingDot delay={120} />
        <TypingDot delay={240} />
      </View>
    </Animated.View>
  );
}

export function ChatDateSeparator({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={date.wrap}>
      <View style={[date.pill, { backgroundColor: colors.surfaceTertiary }]}>
        <Text style={[date.text, { color: colors.textSecondary }]}>{label}</Text>
      </View>
    </View>
  );
}

export function ChatComposer({
  value,
  onChangeText,
  onSend,
  onPickMedia,
  sending,
  placeholder = 'Message',
  ...rest
}: {
  value: string;
  onChangeText: (t: string) => void;
  onSend: () => void;
  onPickMedia?: () => void;
  sending?: boolean;
  placeholder?: string;
} & Pick<TextInputProps, 'onSubmitEditing' | 'onBlur'>) {
  const { colors, isDark } = useTheme();
  const canSend = value.trim().length > 0 && !sending;

  const bar = (
    <View style={composer.inner}>
      {onPickMedia ? (
        <TouchableOpacity
          style={composer.mediaBtn}
          onPress={onPickMedia}
          activeOpacity={0.82}
          hitSlop={6}
        >
          <Ionicons name="happy-outline" size={24} color={colors.primary} />
        </TouchableOpacity>
      ) : null}
      <View
        style={[
          composer.inputWrap,
          {
            backgroundColor: isDark ? colors.surfaceSecondary : '#FFFFFF',
            borderColor: colors.borderLight,
          },
        ]}
      >
        <TextInput
          style={[composer.input, { color: colors.text }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={2000}
          {...rest}
        />
      </View>
      <TouchableOpacity
        onPress={onSend}
        disabled={!canSend}
        style={[
          composer.send,
          { backgroundColor: canSend ? colors.primary : colors.surfaceTertiary },
        ]}
        activeOpacity={0.82}
      >
        {sending ? (
          <Text style={composer.sendTxt}>…</Text>
        ) : (
          <Ionicons name="arrow-up" size={20} color={canSend ? '#fff' : colors.textTertiary} />
        )}
      </TouchableOpacity>
    </View>
  );

  if (Platform.OS === 'ios') {
    return (
      <BlurView intensity={88} tint={colors.blurTint} style={composer.bar}>
        {bar}
      </BlurView>
    );
  }

  return (
    <View style={[composer.bar, { backgroundColor: colors.background, borderTopColor: colors.borderLight }]}>
      {bar}
    </View>
  );
}

export function formatChatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function peerLabel(thread: {
  peer_display_name?: string | null;
  peer_username?: string | null;
  peer_wallet?: string | null;
}): string {
  if (thread.peer_display_name?.trim()) return thread.peer_display_name.trim();
  if (thread.peer_username) return `@${thread.peer_username}`;
  const w = thread.peer_wallet;
  if (w && w.length > 10) return `${w.slice(0, 4)}…${w.slice(-4)}`;
  return 'Creator';
}

const bubble = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: Spacing.md },
  rowMine: { justifyContent: 'flex-end' },
  rowFirst: { marginTop: 10 },
  rowContinued: { marginTop: 2 },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  text: { fontFamily: Fonts.body, fontSize: FontSize.md, lineHeight: 21 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    marginTop: 4,
  },
  time: { fontSize: 10, fontFamily: Fonts.bodyMedium },
  read: { fontSize: 10, fontFamily: Fonts.bodyBold },
  mediaWrap: {
    maxWidth: '78%',
  },
  mediaMeta: {
    justifyContent: 'flex-end',
    marginTop: 4,
    paddingHorizontal: 2,
  },
});

const typing = StyleSheet.create({
  wrap: {
    paddingHorizontal: Spacing.md,
    paddingBottom: 4,
    paddingTop: 2,
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
});

const date = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    marginVertical: 14,
    paddingHorizontal: Spacing.md,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: Radius.full,
  },
  text: {
    fontSize: FontSize.xs,
    fontFamily: Fonts.bodyMedium,
  },
});

const composer = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingTop: 10,
    paddingBottom: 10,
  },
  mediaBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  inputWrap: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    justifyContent: 'center',
  },
  input: {
    fontFamily: Fonts.body,
    fontSize: FontSize.md,
    maxHeight: 96,
    padding: 0,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  sendTxt: { color: '#fff', fontSize: 18, fontFamily: Fonts.bodyBold },
});
