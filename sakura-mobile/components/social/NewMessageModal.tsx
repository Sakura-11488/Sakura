import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { useWallet } from '@/lib/wallet/context';
import { searchUsersByUsername, type UserSearchResult } from '@/lib/creator';
import { navigateToUserChat, userDisplayLabel } from '@/lib/user-chat-nav';
import GorhomSheetModal from '@/components/ui/GorhomSheetModal';

function avatarColor(seed: string): string {
  const palette = ['#E84545', '#9B21BE', '#3498DB', '#27AE60', '#E67E22', '#5856D6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

type Props = {
  visible: boolean;
  onClose: () => void;
};

export default function NewMessageModal({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const router = useRouter();
  const { address, unlockForAppSession } = useWallet();
  const snapPoints = useMemo(() => ['88%'], []);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults([]);
      setSearching(false);
      setStarting(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const trimmed = query.replace(/^@/, '').trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      searchUsersByUsername(trimmed)
        .then((users) => {
          const filtered = address
            ? users.filter((u) => u.wallet_address !== address)
            : users;
          setResults(filtered);
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);

    return () => clearTimeout(timer);
  }, [query, visible, address]);

  const openChat = useCallback(
    async (user: UserSearchResult) => {
      if (starting) return;
      if (!address) {
        Alert.alert('Connect Account', 'Connect your Sakura account to send messages.');
        return;
      }
      if (address === user.wallet_address) {
        Alert.alert('Cannot message yourself', 'Pick another user to start a conversation.');
        return;
      }

      setStarting(user.wallet_address);
      try {
        const kp = await unlockForAppSession();
        if (!kp) return;
        await navigateToUserChat(router, kp, user);
        onClose();
      } catch (e) {
        Alert.alert('Message failed', e instanceof Error ? e.message : 'Try again.');
      } finally {
        setStarting(null);
      }
    },
    [address, onClose, router, unlockForAppSession, starting],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: Spacing.md,
          paddingBottom: Spacing.sm,
        },
        title: {
          fontSize: FontSize.lg,
          fontFamily: Fonts.bodyBold,
          color: colors.text,
        },
        closeBtn: { padding: 6 },
        searchWrap: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm },
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
        hint: {
          paddingHorizontal: Spacing.md,
          paddingTop: 8,
          paddingBottom: 4,
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: colors.textSecondary,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: Spacing.md,
          paddingVertical: 12,
        },
        avatar: {
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        avatarText: {
          color: '#fff',
          fontFamily: Fonts.bodyBold,
          fontSize: FontSize.md,
        },
        rowBody: { flex: 1, minWidth: 0 },
        name: {
          fontSize: FontSize.md,
          fontFamily: Fonts.bodyBold,
          color: colors.text,
        },
        username: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: colors.textSecondary,
          marginTop: 2,
        },
        empty: {
          paddingTop: 32,
          paddingHorizontal: Spacing.lg,
          alignItems: 'center',
        },
        emptyTitle: {
          fontSize: FontSize.md,
          fontFamily: Fonts.bodyBold,
          color: colors.text,
          marginBottom: 4,
        },
        emptySub: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: colors.textSecondary,
          textAlign: 'center',
        },
        list: { paddingBottom: 24 },
      }),
    [colors],
  );

  const trimmed = query.replace(/^@/, '').trim();
  const showHint = trimmed.length < 2;
  const showEmpty = !showHint && !searching && results.length === 0;

  const listHeader = (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>New message</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={8}>
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search by username"
            placeholderTextColor={colors.textTertiary}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {showHint ? (
        <Text style={styles.hint}>Type at least 2 characters to search usernames.</Text>
      ) : searching ? (
        <View style={{ paddingVertical: 28, alignItems: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
    </>
  );

  return (
    <GorhomSheetModal visible={visible} onClose={onClose} snapPoints={snapPoints}>
      {showHint || searching ? (
        <View style={{ flex: 1 }}>{listHeader}</View>
      ) : showEmpty ? (
        <View style={{ flex: 1 }}>
          {listHeader}
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No users found</Text>
            <Text style={styles.emptySub}>
              No account matched &ldquo;{trimmed}&rdquo;. Try another username.
            </Text>
          </View>
        </View>
      ) : (
        <BottomSheetFlatList
          data={results}
          keyExtractor={(item) => item.wallet_address}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListHeaderComponent={listHeader}
          renderItem={({ item }) => {
            const label = userDisplayLabel(item);
            const seed = item.avatar_seed ?? item.wallet_address.slice(0, 8);
            const busy = starting === item.wallet_address;
            return (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.65}
                disabled={!!starting}
                onPress={() => openChat(item)}
              >
                <View style={[styles.avatar, !item.avatar_url && { backgroundColor: avatarColor(seed) }]}>
                  {item.avatar_url ? (
                    <Image source={{ uri: item.avatar_url }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  ) : (
                    <Text style={styles.avatarText}>{label.slice(0, 1).toUpperCase()}</Text>
                  )}
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.name} numberOfLines={1}>{label}</Text>
                  <Text style={styles.username} numberOfLines={1}>@{item.username}</Text>
                </View>
                {busy ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}
    </GorhomSheetModal>
  );
}
