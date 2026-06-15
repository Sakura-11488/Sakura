import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@/lib/theme';
import {
  blockChatUser,
  fetchCreatorChatMessages,
  fetchChatThreads,
  markChatThreadRead,
  reportChatThread,
  sendCreatorChatMessage,
  startCreatorChat,
} from '@/lib/creator-social';
import { getOrRefreshWalletAuthSession, peekWalletAuthSession } from '@/lib/wallet-auth-session';
import { useWallet } from '@/lib/wallet/context';
import { getPublicProfile } from '@/lib/profile-stats';
import { formatPeerLabel, countUnreadThreads, type ChatMessageRow } from '@/lib/chat-utils';
import { setChatUnreadCount } from '@/lib/chat-unread-store';
import { useChatRealtime } from '@/lib/hooks/useChatRealtime';
import { FontSize, FontWeight, Radius, Spacing } from '@/constants/theme';

export default function CreatorChatScreen() {
  const {
    wallet,
    thread,
    peer_username: peerUsernameParam,
    peer_display_name: peerDisplayNameParam,
  } = useLocalSearchParams<{
    wallet?: string;
    thread?: string;
    peer_username?: string;
    peer_display_name?: string;
  }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { address, unlockForAppSession } = useWallet();
  const [threadId, setThreadId] = useState(thread ?? '');
  const [peerWallet, setPeerWallet] = useState(wallet ?? '');
  const [peerUsername, setPeerUsername] = useState(peerUsernameParam ?? '');
  const [peerDisplayName, setPeerDisplayName] = useState(peerDisplayNameParam ?? '');
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const listRef = useRef<FlatList<ChatMessageRow>>(null);

  const authHeaders = useCallback(
    () => getOrRefreshWalletAuthSession(unlockForAppSession, 'creator-chat'),
    [unlockForAppSession],
  );

  const peerLabel = formatPeerLabel({
    peer_username: peerUsername || null,
    peer_display_name: peerDisplayName || null,
    peer_wallet: peerWallet || null,
  });

  const scrollToEnd = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  const realtimeSyncRef = useRef<(rows: ChatMessageRow[]) => void>(() => {});

  const fallbackPoll = useCallback(async () => {
    if (!threadId) return;
    try {
      const headers = await authHeaders();
      const rows = await fetchCreatorChatMessages({ threadId, authHeaders: headers, markRead: true });
      setMessages(rows);
      realtimeSyncRef.current(rows);
      scrollToEnd(false);
    } catch {
      // silent fallback
    }
  }, [authHeaders, scrollToEnd, threadId]);

  const onRealtimeMessages = useCallback(
    (rows: ChatMessageRow[]) => {
      setMessages(rows);
      scrollToEnd();
    },
    [scrollToEnd],
  );

  const { setMessages: setRealtimeMessages } = useChatRealtime({
    threadId: booting ? null : threadId,
    enabled: !!address && !booting,
    paused: busy,
    walletAddress: address,
    unlock: unlockForAppSession,
    onMessages: onRealtimeMessages,
    onFallbackPoll: fallbackPoll,
  });

  realtimeSyncRef.current = setRealtimeMessages;

  useEffect(() => {
    let active = true;
    const paramThread = thread ?? '';
    (async () => {
      if (!address) {
        setBooting(false);
        return;
      }
      try {
        const headers = await authHeaders();
        const id = paramThread || (wallet ? await startCreatorChat({ recipientWallet: wallet, authHeaders: headers }) : '');
        if (!id || !active) return;
        setThreadId(id);
        if (wallet) setPeerWallet(wallet);

        if ((!peerUsernameParam || !peerDisplayNameParam) && wallet) {
          const { profile } = await getPublicProfile(wallet);
          if (!active) return;
          if (profile?.username) setPeerUsername(profile.username);
          if (profile?.display_name) setPeerDisplayName(profile.display_name);
        }

        const rows = await fetchCreatorChatMessages({ threadId: id, authHeaders: headers, markRead: true });
        if (!active) return;
        setMessages(rows);
        setRealtimeMessages(rows);
        scrollToEnd(false);
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : 'Please try again.';
        if (message.toLowerCase().includes('blocked')) setBlocked(true);
        Alert.alert('Could not open chat', message);
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [address, authHeaders, peerDisplayNameParam, peerUsernameParam, scrollToEnd, setRealtimeMessages, thread, wallet]);

  useEffect(() => {
    return () => {
      const headers = peekWalletAuthSession('creator-chat');
      if (!headers) return;
      fetchChatThreads(headers)
        .then((rows) => setChatUnreadCount(countUnreadThreads(rows)))
        .catch(() => {});
    };
  }, []);

  const send = useCallback(async () => {
    if (!threadId || !draft.trim() || blocked) return;
    const content = draft.trim();
    const tempId = `tmp-${Date.now()}`;
    const optimistic: ChatMessageRow = {
      id: tempId,
      sender_wallet: address ?? '',
      content,
      created_at: new Date().toISOString(),
      pending: true,
    };

    setBusy(true);
    setDraft('');
    setMessages((current) => {
      const next = [...current, optimistic];
      setRealtimeMessages(next);
      return next;
    });
    scrollToEnd();

    try {
      const headers = await authHeaders();
      const message = await sendCreatorChatMessage({ threadId, content, authHeaders: headers });
      setMessages((current) => {
        const next = current.map((row) => (row.id === tempId ? { ...message, pending: false } : row));
        setRealtimeMessages(next);
        return next;
      });
      await markChatThreadRead({ threadId, authHeaders: headers }).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again.';
      if (message.toLowerCase().includes('blocked')) setBlocked(true);
      setMessages((current) => {
        const next = current.filter((row) => row.id !== tempId);
        setRealtimeMessages(next);
        return next;
      });
      setDraft(content);
      Alert.alert('Message failed', message);
    } finally {
      setBusy(false);
    }
  }, [address, authHeaders, blocked, draft, scrollToEnd, setRealtimeMessages, threadId]);

  const openMenu = useCallback(() => {
    if (!peerWallet) return;

    const block = async () => {
      Alert.alert('Block user?', 'You will no longer be able to message each other.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              const headers = await authHeaders();
              await blockChatUser({ recipientWallet: peerWallet, authHeaders: headers });
              setBlocked(true);
              router.back();
            } catch (error) {
              Alert.alert('Block failed', error instanceof Error ? error.message : 'Please try again.');
            }
          },
        },
      ]);
    };

    const report = () => {
      if (!threadId) return;
      if (Platform.OS === 'ios') {
        Alert.prompt('Report conversation', 'Tell us what happened.', async (reason) => {
          if (!reason?.trim()) return;
          try {
            const headers = await authHeaders();
            await reportChatThread({ threadId, reason: reason.trim(), authHeaders: headers });
            Alert.alert('Report submitted', 'Thanks for helping keep Sakura safe.');
          } catch (error) {
            Alert.alert('Report failed', error instanceof Error ? error.message : 'Please try again.');
          }
        });
        return;
      }
      Alert.alert('Report conversation', 'Contact support if you need to report this chat.');
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Block user', 'Report conversation', 'Cancel'],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) block();
          if (index === 1) report();
        },
      );
      return;
    }

    Alert.alert('Chat options', undefined, [
      { text: 'Block user', style: 'destructive', onPress: block },
      { text: 'Report conversation', onPress: report },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [authHeaders, peerWallet, router, threadId]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: Spacing.md },
        back: { color: colors.primary, fontWeight: FontWeight.bold, minWidth: 48 },
        headerCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
        title: { color: colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
        subtitle: { color: colors.textTertiary, fontSize: FontSize.xs, marginTop: 2 },
        menu: { color: colors.primary, fontWeight: FontWeight.bold, fontSize: 22, minWidth: 48, textAlign: 'right' },
        list: { flex: 1, paddingHorizontal: Spacing.md },
        bubble: { maxWidth: '82%', borderRadius: Radius.lg, padding: Spacing.sm, marginBottom: Spacing.sm },
        mine: { alignSelf: 'flex-end', backgroundColor: colors.primary },
        theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface },
        pending: { opacity: 0.65 },
        text: { fontSize: FontSize.sm, lineHeight: 19 },
        inputRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight },
        input: { flex: 1, borderRadius: Radius.full, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: Spacing.md },
        inputDisabled: { opacity: 0.5 },
        send: { borderRadius: Radius.full, backgroundColor: colors.primary, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
        sendDisabled: { opacity: 0.45 },
        sendText: { color: '#fff', fontWeight: FontWeight.bold },
        booting: { flex: 1, alignItems: 'center', justifyContent: 'center' },
        bootingText: { color: colors.textSecondary, marginTop: 8 },
        blockedBanner: {
          backgroundColor: colors.surfaceSecondary,
          padding: Spacing.sm,
          marginHorizontal: Spacing.md,
          borderRadius: Radius.md,
          marginBottom: Spacing.sm,
        },
        blockedText: { color: colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center' },
      }),
    [colors],
  );

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.back}>Back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerCenter}
            disabled={!peerWallet}
            onPress={() => peerWallet && router.push(`/user/${encodeURIComponent(peerWallet)}` as never)}
            activeOpacity={0.8}
          >
            <Text style={styles.title} numberOfLines={1}>{peerLabel}</Text>
            {peerWallet ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {peerWallet.slice(0, 4)}…{peerWallet.slice(-4)}
              </Text>
            ) : null}
          </TouchableOpacity>
          <TouchableOpacity onPress={openMenu} disabled={!peerWallet}>
            <Text style={styles.menu}>⋯</Text>
          </TouchableOpacity>
        </View>

        {blocked ? (
          <View style={styles.blockedBanner}>
            <Text style={styles.blockedText}>This conversation is blocked.</Text>
          </View>
        ) : null}

        {booting ? (
          <View style={styles.booting}>
            <Text style={styles.bootingText}>Opening conversation…</Text>
          </View>
        ) : (
          <>
            <FlatList
              ref={listRef}
              style={styles.list}
              data={messages}
              keyExtractor={(item) => item.id}
              onContentSizeChange={() => scrollToEnd(false)}
              renderItem={({ item }) => {
                const mine = item.sender_wallet === address;
                return (
                  <View style={[styles.bubble, mine ? styles.mine : styles.theirs, item.pending && styles.pending]}>
                    <Text style={[styles.text, { color: mine ? '#fff' : colors.text }]}>{item.content}</Text>
                  </View>
                );
              }}
            />
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.input, blocked && styles.inputDisabled]}
                value={draft}
                onChangeText={setDraft}
                placeholder={blocked ? 'Chat blocked' : 'Message...'}
                placeholderTextColor={colors.textTertiary}
                editable={!blocked}
              />
              <TouchableOpacity
                style={[styles.send, (busy || blocked) && styles.sendDisabled]}
                onPress={send}
                disabled={busy || blocked}
                activeOpacity={0.85}
              >
                <Text style={styles.sendText}>{busy ? '...' : 'Send'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
