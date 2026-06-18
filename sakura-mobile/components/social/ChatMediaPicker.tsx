import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import { fetchGiphyItems, isGiphyConfigured, type GiphyItem } from '@/lib/giphy';
import type { ChatMediaKind, ChatMediaPayload } from '@/lib/chat-media';
import GorhomSheetModal from '@/components/ui/GorhomSheetModal';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (payload: ChatMediaPayload) => void;
};

const TABS: { key: ChatMediaKind; label: string }[] = [
  { key: 'gif', label: 'GIFs' },
  { key: 'sticker', label: 'Stickers' },
];

export default function ChatMediaPicker({ visible, onClose, onSelect }: Props) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const cellSize = Math.floor((width - Spacing.md * 2 - 16) / 3);
  const snapPoints = useMemo(() => ['72%'], []);

  const [tab, setTab] = useState<ChatMediaKind>('gif');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GiphyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setError(null);
      setItems([]);
      return;
    }
    if (!isGiphyConfigured()) {
      setError('Add EXPO_PUBLIC_GIPHY_API_KEY to enable GIFs and stickers.');
      setItems([]);
      return;
    }

    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      fetchGiphyItems(tab, query)
        .then(setItems)
        .catch((e) => {
          setItems([]);
          setError(e instanceof Error ? e.message : 'Could not load media.');
        })
        .finally(() => setLoading(false));
    }, query.trim() ? 350 : 0);

    return () => clearTimeout(timer);
  }, [visible, tab, query]);

  const handleSelect = useCallback(
    (item: GiphyItem) => {
      onSelect({
        kind: item.kind,
        url: item.url,
        previewUrl: item.previewUrl,
        width: item.width,
        height: item.height,
        title: item.title,
      });
      onClose();
    },
    [onClose, onSelect],
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
        tabs: {
          flexDirection: 'row',
          gap: 8,
          paddingHorizontal: Spacing.md,
          paddingBottom: Spacing.sm,
        },
        tab: {
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: Radius.full,
          backgroundColor: colors.surfaceSecondary,
        },
        tabActive: {
          backgroundColor: colors.primary,
        },
        tabText: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.bodyMedium,
          color: colors.textSecondary,
        },
        tabTextActive: {
          color: '#fff',
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
        grid: {
          paddingHorizontal: Spacing.md,
          paddingBottom: 12,
        },
        cell: {
          width: cellSize,
          height: cellSize,
          margin: 2,
          borderRadius: Radius.md,
          overflow: 'hidden',
          backgroundColor: colors.surfaceSecondary,
        },
        empty: {
          paddingTop: 40,
          paddingHorizontal: Spacing.lg,
          alignItems: 'center',
        },
        emptyText: {
          fontSize: FontSize.sm,
          fontFamily: Fonts.body,
          color: colors.textSecondary,
          textAlign: 'center',
        },
        credit: {
          textAlign: 'center',
          fontSize: FontSize.xs,
          fontFamily: Fonts.body,
          color: colors.textTertiary,
          paddingBottom: 16,
        },
      }),
    [colors, cellSize],
  );

  const listHeader = (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>GIFs & Stickers</Text>
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setTab(t.key)}
              activeOpacity={0.85}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={tab === 'gif' ? 'Search GIFs' : 'Search stickers'}
            placeholderTextColor={colors.textTertiary}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </>
  );

  const listFooter = <Text style={styles.credit}>Powered by GIPHY</Text>;

  return (
    <GorhomSheetModal visible={visible} onClose={onClose} snapPoints={snapPoints}>
      {loading ? (
        <View style={{ flex: 1 }}>
          {listHeader}
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        </View>
      ) : error ? (
        <View style={{ flex: 1 }}>
          {listHeader}
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
          {listFooter}
        </View>
      ) : (
        <BottomSheetFlatList
          data={items}
          key={`${tab}-${query}`}
          keyExtractor={(item) => item.id}
          numColumns={3}
          contentContainerStyle={styles.grid}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.cell}
              activeOpacity={0.85}
              onPress={() => handleSelect(item)}
            >
              <Image
                source={{ uri: item.previewUrl }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No results found.</Text>
            </View>
          }
        />
      )}
    </GorhomSheetModal>
  );
}
