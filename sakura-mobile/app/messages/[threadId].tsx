import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  AppState,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Fonts, FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { onTap } from '@/lib/sound';
import {
  getChatMessages,
  sendChatMessage,
  setChatTyping,
  markChatRead,
  isMessageRead,
  listChatThreads,
  type ChatMessage,
} from '@/lib/chat';
import { subscribeToChatThread } from '@/lib/chat-realtime';
import { markEntrancePlayed, resetEntranceAnimations } from '@/lib/chat-entrance';
import { pendingMatchesConfirmed } from '@/lib/chat-media';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import {
  buildChatListItems,
  createPendingMessage,
  mergeChatMessage,
  mergeChatMessagesFromServer,
  type ChatListItem,
} from '@/lib/chat-messages-ui';
import {
  ChatBubble,
  ChatComposer,
  ChatDateSeparator,
  TypingIndicator,
  formatChatTime,
  peerLabel,
} from '@/components/social/ChatUi';
import {
  encodeChatMedia,
  mediaMessageType,
  type ChatMediaPayload,
} from '@/lib/chat-media';
import ChatMediaPicker from '@/components/social/ChatMediaPicker';
import { ChatThreadSkeleton } from '@/components/ui/ShimmerLoader';

const TYPING_PING_MS = 2000;
const FALLBACK_POLL_MS = 12000;

function avatarColor(seed: string): string {
  const palette = ['#E84545', '#9B21BE', '#3498DB', '#27AE60', '#E67E22'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export default function ChatThreadScreen() {
  const params = useLocalSearchParams<{
    threadId: string | string[];
    peerName?: string;
    peerAvatar?: string;
    peerSeed?: string;
    peerUsername?: string;
  }>();
  const threadId = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
  const { peerName, peerAvatar, peerSeed, peerUsername } = params;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { address, unlockForAppSession } = useWallet();
  const { refresh: refreshUnreadBadge } = useUnreadMessages();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peerLastReadAt, setPeerLastReadAt] = useState<string | null>(null);
  const [peerIsTyping, setPeerIsTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [resolvedPeerName, setResolvedPeerName] = useState<string | null>(null);
  const [resolvedPeerAvatar, setResolvedPeerAvatar] = useState<string | null>(null);
  const [resolvedPeerSeed, setResolvedPeerSeed] = useState<string | null>(null);
  const [resolvedPeerUsername, setResolvedPeerUsername] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatListItem>>(null);
  const keypairRef = useRef<Awaited<ReturnType<typeof unlockForAppSession>>>(null);
  const lastTypingPingRef = useRef(0);
  const typingActiveRef = useRef(false);
  const stableKeysRef = useRef(new Map<string, string>());
  const hasLoadedRef = useRef(false);
  const [entranceKeys, setEntranceKeys] = useState<Set<string>>(() => new Set());

  const bindStableKey = useCallback((fromId: string, toId: string) => {
    const key = stableKeysRef.current.get(fromId) ?? fromId;
    stableKeysRef.current.set(toId, key);
    if (fromId !== toId) stableKeysRef.current.delete(fromId);
    markEntrancePlayed(key);
  }, []);

  const linkPendingToConfirmed = useCallback(
    (prev: ChatMessage[], confirmed: ChatMessage) => {
      if (confirmed.sender_wallet !== address) return;
      const pending = prev.find(
        (m) => m.id.startsWith('pending-') && pendingMatchesConfirmed(m, confirmed),
      );
      if (pending) bindStableKey(pending.id, confirmed.id);
    },
    [address, bindStableKey],
  );

  const messageListKey = useCallback((messageId: string) => {
    return stableKeysRef.current.get(messageId) ?? messageId;
  }, []);

  const queueEntrance = useCallback((messageId: string) => {
    const key = messageListKey(messageId);
    setEntranceKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [messageListKey]);

  useEffect(() => {
    stableKeysRef.current.clear();
    setEntranceKeys(new Set());
    resetEntranceAnimations();
    setMessages([]);
    setPeerLastReadAt(null);
    setPeerIsTyping(false);
    setLoadError(null);
    setLoading(true);
    hasLoadedRef.current = false;
    setResolvedPeerName(null);
    setResolvedPeerAvatar(null);
    setResolvedPeerSeed(null);
    setResolvedPeerUsername(null);
  }, [threadId]);

  useEffect(() => {
    keypairRef.current = null;
  }, [address]);

  const username = peerUsername?.trim() || resolvedPeerUsername?.trim() || undefined;
  const displayName =
    peerName?.trim() ||
    resolvedPeerName?.trim() ||
    (username ? `@${username}` : null) ||
    'Chat';
  const avatarUrl = peerAvatar?.trim() || resolvedPeerAvatar?.trim() || '';
  const seed = peerSeed?.trim() || resolvedPeerSeed?.trim() || 'chat';

  const ensureKeypair = useCallback(async () => {
    if (keypairRef.current) return keypairRef.current;
    const kp = await unlockForAppSession();
    if (kp) keypairRef.current = kp;
    return kp;
  }, [unlockForAppSession]);

  useEffect(() => {
    if (peerName?.trim() || !threadId) return;
    let cancelled = false;
    (async () => {
      const kp = await ensureKeypair();
      if (!kp || cancelled) return;
      try {
        const threads = await listChatThreads(kp);
        const thread = threads.find((t) => t.thread_id === String(threadId));
        if (!thread || cancelled) return;
        setResolvedPeerName(peerLabel(thread));
        setResolvedPeerAvatar(thread.peer_avatar_url);
        setResolvedPeerSeed(thread.peer_avatar_seed ?? thread.peer_wallet?.slice(0, 8) ?? null);
        setResolvedPeerUsername(thread.peer_username);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, peerName, ensureKeypair]);

  const scrollToBottom = useCallback((animated = true) => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);

  const loadMessages = useCallback(async (markReadOnLoad = true): Promise<boolean> => {
    if (!threadId) return false;
    const kp = await ensureKeypair();
    if (!kp) return false;
    const res = await getChatMessages(kp, String(threadId), markReadOnLoad);
    setMessages((prev) => {
      for (const message of res.messages) {
        linkPendingToConfirmed(prev, message);
      }
      return mergeChatMessagesFromServer(prev, res.messages, address);
    });
    setPeerLastReadAt(res.peer_last_read_at);
    setPeerIsTyping(res.peer_is_typing);
    setLoadError(null);
    refreshUnreadBadge().catch(() => {});
    return true;
  }, [threadId, ensureKeypair, refreshUnreadBadge, address, linkPendingToConfirmed]);

  const markRead = useCallback(async () => {
    if (!threadId) return;
    const kp = await ensureKeypair();
    if (!kp) return;
    try {
      await markChatRead(kp, String(threadId));
    } catch {
      // ignore
    }
  }, [threadId, ensureKeypair]);

  useFocusEffect(
    useCallback(() => {
      const firstLoad = !hasLoadedRef.current;
      if (firstLoad) setLoading(true);

      loadMessages()
        .then((ok) => {
          if (!ok && firstLoad) {
            setLoadError('Unlock your wallet to view messages.');
          }
        })
        .catch((e) => {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load messages. Pull to retry.',
          );
        })
        .finally(() => {
          hasLoadedRef.current = true;
          setLoading(false);
          scrollToBottom(false);
        });

      return () => {
        refreshUnreadBadge().catch(() => {});
        if (threadId && typingActiveRef.current) {
          ensureKeypair()
            .then((kp) => {
              if (kp) return setChatTyping(kp, String(threadId), false);
            })
            .catch(() => {});
          typingActiveRef.current = false;
        }
      };
    }, [loadMessages, scrollToBottom, threadId, ensureKeypair, refreshUnreadBadge]),
  );

  useEffect(() => {
    if (!threadId) return;

    const unsubscribe = subscribeToChatThread(String(threadId), address, unlockForAppSession, {
      onMessage: (msg) => {
        let isNew = false;
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          isNew = true;
          linkPendingToConfirmed(prev, msg);
          return mergeChatMessage(prev, msg, address);
        });
        if (!isNew) return;

        if (msg.sender_wallet !== address) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void markRead();
          queueEntrance(msg.id);
        }
        scrollToBottom(true);
      },
      onPeerRead: (lastReadAt) => setPeerLastReadAt(lastReadAt),
      onPeerTyping: (typing) => setPeerIsTyping(typing),
    });

    const poll = setInterval(() => {
      loadMessages(false).catch(() => {});
    }, FALLBACK_POLL_MS);

    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [threadId, address, unlockForAppSession, loadMessages, markRead, queueEntrance, scrollToBottom, linkPendingToConfirmed]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') loadMessages().catch(() => {});
    });
    return () => sub.remove();
  }, [loadMessages]);

  const pingTyping = useCallback(async (active: boolean) => {
    if (!threadId) return;
    typingActiveRef.current = active;
    const kp = await ensureKeypair();
    if (!kp) return;
    try {
      await setChatTyping(kp, String(threadId), active);
    } catch {
      // ignore
    }
  }, [threadId, ensureKeypair]);

  const handleDraftChange = (text: string) => {
    setDraft(text);
    const active = text.trim().length > 0;
    const now = Date.now();
    if (active && now - lastTypingPingRef.current >= TYPING_PING_MS) {
      lastTypingPingRef.current = now;
      void pingTyping(true);
    }
    if (!active && typingActiveRef.current) {
      void pingTyping(false);
    }
  };

  const sendMessage = async (content: string, messageType = 'text') => {
    if (!content || !threadId || sending || !address) return;

    const pending = createPendingMessage(String(threadId), address, content, messageType);
    const stableKey = `local-${Date.now()}`;
    stableKeysRef.current.set(pending.id, stableKey);
    setSending(true);
    void pingTyping(false);
    setMessages((prev) => [...prev, pending]);
    setEntranceKeys((prev) => new Set(prev).add(stableKey));
    scrollToBottom(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const kp = await ensureKeypair();
      if (!kp) {
        setMessages((prev) => prev.filter((m) => m.id !== pending.id));
        stableKeysRef.current.delete(pending.id);
        setEntranceKeys((prev) => {
          const next = new Set(prev);
          next.delete(stableKey);
          return next;
        });
        return;
      }
      const msg = await sendChatMessage(kp, String(threadId), content, messageType);
      setMessages((prev) => {
        linkPendingToConfirmed(prev, msg);
        bindStableKey(pending.id, msg.id);
        if (prev.some((m) => m.id === msg.id)) {
          return prev
            .filter((m) => m.id !== pending.id)
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }
        return prev
          .map((m) => (m.id === pending.id ? msg : m))
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      });
      scrollToBottom(true);
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== pending.id));
      stableKeysRef.current.delete(pending.id);
      setEntranceKeys((prev) => {
        const next = new Set(prev);
        next.delete(stableKey);
        return next;
      });
      Alert.alert(
        'Message failed',
        e instanceof Error ? e.message : 'Could not send this message. Try again.',
      );
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await sendMessage(text, 'text');
  };

  const handleSendMedia = async (payload: ChatMediaPayload) => {
    const content = encodeChatMedia(payload);
    await sendMessage(content, mediaMessageType(payload.kind));
  };

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    loadMessages()
      .then((ok) => {
        if (!ok) setLoadError('Unlock your wallet to view messages.');
      })
      .catch((e) => {
        setLoadError(e instanceof Error ? e.message : 'Could not load messages.');
      })
      .finally(() => setLoading(false));
  }, [loadMessages]);

  const showSkeleton = loading && messages.length === 0;

  const listItems = useMemo(
    () => buildChatListItems(messages, address),
    [messages, address],
  );

  const lastOutgoingId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].sender_wallet === address && !messages[i].id.startsWith('pending-')) {
        return messages[i].id;
      }
    }
    return null;
  }, [messages, address]);

  const headerSubtitle = peerIsTyping
    ? 'typing…'
    : username
      ? `@${username}`
      : null;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: Spacing.md,
          paddingVertical: 8,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.borderLight,
        },
        backBtn: { padding: 4, marginRight: 2 },
        avatar: {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          marginRight: 10,
        },
        avatarText: { color: '#fff', fontFamily: Fonts.bodyBold, fontSize: FontSize.sm },
        title: { fontSize: FontSize.md, fontFamily: Fonts.bodyBold, color: colors.text },
        sub: {
          fontSize: FontSize.xs,
          fontFamily: Fonts.body,
          color: peerIsTyping ? colors.primary : colors.textTertiary,
          marginTop: 1,
        },
        headerText: { flex: 1, minWidth: 0 },
        list: { paddingBottom: 8, flexGrow: 1 },
        empty: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          minHeight: 240,
        },
        emptyText: {
          color: colors.textSecondary,
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          textAlign: 'center',
        },
        errorBanner: {
          marginHorizontal: Spacing.md,
          marginTop: Spacing.sm,
          padding: Spacing.sm,
          borderRadius: 10,
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderLight,
        },
        errorText: {
          color: colors.textSecondary,
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          textAlign: 'center',
        },
        errorRetry: {
          color: colors.primary,
          fontFamily: Fonts.bodyBold,
        },
        composerPad: { paddingBottom: Math.max(insets.bottom, 6) },
      }),
    [colors, peerIsTyping, insets.bottom],
  );

  const headerContent = (
    <>
      <TouchableOpacity onPress={onTap(() => router.back())} style={styles.backBtn} hitSlop={8}>
        <Ionicons name="chevron-back" size={28} color={colors.primary} />
      </TouchableOpacity>

      <View style={[styles.avatar, !avatarUrl && { backgroundColor: avatarColor(seed) }]}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <Text style={styles.avatarText}>{displayName.slice(0, 1).toUpperCase()}</Text>
        )}
      </View>

      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1}>{displayName}</Text>
        {headerSubtitle ? (
          <Text style={[styles.sub, peerIsTyping && { fontStyle: 'italic' }]} numberOfLines={1}>
            {headerSubtitle}
          </Text>
        ) : null}
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {Platform.OS === 'ios' ? (
        <BlurView intensity={80} tint={colors.blurTint} style={styles.header}>
          {headerContent}
        </BlurView>
      ) : (
        <View style={[styles.header, { backgroundColor: colors.background }]}>
          {headerContent}
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
      >
        {showSkeleton ? (
          <ChatThreadSkeleton />
        ) : (
          <>
            {loadError ? (
              <TouchableOpacity style={styles.errorBanner} onPress={retryLoad} activeOpacity={0.8}>
                <Text style={styles.errorText}>
                  {loadError}{' '}
                  <Text style={styles.errorRetry}>Tap to retry</Text>
                </Text>
              </TouchableOpacity>
            ) : null}
            <FlatList
            ref={listRef}
            data={listItems}
            extraData={entranceKeys}
            keyExtractor={(item) =>
              item.kind === 'date' ? item.id : messageListKey(item.message.id)
            }
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onContentSizeChange={() => scrollToBottom(false)}
            renderItem={({ item }) => {
              if (item.kind === 'date') {
                return <ChatDateSeparator label={item.label} />;
              }

              const isLastOutgoing = item.message.id === lastOutgoingId;
              const read =
                item.isMine &&
                isLastOutgoing &&
                isMessageRead(item.message.created_at, peerLastReadAt);
              const stableKey = messageListKey(item.message.id);
              const animate = entranceKeys.has(stableKey);

              return (
                <ChatBubble
                  listKey={stableKey}
                  content={item.message.content}
                  isMine={item.isMine}
                  time={item.showMeta ? formatChatTime(item.message.created_at) : undefined}
                  readStatus={item.isMine && item.showMeta ? (read ? 'read' : 'sent') : null}
                  isFirstInGroup={item.isFirstInGroup}
                  isLastInGroup={item.isLastInGroup}
                  showMeta={item.showMeta}
                  animate={animate}
                  pending={item.pending}
                />
              );
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {loadError
                    ? loadError
                    : 'Say hello to start the conversation.'}
                </Text>
              </View>
            }
          />
          </>
        )}

        {!showSkeleton && peerIsTyping ? <TypingIndicator /> : null}

        <View style={styles.composerPad}>
          <ChatComposer
            value={draft}
            onChangeText={handleDraftChange}
            onSend={handleSend}
            onPickMedia={() => setMediaPickerOpen(true)}
            sending={sending}
            onBlur={() => {
              if (typingActiveRef.current) void pingTyping(false);
            }}
          />
        </View>
      </KeyboardAvoidingView>

      <ChatMediaPicker
        visible={mediaPickerOpen}
        onClose={() => setMediaPickerOpen(false)}
        onSelect={handleSendMedia}
      />
    </SafeAreaView>
  );
}
