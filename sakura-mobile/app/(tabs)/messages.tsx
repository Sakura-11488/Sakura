import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useScrollToTop } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { onTap } from '@/lib/sound';
import { type ChatThreadSummary, isThreadUnread, isMessageRead } from '@/lib/chat';
import { chatMessagePreview } from '@/lib/chat-media';
import { useUnreadMessages } from '@/lib/unread-messages-context';
import { peerLabel } from '@/components/social/ChatUi';
import EmptyState from '@/components/ui/EmptyState';
import { MessagesInboxSkeleton } from '@/components/ui/ShimmerLoader';
import NewMessageModal from '@/components/social/NewMessageModal';

function avatarColor(seed: string): string {
  const palette = ['#E84545', '#9B21BE', '#3498DB', '#27AE60', '#E67E22', '#5856D6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isUnread(item: ChatThreadSummary, myWallet: string | null): boolean {
  if (!myWallet) return false;
  return isThreadUnread(item, myWallet);
}

function previewText(item: ChatThreadSummary, myWallet: string | null): string {
  if (item.peer_is_typing) return 'typing…';
  const body = chatMessagePreview(item.last_message) || 'Say hello';
  if (!myWallet || item.last_message_sender !== myWallet) return body;
  if (!item.last_message_at) return body;
  const read = isMessageRead(item.last_message_at, item.peer_last_read_at);
  return read ? `Read · ${body}` : `Delivered · ${body}`;
}

function matchesThread(item: ChatThreadSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    peerLabel(item),
    item.peer_username ?? '',
    item.peer_display_name ?? '',
    item.peer_wallet ?? '',
    item.last_message ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function ThreadRow({
  item,
  onPress,
  showDivider,
  myWallet,
}: {
  item: ChatThreadSummary;
  onPress: () => void;
  showDivider: boolean;
  myWallet: string | null;
}) {
  const { colors } = useTheme();
  const label = peerLabel(item);
  const seed = item.peer_avatar_seed ?? item.peer_wallet?.slice(0, 8) ?? '?';
  const unread = isUnread(item, myWallet);
  const typing = item.peer_is_typing;
  const preview = previewText(item, myWallet);

  const row = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          paddingLeft: Spacing.md,
          backgroundColor: colors.background,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingRight: Spacing.md,
          paddingVertical: 11,
          borderBottomWidth: showDivider ? StyleSheet.hairlineWidth : 0,
          borderBottomColor: colors.borderLight,
        },
        avatar: {
          width: 52,
          height: 52,
          borderRadius: 26,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        avatarText: {
          color: '#fff',
          fontFamily: Fonts.bodyBold,
          fontSize: FontSize.md,
        },
        body: { flex: 1, minWidth: 0 },
        top: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        },
        name: {
          flex: 1,
          fontSize: FontSize.md,
          fontFamily: unread ? Fonts.bodyBold : Fonts.bodyMedium,
          color: colors.text,
        },
        time: {
          fontSize: FontSize.xs,
          fontFamily: Fonts.body,
          color: unread ? colors.primary : colors.textTertiary,
        },
        previewRow: {
          flexDirection: 'row',
          alignItems: 'center',
          marginTop: 3,
          gap: 6,
        },
        preview: {
          flex: 1,
          fontSize: FontSize.sm,
          fontFamily: typing || unread ? Fonts.bodyMedium : Fonts.body,
          color: typing ? colors.primary : unread ? colors.textSecondary : colors.textTertiary,
          fontStyle: typing ? 'italic' : 'normal',
        },
        dot: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: colors.primary,
          flexShrink: 0,
        },
      }),
    [colors, unread, showDivider, typing],
  );

  return (
    <View style={row.wrap}>
      <TouchableOpacity style={row.row} activeOpacity={0.6} onPress={onPress}>
        <View style={[row.avatar, !item.peer_avatar_url && { backgroundColor: avatarColor(seed) }]}>
          {item.peer_avatar_url ? (
            <Image source={{ uri: item.peer_avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <Text style={row.avatarText}>{label.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>

        <View style={row.body}>
          <View style={row.top}>
            <Text style={row.name} numberOfLines={1}>{label}</Text>
            <Text style={row.time}>{formatRelative(item.last_message_at)}</Text>
          </View>
          <View style={row.previewRow}>
            <Text style={row.preview} numberOfLines={1}>
              {preview}
            </Text>
            {unread ? <View style={row.dot} /> : null}
            <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

export default function MessagesTabScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { connected, address } = useWallet();
  const { threads, refresh } = useUnreadMessages();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const listRef = React.useRef<FlatList>(null);
  useScrollToTop(listRef);

  const hasLoadedRef = React.useRef(false);

  const load = useCallback(async (fromRefresh = false) => {
    if (!connected) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (!hasLoadedRef.current && !fromRefresh) setLoading(true);
    try {
      await refresh();
      hasLoadedRef.current = true;
    } catch {
      // ignore
    } finally {
      setLoading(false);
      if (fromRefresh) setRefreshing(false);
    }
  }, [connected, refresh]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const filtered = useMemo(() => {
    const list = threads.filter((t) => matchesThread(t, query));
    return list.sort((a, b) => {
      const aUnread = isUnread(a, address);
      const bUnread = isUnread(b, address);
      if (aUnread !== bUnread) return aUnread ? -1 : 1;
      const aTime = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bTime = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return bTime - aTime;
    });
  }, [threads, query, address]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: Spacing.md,
          paddingTop: Spacing.sm,
          paddingBottom: Spacing.sm,
        },
        title: {
          fontFamily: Fonts.display,
          fontWeight: Fonts.displayWeight,
          fontSize: 34,
          color: colors.text,
          letterSpacing: -0.4,
          flex: 1,
        },
        composeBtn: {
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.surfaceSecondary,
        },
        searchWrap: {
          paddingHorizontal: Spacing.md,
          paddingBottom: Spacing.sm,
        },
        searchBar: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.surfaceSecondary,
          borderRadius: Radius.full,
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 8,
        },
        searchInput: {
          flex: 1,
          color: colors.text,
          fontSize: FontSize.md,
          fontFamily: Fonts.body,
          padding: 0,
        },
        clearBtn: { padding: 2 },
        connectWrap: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: Spacing.xl,
        },
        connectTitle: {
          fontSize: FontSize.lg,
          fontFamily: Fonts.bodyBold,
          color: colors.text,
          marginBottom: 8,
          textAlign: 'center',
        },
        connectSub: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: colors.textSecondary,
          textAlign: 'center',
          lineHeight: 20,
          marginBottom: 20,
        },
        connectBtn: {
          paddingHorizontal: 20,
          paddingVertical: 12,
          borderRadius: Radius.full,
          backgroundColor: colors.primary,
        },
        connectBtnText: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.bodyBold,
          color: '#fff',
        },
        noResults: {
          paddingTop: 48,
          paddingHorizontal: Spacing.lg,
          alignItems: 'center',
        },
        noResultsTitle: {
          fontSize: FontSize.md,
          fontFamily: Fonts.bodyBold,
          color: colors.text,
          marginBottom: 4,
        },
        noResultsSub: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: colors.textSecondary,
          textAlign: 'center',
        },
        listContent: { paddingBottom: 120 },
      }),
    [colors],
  );

  const openThread = (item: ChatThreadSummary) =>
    router.push({
      pathname: '/messages/[threadId]',
      params: {
        threadId: item.thread_id,
        peerName: peerLabel(item),
        peerAvatar: item.peer_avatar_url ?? '',
        peerSeed: item.peer_avatar_seed ?? item.peer_wallet?.slice(0, 8) ?? '',
        peerUsername: item.peer_username ?? '',
      },
    } as never);

  const searchBar = connected ? (
    <View style={styles.searchWrap}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search conversations"
          placeholderTextColor={colors.textTertiary}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="never"
          returnKeyType="search"
        />
        {query.length > 0 ? (
          <TouchableOpacity style={styles.clearBtn} onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Messages</Text>
        {connected ? (
          <TouchableOpacity
            style={styles.composeBtn}
            activeOpacity={0.75}
            onPress={onTap(() => setNewMessageOpen(true))}
            accessibilityLabel="New message"
          >
            <Ionicons name="create-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {!connected ? (
        <View style={styles.connectWrap}>
          <Text style={styles.connectTitle}>Connect your account</Text>
          <Text style={styles.connectSub}>
            Link your Sakura account to message creators and view your conversations.
          </Text>
          <TouchableOpacity
            style={styles.connectBtn}
            activeOpacity={0.88}
            onPress={onTap(() => router.push('/(tabs)/profile'))}
          >
            <Text style={styles.connectBtnText}>Connect in Profile</Text>
          </TouchableOpacity>
        </View>
      ) : loading && threads.length === 0 ? (
        <>
          {searchBar}
          <MessagesInboxSkeleton />
        </>
      ) : (
        <FlatList
          ref={listRef}
          data={filtered}
          keyExtractor={(item) => item.thread_id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={searchBar}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(true);
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            query.trim() ? (
              <View style={styles.noResults}>
                <Text style={styles.noResultsTitle}>No results</Text>
                <Text style={styles.noResultsSub}>
                  Nothing matched &ldquo;{query.trim()}&rdquo;
                </Text>
              </View>
            ) : (
              <EmptyState
                compact
                title="No conversations yet"
                subtitle="Tap the compose button or message a creator from their channel."
                style={{ paddingTop: 48, paddingBottom: 80 }}
              />
            )
          }
          renderItem={({ item, index }) => (
            <ThreadRow
              item={item}
              showDivider={index < filtered.length - 1}
              myWallet={address}
              onPress={onTap(() => openThread(item))}
            />
          )}
        />
      )}

      <NewMessageModal visible={newMessageOpen} onClose={() => setNewMessageOpen(false)} />
    </SafeAreaView>
  );
}
