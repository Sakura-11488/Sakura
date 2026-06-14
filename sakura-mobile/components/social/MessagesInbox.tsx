import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter, useScrollToTop } from 'expo-router';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { fetchChatThreads, type ChatThreadSummary } from '@/lib/creator-social';
import { countUnreadThreads, isThreadUnread } from '@/lib/chat-utils';
import { setChatUnreadCount } from '@/lib/chat-unread-store';
import ProfileAvatar from '@/components/ui/ProfileAvatar';
import EmptyState from '@/components/ui/EmptyState';
import { FontSize, FontWeight, Radius, Spacing, Fonts } from '@/constants/theme';

function formatPreview(text: string | null): string {
  if (!text) return 'No messages yet';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

import { useChatInboxRealtime } from '@/lib/hooks/useChatInboxRealtime';
import { getOrRefreshWalletAuthSession } from '@/lib/wallet-auth-session';

type Props = {
  showBack?: boolean;
};

export default function MessagesInbox({ showBack = false }: Props) {
  const { colors } = useTheme();
  const router = useRouter();
  const { address, connected, signWithBiometrics } = useWallet();
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList<ChatThreadSummary>>(null);
  useScrollToTop(listRef);

  const loadThreads = useCallback(async (options?: { silent?: boolean }) => {
    if (!connected || !address) {
      setThreads([]);
      setLoading(false);
      return;
    }
    if (!options?.silent) setLoading(true);
    try {
      const headers = await getOrRefreshWalletAuthSession(signWithBiometrics, 'creator-chat');
      const rows = await fetchChatThreads(headers);
      setThreads(rows);
      setChatUnreadCount(countUnreadThreads(rows));
    } catch (error) {
      if (!options?.silent) {
        Alert.alert('Messages unavailable', error instanceof Error ? error.message : 'Please try again.');
        setThreads([]);
      }
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [address, connected, signWithBiometrics]);

  useChatInboxRealtime({
    enabled: connected && !!address,
    walletAddress: address,
    unlock: signWithBiometrics,
    onNewMessage: () => {
      loadThreads({ silent: true });
    },
  });

  useFocusEffect(
    useCallback(() => {
      loadThreads();
    }, [loadThreads]),
  );

  const unreadCount = threads.filter(isThreadUnread).length;

  const styles = StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Spacing.md,
      paddingTop: 2,
      paddingBottom: 8,
    },
    back: { color: colors.primary, fontWeight: FontWeight.bold, fontSize: FontSize.md, minWidth: 48 },
    title: {
      fontFamily: Fonts.display,
      fontWeight: Fonts.displayWeight,
      fontSize: 30,
      color: colors.text,
    },
    subtitle: {
      fontSize: FontSize.sm,
      color: colors.textSecondary,
      paddingHorizontal: Spacing.md,
      marginBottom: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: Spacing.md,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    info: { flex: 1, minWidth: 0 },
    topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    name: { flex: 1, fontSize: FontSize.md, fontWeight: FontWeight.bold, color: colors.text },
    time: { fontSize: FontSize.xs, color: colors.textTertiary },
    preview: { fontSize: FontSize.sm, color: colors.textSecondary, marginTop: 3 },
    unreadDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: colors.primary,
      marginLeft: 6,
    },
    loader: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 48 },
    cta: {
      marginTop: 16,
      alignSelf: 'center',
      backgroundColor: colors.primary,
      borderRadius: Radius.full,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    ctaText: { color: '#fff', fontWeight: FontWeight.bold, fontSize: FontSize.sm },
    list: { paddingBottom: 110 },
  });

  const empty = (
    <View style={{ paddingTop: 24, paddingHorizontal: Spacing.md }}>
      <EmptyState
        title="No conversations yet"
        subtitle="Search for @users, open their profile, and tap Message to start chatting."
      />
      <TouchableOpacity
        style={styles.cta}
        activeOpacity={0.88}
        onPress={() => router.push('/(tabs)/search' as never)}
      >
        <Text style={styles.ctaText}>Find people in Search</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        {showBack ? (
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.back}>Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 48 }} />
        )}
        {!showBack ? (
          <Animated.Text entering={FadeInDown.duration(220)} style={styles.title}>
            Messages
          </Animated.Text>
        ) : (
          <Text style={[styles.title, { fontSize: FontSize.xl }]}>Messages</Text>
        )}
        <View style={{ width: 48 }} />
      </View>

      {connected && !loading && threads.length > 0 ? (
        <Text style={styles.subtitle}>
          {unreadCount > 0
            ? `${unreadCount} unread conversation${unreadCount === 1 ? '' : 's'}`
            : `${threads.length} conversation${threads.length === 1 ? '' : 's'}`}
        </Text>
      ) : null}

      {!connected ? (
        <EmptyState
          title="Connect your wallet"
          subtitle="Your Sakura wallet unlocks direct messages with other users."
        />
      ) : loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={threads}
          keyExtractor={(item) => item.thread_id}
          contentContainerStyle={threads.length === 0 ? undefined : styles.list}
          scrollIndicatorInsets={{ bottom: 90 }}
          ListEmptyComponent={empty}
          renderItem={({ item, index }) => {
            const label = item.peer_username
              ? `@${item.peer_username}`
              : item.peer_display_name ||
                (item.peer_wallet
                  ? `${item.peer_wallet.slice(0, 4)}…${item.peer_wallet.slice(-4)}`
                  : 'Unknown');
            const unread = isThreadUnread(item);
            return (
              <Animated.View entering={FadeInDown.delay(index * 30).duration(240)}>
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.85}
                  onPress={() =>
                  router.push({
                    pathname: '/creator-chat',
                    params: {
                      thread: item.thread_id,
                      wallet: item.peer_wallet ?? undefined,
                      peer_username: item.peer_username ?? undefined,
                      peer_display_name: item.peer_display_name ?? undefined,
                    },
                  } as never)
                  }
                >
                  <ProfileAvatar
                    profile={{
                      wallet_address: item.peer_wallet ?? '',
                      avatar_url: item.peer_avatar_url,
                      avatar_seed: item.peer_avatar_seed ?? item.peer_wallet?.slice(0, 8) ?? 'sakura',
                    }}
                    size={52}
                  />
                  <View style={styles.info}>
                    <View style={styles.topLine}>
                      <Text style={styles.name} numberOfLines={1}>
                        {label}
                      </Text>
                      {item.last_message_at ? (
                        <Text style={styles.time}>{formatTime(item.last_message_at)}</Text>
                      ) : null}
                      {unread ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <Text
                      style={[styles.preview, unread && { color: colors.text, fontWeight: FontWeight.medium }]}
                      numberOfLines={1}
                    >
                      {formatPreview(item.last_message)}
                    </Text>
                  </View>
                </TouchableOpacity>
              </Animated.View>
            );
          }}
        />
      )}
    </View>
  );
}
