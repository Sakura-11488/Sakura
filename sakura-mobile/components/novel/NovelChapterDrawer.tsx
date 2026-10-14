import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  type ListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AllNovelChapter } from '@/lib/allnovel';
import { filterChapters, type ChapterReadState } from '@/lib/novel-navigation';
import type { NovelReaderPalette } from '@/lib/novel-reader-prefs';

const ROW_H = 56;

export interface NovelChapterDrawerProps {
  visible: boolean;
  onClose: () => void;
  palette: NovelReaderPalette;
  novelTitle: string;
  /** Reading order. Null while loading. */
  chapters: AllNovelChapter[] | null;
  error: boolean;
  onRetry: () => void;
  currentPath: string;
  currentProgress: number;
  readState: ChapterReadState | null;
  onSelect: (chapter: AllNovelChapter) => void;
}

/**
 * Table of contents inside the reader.
 *
 * The end of every chapter used to be a dead end: reading on meant going back
 * to the detail page (≈1.3 s to load its list) and paging through 40-row pages
 * of up to 99 to find the next row. The list opens scrolled to the current
 * chapter, is virtualised with a fixed row height (novels here run to 6,000+
 * chapters), and filters by number or title like the detail page does.
 */
export default function NovelChapterDrawer({
  visible,
  onClose,
  palette,
  novelTitle,
  chapters,
  error,
  onRetry,
  currentPath,
  currentProgress,
  readState,
  onSelect,
}: NovelChapterDrawerProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  // Each opening starts from the current chapter, not from an old search.
  useEffect(() => {
    if (visible) setQuery('');
  }, [visible]);
  const filtered = useMemo(() => (chapters ? filterChapters(chapters, query) : []), [chapters, query]);
  const currentIndex = useMemo(() => filtered.findIndex((c) => c.path === currentPath), [filtered, currentPath]);

  const getItemLayout = useCallback(
    (_: ArrayLike<AllNovelChapter> | null | undefined, index: number) => ({ length: ROW_H, offset: ROW_H * index, index }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<AllNovelChapter>) => {
      const current = item.path === currentPath;
      const finished = !current && !!readState?.finished.has(item.path);
      const partial = !current ? readState?.partial.get(item.path) : undefined;
      const status = current
        ? `Reading · ${Math.round(currentProgress * 100)}%`
        : finished
        ? 'Read'
        : partial != null
        ? `${Math.round(partial * 100)}% read`
        : '';
      return (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ selected: current }}
          accessibilityLabel={`${item.name || `Chapter ${item.chapterNumber}`}${status ? `, ${status}` : ''}`}
          onPress={() => onSelect(item)}
          activeOpacity={0.75}
          style={[s.row, { borderBottomColor: palette.rule }, current && { backgroundColor: palette.card }]}
        >
          <Text style={[s.num, { color: current ? palette.accent : palette.muted }]}>{item.chapterNumber}</Text>
          <View style={s.rowText}>
            <Text numberOfLines={1} style={[s.name, { color: finished ? palette.muted : palette.text }, current && { fontWeight: '700' }]}>
              {item.name || `Chapter ${item.chapterNumber}`}
            </Text>
            {status ? <Text style={[s.status, { color: current ? palette.accent : palette.muted }]}>{status}</Text> : null}
          </View>
          {finished ? <Text style={[s.check, { color: palette.muted }]}>✓</Text> : null}
        </TouchableOpacity>
      );
    },
    [currentPath, currentProgress, onSelect, palette, readState],
  );

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close contents" />
        <View style={[s.sheet, { backgroundColor: palette.bg, borderColor: palette.rule, paddingBottom: insets.bottom }]}>
          <View style={s.head}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.eyebrow, { color: palette.accent }]}>CONTENTS</Text>
              <Text numberOfLines={1} style={[s.title, { color: palette.text }]} accessibilityRole="header">
                {novelTitle || 'Chapters'}
              </Text>
              {chapters ? (
                <Text style={[s.sub, { color: palette.muted }]}>
                  {chapters.length.toLocaleString()} {chapters.length === 1 ? 'chapter' : 'chapters'}
                  {readState ? ` · ${readState.finished.size.toLocaleString()} read` : ''}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close contents" onPress={onClose} style={s.close}>
              <Text style={[s.closeText, { color: palette.text }]}>✕</Text>
            </TouchableOpacity>
          </View>
          {chapters && chapters.length > 12 ? (
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Find a chapter by number or title"
              placeholderTextColor={palette.muted}
              accessibilityLabel="Find a chapter by number or title"
              style={[s.search, { color: palette.text, backgroundColor: palette.card }]}
              returnKeyType="search"
              autoCorrect={false}
            />
          ) : null}
          {chapters == null ? (
            <View style={s.center}>
              {error ? (
                <>
                  <Text style={[s.sub, { color: palette.muted, textAlign: 'center' }]}>The chapter list could not be loaded.</Text>
                  <TouchableOpacity accessibilityRole="button" onPress={onRetry} style={[s.retry, { borderColor: palette.accent }]}>
                    <Text style={{ color: palette.accent, fontWeight: '700' }}>Try again</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <ActivityIndicator color={palette.accent} />
                  <Text style={[s.sub, { color: palette.muted }]}>Loading chapters…</Text>
                </>
              )}
            </View>
          ) : filtered.length === 0 ? (
            <View style={s.center}>
              <Text style={[s.sub, { color: palette.muted }]}>No chapters match “{query.trim()}”.</Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(c) => c.path}
              renderItem={renderItem}
              getItemLayout={getItemLayout}
              initialScrollIndex={currentIndex > 2 ? currentIndex - 2 : 0}
              initialNumToRender={16}
              maxToRenderPerBatch={16}
              windowSize={7}
              keyboardShouldPersistTaps="handled"
              style={s.list}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    width: '100%',
    maxWidth: 620,
    height: '86%',
    alignSelf: 'center',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 },
  eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: '700', marginBottom: 4 },
  title: { fontSize: 18, fontWeight: '700' },
  sub: { fontSize: 12, marginTop: 3 },
  close: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  closeText: { fontSize: 18 },
  search: { marginHorizontal: 16, marginBottom: 8, borderRadius: 12, paddingHorizontal: 14, height: 42, fontSize: 14 },
  list: { flex: 1 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  num: { width: 44, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: 14 },
  status: { fontSize: 11, marginTop: 2 },
  check: { fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  retry: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9, marginTop: 6 },
});
