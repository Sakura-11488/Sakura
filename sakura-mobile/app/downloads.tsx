import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { confirmDestructive } from '@/lib/confirm-alert';
import { CAN_EXPORT_OFFLINE, exportDownloadedChapter, type ExportTarget } from '@/lib/offline-export';
import {
  Platform,
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { Spacing, Radius, FontSize, FontWeight, Fonts } from '@/constants/theme';
import { useTheme } from '@/lib/theme';
import EmptyState from '@/components/ui/EmptyState';
import {
  deleteOfflineEpisode,
  formatBytes,
  getOfflineStorageBytes as getAnimeBytes,
  listOfflineEpisodes,
  reconcileInterruptedEpisodes,
  pauseAnimeEpisodeDownload,
  resumeAnimeEpisodeDownload,
  downloadAnimeEpisode,
  type OfflineEpisode,
} from '@/lib/anime-offline';
import {
  deleteOfflineMangaChapter,
  getOfflineMangaStorageBytes,
  listOfflineMangaChapters,
  reconcileInterruptedMangaChapters,
  pauseMangaChapterDownload,
  resumeMangaChapterDownload,
  downloadMangaChapter,
  type OfflineMangaChapter,
} from '@/lib/manga-offline';
import {
  deleteOfflineNovelChapter,
  getOfflineNovelStorageBytes,
  listOfflineNovelChapters,
  reconcileInterruptedNovelChapters,
  downloadNovelChapter,
  type OfflineNovelChapter,
} from '@/lib/novel-offline';
import {
  listScrapedOfflineChapters,
  getScrapedOfflineStorageBytes,
  reconcileInterruptedScrapedChapters,
  deleteScrapedOfflineChapter,
  downloadScrapedChapter,
  pauseScrapedChapterDownload,
  resumeScrapedChapterDownload,
  type OfflineScrapedChapter,
} from '@/lib/scraped-offline';
import { SCRAPED_SOURCES, SCRAPED_SOURCE_KEYS } from '@/lib/scraped-sources';
import { playTap, onTap } from '@/lib/sound';

type DownloadRow =
  | { kind: 'anime'; data: OfflineEpisode }
  | { kind: 'manga'; data: OfflineMangaChapter }
  | { kind: 'novel'; data: OfflineNovelChapter }
  | { kind: 'scraped'; data: OfflineScrapedChapter };

/** Stable per-row identity, so only the row being saved shows progress. */
function rowKey(row: DownloadRow): string {
  if (row.kind === 'anime') return `anime:${row.data.animeId}:${row.data.episodeId}`;
  if (row.kind === 'manga') return `manga:${row.data.mangaId}:${row.data.chapterId}`;
  if (row.kind === 'scraped') return `${row.data.source}:${row.data.mangaId}:${row.data.chapterId}`;
  return `novel:${row.data.novelPath}:${row.data.chapterPath}`;
}

function BackIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function DownloadsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [sections, setSections] = useState<{ title: string; data: DownloadRow[] }[]>([]);
  const [storageLabel, setStorageLabel] = useState('');
  // Web only. Whether the browser has granted durable storage for this
  // origin, which decides which of the two honest sentences the header shows.
  const [persistedStorage, setPersistedStorage] = useState(false);
  /** Row currently being written out, so its button can show progress. */
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let alive = true;
    void (async () => {
      try {
        const persisted = await navigator.storage?.persisted?.();
        if (alive) setPersistedStorage(!!persisted);
      } catch {
        // Treated as not-persisted, which is the cautious message.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(() => {
    Promise.all([
      listOfflineEpisodes(),
      listOfflineMangaChapters(),
      listOfflineNovelChapters(),
      listScrapedOfflineChapters(),
      getAnimeBytes(),
      getOfflineMangaStorageBytes(),
      getOfflineNovelStorageBytes(),
      getScrapedOfflineStorageBytes(),
    ]).then(([anime, manga, novel, scraped, ab, mb, nb, sb]) => {
      const total = ab + mb + nb + sb;
      setStorageLabel(formatBytes(total));

      const next: { title: string; data: DownloadRow[] }[] = [];
      if (anime.length) {
        next.push({
          title: 'Anime',
          data: anime.map((data) => ({ kind: 'anime' as const, data })),
        });
      }
      if (manga.length) {
        next.push({
          title: 'Manga',
          data: manga.map((data) => ({ kind: 'manga' as const, data })),
        });
      }
      if (novel.length) {
        next.push({
          title: 'Novels',
          data: novel.map((data) => ({ kind: 'novel' as const, data })),
        });
      }
      // One section per scraped source, in registry order, so a new scraper's
      // downloads can't end up invisible here just because nobody added a
      // matching filter+push block.
      for (const key of SCRAPED_SOURCE_KEYS) {
        const rows = scraped.filter((c) => c.source === key);
        if (!rows.length) continue;
        next.push({
          title: SCRAPED_SOURCES[key].label,
          data: rows.map((data) => ({ kind: 'scraped' as const, data })),
        });
      }
      setSections(next);
    });
  }, []);

  // Once per app run, flip any download left mid-flight by a previous session
  // (killed app, crash) from "downloading" to a resumable state so it stops
  // showing a spinner that never advances.
  useEffect(() => {
    Promise.all([
      reconcileInterruptedEpisodes(),
      reconcileInterruptedMangaChapters(),
      reconcileInterruptedNovelChapters(),
      reconcileInterruptedScrapedChapters(),
    ]).then(refresh);
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      const t = setInterval(refresh, 2000);
      return () => clearInterval(t);
    }, [refresh]),
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        safe: { flex: 1, backgroundColor: colors.background },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: Spacing.md,
          paddingVertical: Spacing.sm,
          gap: Spacing.sm,
        },
        title: {
          flex: 1,
          fontFamily: Fonts.display,
          fontSize: 28,
          fontWeight: FontWeight.bold,
          color: colors.text,
        },
        sub: {
          fontSize: FontSize.sm,
          color: colors.textSecondary,
          paddingHorizontal: Spacing.md,
          marginBottom: Spacing.md,
        },
        sectionTitle: {
          fontSize: FontSize.xs,
          fontWeight: FontWeight.bold,
          color: colors.textSecondary,
          paddingHorizontal: Spacing.md,
          marginTop: Spacing.sm,
          marginBottom: Spacing.xs,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        },
        list: { paddingHorizontal: Spacing.md, paddingBottom: 120 },
        row: {
          flexDirection: 'row',
          gap: Spacing.sm,
          padding: Spacing.sm,
          borderRadius: Radius.lg,
          backgroundColor: colors.white,
          marginBottom: Spacing.sm,
          alignItems: 'center',
        },
        thumb: { width: 72, height: 48, borderRadius: Radius.xs },
        info: { flex: 1, gap: 4 },
        name: { fontSize: FontSize.sm, fontWeight: FontWeight.semibold, color: colors.text },
        meta: { fontSize: FontSize.xs, color: colors.textSecondary },
        badge: {
          fontSize: 10,
          fontWeight: FontWeight.bold,
          color: colors.primary,
          textTransform: 'uppercase',
        },
        deleteBtn: { padding: 8 },
        rowActions: { flexDirection: 'row', alignItems: 'center' },
        deleteText: { color: colors.red, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
        empty: {
          flex: 1,
          justifyContent: 'center',
        },
      }),
    [colors],
  );

  /**
   * Write a durable copy to the browser's Downloads folder.
   *
   * The library copy lives in Cache Storage and the browser may reclaim it;
   * a file in Downloads sits outside the quota system and cannot be evicted.
   * Costs no network — every byte is already on the device.
   */
  const saveCopy = (row: DownloadRow) => {
    // Narrow before building the target rather than casting: only these two
    // kinds are stored in Cache Storage, so only these two can be read back.
    if (row.kind !== 'novel' && row.kind !== 'scraped') return;
    playTap();

    const target: ExportTarget =
      row.kind === 'novel'
        ? {
            kind: 'novel',
            novelPath: row.data.novelPath,
            chapterPath: row.data.chapterPath,
            label: `${row.data.title} - ${row.data.chapterTitle}`,
          }
        : {
            kind: 'scraped',
            source: row.data.source,
            contentId: row.data.mangaId,
            chapterId: row.data.chapterId,
            pageCount: row.data.pageCount,
            label: `${row.data.title} - Ch ${row.data.chapterNumber}`,
          };

    setSaving(rowKey(row));
    void (async () => {
      try {
        const res = await exportDownloadedChapter(target);
        setNotice(`Saved ${res.filename} to your Downloads folder`);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not save a copy');
      } finally {
        setSaving(null);
      }
    })();
  };

  const confirmDelete = (row: DownloadRow) => {
    const label =
      row.kind === 'anime'
        ? `${row.data.title} Ep ${row.data.episodeNumber}`
        : row.kind === 'manga'
          ? `${row.data.title} Ch ${row.data.chapterNumber}`
          : `${row.data.title} — ${row.data.chapterTitle}`;
    // confirmDestructive, not Alert.alert: react-native-web implements Alert
    // as an empty function, so on web this dialog never appeared and Delete
    // did nothing at all. That was invisible while web had no downloads to
    // delete; now that it does, it would be a button that silently lies.
    void confirmDestructive('Delete download', `Remove ${label}?`).then((ok) => {
      if (!ok) return;
      if (row.kind === 'anime') {
        deleteOfflineEpisode(row.data.animeId, row.data.episodeId).then(refresh);
      } else if (row.kind === 'manga') {
        deleteOfflineMangaChapter(row.data.mangaId, row.data.chapterId).then(refresh);
      } else if (row.kind === 'scraped') {
        deleteScrapedOfflineChapter(row.data.source, row.data.mangaId, row.data.chapterId).then(refresh);
      } else {
        deleteOfflineNovelChapter(row.data.novelPath, row.data.chapterPath).then(refresh);
      }
    });
  };

  const openRow = (row: DownloadRow) => {
    if (row.data.status !== 'ready') return;
    playTap();
    if (row.kind === 'anime') {
      router.push({
        pathname: '/anime/watch',
        params: { id: row.data.animeId, ep: row.data.episodeId, offline: '1' },
      });
      return;
    }
    if (row.kind === 'manga') {
      router.push({
        pathname: '/chapter/[id]',
        params: {
          id: `${row.data.mangaId}~${row.data.chapterId}`,
          offline: '1',
          title: row.data.title,
          cover: row.data.cover,
          chapter: row.data.chapterTitle,
        },
      });
      return;
    }
    if (row.kind === 'scraped') {
      router.push({
        pathname: '/chapter/[id]',
        params: {
          id: `${row.data.mangaId}~${row.data.chapterId}`,
          offline: '1',
          source: row.data.source,
          title: row.data.title,
          cover: row.data.cover,
          chapter: row.data.chapterTitle,
        },
      });
      return;
    }
    router.push({
      pathname: '/novel/read',
      params: {
        path: row.data.chapterPath,
        novelPath: row.data.novelPath,
        offline: '1',
        title: row.data.title,
        cover: row.data.cover,
        chapter: row.data.chapterTitle,
      },
    });
  };

  const handlePauseResume = (row: DownloadRow) => {
    playTap();
    if (row.kind === 'anime') {
      const { animeId, episodeId, episodeNumber, episodeTitle, title, cover, episodeThumbnail } = row.data;
      if (row.data.status === 'downloading') {
        pauseAnimeEpisodeDownload(animeId, episodeId);
        return;
      }
      if (row.data.status === 'paused') {
        resumeAnimeEpisodeDownload(animeId, episodeId);
        void downloadAnimeEpisode({
          animeId,
          episodeId,
          episodeNumber,
          episodeTitle,
          title,
          cover,
          episodeThumbnail,
        }).then(refresh);
      }
      return;
    }
    if (row.kind === 'manga') {
      const { mangaId, chapterId, chapterNumber, chapterTitle, title, cover } = row.data;
      if (row.data.status === 'downloading') {
        pauseMangaChapterDownload(mangaId, chapterId);
        return;
      }
      if (row.data.status === 'paused') {
        resumeMangaChapterDownload(mangaId, chapterId);
        void downloadMangaChapter({
          mangaId,
          chapterId,
          chapterNumber,
          chapterTitle,
          title,
          cover,
        }).then(refresh);
      }
      return;
    }
    if (row.kind === 'scraped') {
      const { source, mangaId, chapterId, chapterNumber, chapterTitle, title, cover } = row.data;
      if (row.data.status === 'downloading') {
        pauseScrapedChapterDownload(source, mangaId, chapterId);
        return;
      }
      if (row.data.status === 'paused') {
        resumeScrapedChapterDownload(source, mangaId, chapterId);
        void downloadScrapedChapter({
          source,
          contentId: mangaId,
          chapterId,
          chapterNumber,
          chapterTitle,
          title,
          cover,
        }).then(refresh);
      }
      return;
    }
    // Novels expose no pause/resume control on this screen (handled on the novel
    // page), so there's no novel branch here.
  };

  const handleRetry = (row: DownloadRow) => {
    playTap();
    if (row.kind === 'anime') {
      const { animeId, episodeId, episodeNumber, episodeTitle, title, cover, episodeThumbnail } = row.data;
      void downloadAnimeEpisode({
        animeId,
        episodeId,
        episodeNumber,
        episodeTitle,
        title,
        cover,
        episodeThumbnail,
      }).then(refresh);
    } else if (row.kind === 'manga') {
      const { mangaId, chapterId, chapterNumber, chapterTitle, title, cover } = row.data;
      void downloadMangaChapter({
        mangaId,
        chapterId,
        chapterNumber,
        chapterTitle,
        title,
        cover,
      }).then(refresh);
    } else if (row.kind === 'scraped') {
      const { source, mangaId, chapterId, chapterNumber, chapterTitle, title, cover } = row.data;
      void downloadScrapedChapter({
        source,
        contentId: mangaId,
        chapterId,
        chapterNumber,
        chapterTitle,
        title,
        cover,
      }).then(refresh);
    } else {
      const { novelPath, chapterPath, chapterNumber, chapterTitle, title, cover } = row.data;
      void downloadNovelChapter({
        novelPath,
        chapterPath,
        chapterNumber,
        chapterTitle,
        title,
        cover,
      }).then(refresh);
    }
  };

  const renderRow = (row: DownloadRow) => {
    const statusLabel =
      row.data.status === 'ready'
        ? 'Ready'
        : row.data.status === 'paused'
          ? `Paused · ${Math.round(row.data.progress * 100)}%`
          : row.data.status === 'downloading'
            ? `${Math.round(row.data.progress * 100)}%`
            : row.data.error || 'Failed';

    const thumb =
      row.kind === 'anime'
        ? row.data.episodeThumbnail || row.data.cover
        : row.data.cover;

    const name = row.data.title;
    const meta =
      row.kind === 'anime'
        ? `Ep ${row.data.episodeNumber} · ${row.data.episodeTitle}`
        : row.kind === 'manga' || row.kind === 'scraped'
          ? `Ch ${row.data.chapterNumber} · ${row.data.chapterTitle}`
          : row.data.chapterTitle;

    return (
      <TouchableOpacity
        style={styles.row}
        activeOpacity={row.data.status === 'ready' ? 0.85 : 1}
        onPress={() => openRow(row)}
      >
        {thumb ? (
          <Image source={{ uri: thumb }} style={styles.thumb} contentFit="cover" />
        ) : (
          <View style={[styles.thumb, { backgroundColor: colors.border }]} />
        )}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
          <Text style={styles.badge}>{statusLabel}</Text>
        </View>
        {/* Novels have no per-chapter pause and the Downloads screen lacks the
            chapter list needed to resume a batch, so their pause/resume lives on
            the novel page — here they show only Delete. */}
        {(row.data.status === 'downloading' || row.data.status === 'paused') && row.kind !== 'novel' ? (
          <TouchableOpacity style={styles.deleteBtn} onPress={() => handlePauseResume(row)}>
            <Text style={[styles.deleteText, { color: colors.primary }]}>
              {row.data.status === 'paused' ? 'Resume' : 'Pause'}
            </Text>
          </TouchableOpacity>
        ) : row.data.status === 'error' ? (
          <View style={styles.rowActions}>
            <TouchableOpacity style={styles.deleteBtn} onPress={() => handleRetry(row)}>
              <Text style={[styles.deleteText, { color: colors.primary }]}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.deleteBtn} onPress={() => confirmDelete(row)}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.rowActions}>
            {/*
              Web only, and only for the kinds stored in Cache Storage. The
              library copy can be reclaimed by the browser; this writes a file
              to the Downloads folder, which cannot. Costs no network — the
              bytes are already on the device.
            */}
            {CAN_EXPORT_OFFLINE && row.data.status === 'ready' &&
            (row.kind === 'scraped' || row.kind === 'novel') ? (
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => saveCopy(row)}
                disabled={saving === rowKey(row)}
              >
                <Text style={[styles.deleteText, { color: colors.primary }]}>
                  {saving === rowKey(row) ? 'Saving…' : 'Save a copy'}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.deleteBtn} onPress={() => confirmDelete(row)}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const isEmpty = sections.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onTap(() => router.back())} hitSlop={12}>
          <BackIcon color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Downloads</Text>
      </View>
      <Text style={styles.sub}>
        Offline content stored on this device{storageLabel ? ` · ${storageLabel}` : ''}
      </Text>
      {/*
        Web storage is not the same promise as native storage, and the UI has to
        say so. Downloads live in Cache Storage, which the browser may reclaim
        under storage pressure — Sakura asks for durable storage on the first
        download, but cannot guarantee it. Claiming parity with the native app
        here would be the kind of lie that only surfaces when a user is offline
        and their chapter has quietly vanished.
      */}
      {notice ? (
        <Text style={[styles.sub, { color: colors.primary }]} onPress={() => setNotice('')}>
          {notice}
        </Text>
      ) : null}
      {Platform.OS === 'web' ? (
        <Text style={[styles.sub, { opacity: 0.7 }]}>
          {persistedStorage
            ? 'Your browser has marked these as protected storage.'
            : 'Your browser may clear these if the device runs low on space.'}
        </Text>
      ) : null}

      {isEmpty ? (
        <EmptyState
          style={styles.empty}
          title="No downloads yet"
          subtitle="On anime, manga, or novel pages, tap Download while online. Keep the app open until progress finishes."
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) =>
            item.kind === 'anime'
              ? `a-${item.data.animeId}-${item.data.episodeId}`
              : item.kind === 'manga'
                ? `m-${item.data.mangaId}-${item.data.chapterId}`
                : item.kind === 'scraped'
                  ? `s-${item.data.source}-${item.data.mangaId}-${item.data.chapterId}`
                  : `n-${item.data.novelPath}-${item.data.chapterPath}`
          }
          contentContainerStyle={styles.list}
          renderSectionHeader={({ section: { title } }) => (
            <Text style={styles.sectionTitle}>{title}</Text>
          )}
          renderItem={({ item }) => renderRow(item)}
        />
      )}
    </SafeAreaView>
  );
}
