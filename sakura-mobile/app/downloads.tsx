import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { confirmDestructive } from '@/lib/confirm-alert';
import { CAN_SAVE_ANIME_VIDEO, downloadAnimeEpisodeWithDeviceCopy, requestAnimeVideoSave } from '@/lib/anime-device-save';
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
import { listOfflineTitles, type OfflineTitleSource } from '@/lib/offline-titles';
import CoverImage from '@/components/ui/CoverImage';
import { playTap, onTap } from '@/lib/sound';

type DownloadRow =
  | { kind: 'anime'; data: OfflineEpisode }
  | { kind: 'manga'; data: OfflineMangaChapter }
  | { kind: 'novel'; data: OfflineNovelChapter }
  | { kind: 'scraped'; data: OfflineScrapedChapter };

/** Rows that belong to a manga-like series and are grouped under it. */
type SeriesRow = Extract<DownloadRow, { kind: 'manga' | 'scraped' }>;

/** One downloaded series, shown as a header above its chapters. */
interface SeriesInfo {
  /** `${source}:${contentId}`, the same pair the title snapshots are keyed by. */
  key: string;
  /** 'atsu' for the default manga source, else the scraped source key. */
  source: OfflineTitleSource;
  contentId: string;
  title: string;
  /** Remote cover from the newest row; the stored one is preferred when present. */
  cover: string;
  ready: number;
  total: number;
}

type DownloadSection = {
  key: string;
  /** Kind heading ("Manga", "Manhwa", …). */
  title: string;
  /** Only the first series of a kind repeats the kind heading. */
  showHeading: boolean;
  series?: SeriesInfo;
  data: DownloadRow[];
};

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function seriesKey(source: OfflineTitleSource, contentId: string): string {
  return `${source}:${contentId}`;
}

/**
 * Chapters grouped by series: newest-touched series first, chapters in
 * reading order within each. A flat list of "Ch 12 · Ch 3 · Ch 40" across
 * several titles was the whole Downloads screen before, with no way from a
 * chapter back to its series — offline, the only way to reach one.
 */
function groupBySeries(rows: SeriesRow[], source: OfflineTitleSource, heading: string): DownloadSection[] {
  const groups = new Map<string, SeriesRow[]>();
  for (const row of rows) {
    const list = groups.get(row.data.mangaId);
    if (list) list.push(row);
    else groups.set(row.data.mangaId, [row]);
  }
  const newest = (list: SeriesRow[]) => Math.max(...list.map((r) => r.data.updatedAt || 0));
  return [...groups.entries()]
    .sort(([, a], [, b]) => newest(b) - newest(a))
    .map(([contentId, list], index) => {
      const latest = [...list].sort((a, b) => (b.data.updatedAt || 0) - (a.data.updatedAt || 0))[0];
      return {
        key: seriesKey(source, contentId),
        title: heading,
        showHeading: index === 0,
        series: {
          key: seriesKey(source, contentId),
          source,
          contentId,
          title: latest.data.title,
          cover: latest.data.cover,
          ready: list.filter((r) => r.data.status === 'ready').length,
          total: list.length,
        },
        data: [...list].sort((a, b) => a.data.chapterNumber - b.data.chapterNumber),
      };
    });
}

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
  const [sections, setSections] = useState<DownloadSection[]>([]);
  /**
   * Stored covers (web: Cache Storage, served by the service worker), keyed
   * by series. Row covers are remote URLs, which offline render as nothing.
   */
  const [storedCovers, setStoredCovers] = useState<Record<string, string>>({});
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
    // allSettled, not all: one store failing — an evicted cache, a corrupt
    // manifest — rejected the whole refresh and left the screen saying "No
    // downloads yet" while every other store was full.
    void Promise.allSettled([
      listOfflineEpisodes(),
      listOfflineMangaChapters(),
      listOfflineNovelChapters(),
      listScrapedOfflineChapters(),
      getAnimeBytes(),
      getOfflineMangaStorageBytes(),
      getOfflineNovelStorageBytes(),
      getScrapedOfflineStorageBytes(),
    ]).then(([animeR, mangaR, novelR, scrapedR, abR, mbR, nbR, sbR]) => {
      const anime = settled(animeR, [] as OfflineEpisode[]);
      const manga = settled(mangaR, [] as OfflineMangaChapter[]);
      const novel = settled(novelR, [] as OfflineNovelChapter[]);
      const scraped = settled(scrapedR, [] as OfflineScrapedChapter[]);
      const total = settled(abR, 0) + settled(mbR, 0) + settled(nbR, 0) + settled(sbR, 0);
      setStorageLabel(formatBytes(total));

      const next: DownloadSection[] = [];
      if (anime.length) {
        next.push({
          key: 'anime',
          title: 'Anime',
          showHeading: true,
          data: anime.map((data) => ({ kind: 'anime' as const, data })),
        });
      }
      next.push(
        ...groupBySeries(
          manga.map((data) => ({ kind: 'manga' as const, data })),
          'atsu',
          'Manga',
        ),
      );
      if (novel.length) {
        next.push({
          key: 'novels',
          title: 'Novels',
          showHeading: true,
          data: novel.map((data) => ({ kind: 'novel' as const, data })),
        });
      }
      // One heading per scraped source, in registry order, so a new scraper's
      // downloads can't end up invisible here just because nobody added a
      // matching filter+push block.
      for (const key of SCRAPED_SOURCE_KEYS) {
        const rows = scraped.filter((c) => c.source === key);
        if (!rows.length) continue;
        next.push(
          ...groupBySeries(
            rows.map((data) => ({ kind: 'scraped' as const, data })),
            key,
            SCRAPED_SOURCES[key].label,
          ),
        );
      }
      setSections(next);
    });
  }, []);

  // Stored covers change only when a series gains or loses its snapshot, so
  // they are read when the set of series changes and on focus — not on the
  // two-second progress refresh, which would re-read every snapshot (each
  // carrying a full chapter list) every two seconds.
  const seriesSignature = useMemo(
    () => sections.map((sec) => sec.series?.key).filter(Boolean).join('|'),
    [sections],
  );
  const loadCovers = useCallback(() => {
    void listOfflineTitles()
      .then((titles) => {
        const map: Record<string, string> = {};
        for (const t of titles) if (t.coverUri) map[seriesKey(t.source, t.contentId)] = t.coverUri;
        setStoredCovers(map);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (seriesSignature) loadCovers();
  }, [seriesSignature, loadCovers]);

  // Once per app run, flip any download left mid-flight by a previous session
  // (killed app, crash) from "downloading" to a resumable state so it stops
  // showing a spinner that never advances. Settled, so one store cannot stop
  // the list from loading.
  useEffect(() => {
    void Promise.allSettled([
      reconcileInterruptedEpisodes(),
      reconcileInterruptedMangaChapters(),
      reconcileInterruptedNovelChapters(),
      reconcileInterruptedScrapedChapters(),
    ]).then(refresh);
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      loadCovers();
      const t = setInterval(refresh, 2000);
      return () => clearInterval(t);
    }, [refresh, loadCovers]),
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
        seriesHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: Spacing.sm,
          paddingVertical: Spacing.xs,
          marginBottom: Spacing.xs,
        },
        seriesThumb: { width: 40, height: 56, borderRadius: Radius.xs, overflow: 'hidden' },
        /** Chapters sit under their series header, so they lose the thumbnail and indent. */
        groupedRow: { marginLeft: Spacing.sm },
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
    // Narrow before building the target rather than casting: only these kinds
    // are stored in Cache Storage, so only these can be read back. atsu manga
    // joined them when it got a web store (lib/manga-offline.web.ts).
    if (row.kind === 'anime') return;
    playTap();

    const target: ExportTarget =
      row.kind === 'novel'
        ? {
            kind: 'novel',
            novelPath: row.data.novelPath,
            chapterPath: row.data.chapterPath,
            label: `${row.data.title} - ${row.data.chapterTitle}`,
          }
        : row.kind === 'manga'
          ? {
              kind: 'manga',
              mangaId: row.data.mangaId,
              chapterId: row.data.chapterId,
              pageCount: row.data.pageCount,
              label: `${row.data.title} - Ch ${row.data.chapterNumber}`,
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
        afterStoreCall(deleteOfflineEpisode(row.data.animeId, row.data.episodeId), 'Could not delete');
      } else if (row.kind === 'manga') {
        afterStoreCall(deleteOfflineMangaChapter(row.data.mangaId, row.data.chapterId), 'Could not delete');
      } else if (row.kind === 'scraped') {
        afterStoreCall(deleteScrapedOfflineChapter(row.data.source, row.data.mangaId, row.data.chapterId), 'Could not delete');
      } else {
        afterStoreCall(deleteOfflineNovelChapter(row.data.novelPath, row.data.chapterPath), 'Could not delete');
      }
    });
  };

  /**
   * Refresh once a store call finishes, and say so when it fails. The
   * download calls reject on failure — the web stores with a reason worth
   * reading ("Not enough space…", "You're offline…") — and a bare
   * `.then(refresh)` left that as an unhandled rejection and the row as the
   * only clue.
   */
  function afterStoreCall(work: Promise<unknown>, fallback: string) {
    work.then(refresh, (e: unknown) => {
      setNotice(e instanceof Error && e.message ? e.message : fallback);
      refresh();
    });
  }

  const openSeries = (series: SeriesInfo) => {
    playTap();
    // With its source: without it a manhwa or comic would open as atsu. The
    // manga page renders from the stored snapshot when offline.
    router.push({
      pathname: '/manga/[id]',
      params: {
        id: series.contentId,
        ...(series.source !== 'atsu' ? { source: series.source } : {}),
      },
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
      // No `gated` param: a downloaded chapter opens without a pass check (it
      // needed access to be downloaded, and the check needs the network). The
      // manga page and the reader follow the same rule.
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
        afterStoreCall(downloadAnimeEpisodeWithDeviceCopy({
          animeId,
          episodeId,
          episodeNumber,
          episodeTitle,
          title,
          cover,
          episodeThumbnail,
        }), 'Download failed');
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
        afterStoreCall(downloadMangaChapter({
          mangaId,
          chapterId,
          chapterNumber,
          chapterTitle,
          title,
          cover,
        }), 'Download failed');
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
        afterStoreCall(downloadScrapedChapter({
          source,
          contentId: mangaId,
          chapterId,
          chapterNumber,
          chapterTitle,
          title,
          cover,
        }), 'Download failed');
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
      afterStoreCall(downloadAnimeEpisodeWithDeviceCopy({
        animeId,
        episodeId,
        episodeNumber,
        episodeTitle,
        title,
        cover,
        episodeThumbnail,
      }), 'Download failed');
    } else if (row.kind === 'manga') {
      const { mangaId, chapterId, chapterNumber, chapterTitle, title, cover } = row.data;
      afterStoreCall(downloadMangaChapter({
        mangaId,
        chapterId,
        chapterNumber,
        chapterTitle,
        title,
        cover,
      }), 'Download failed');
    } else if (row.kind === 'scraped') {
      const { source, mangaId, chapterId, chapterNumber, chapterTitle, title, cover } = row.data;
      afterStoreCall(downloadScrapedChapter({
        source,
        contentId: mangaId,
        chapterId,
        chapterNumber,
        chapterTitle,
        title,
        cover,
      }), 'Download failed');
    } else {
      const { novelPath, chapterPath, chapterNumber, chapterTitle, title, cover } = row.data;
      afterStoreCall(downloadNovelChapter({
        novelPath,
        chapterPath,
        chapterNumber,
        chapterTitle,
        title,
        cover,
      }), 'Download failed');
    }
  };

  const renderRow = (row: DownloadRow) => {
    const statusLabel =
      row.data.status === 'ready'
        ? row.kind === 'anime' ? 'Saved in Sakura' : 'Ready'
        : row.data.status === 'paused'
          ? `Paused · ${Math.round(row.data.progress * 100)}%`
          : row.data.status === 'downloading'
            ? `${Math.round(row.data.progress * 100)}%`
            : row.data.error || 'Failed';

    // Manga-like chapters sit under their series header, which carries the
    // title and cover; repeating both on every chapter was most of the row.
    const grouped = row.kind === 'manga' || row.kind === 'scraped';
    const thumb =
      row.kind === 'anime'
        ? row.data.episodeThumbnail || row.data.cover
        : row.data.cover;

    const name = grouped
      ? `Ch ${row.data.chapterNumber} · ${row.data.chapterTitle}`
      : row.data.title;
    const meta =
      row.kind === 'anime'
        ? `Ep ${row.data.episodeNumber} · ${row.data.episodeTitle}`
        : grouped
          ? row.data.pageCount > 0 ? `${row.data.pageCount} pages` : ''
          : row.data.chapterTitle;

    return (
      <TouchableOpacity
        style={[styles.row, grouped && styles.groupedRow]}
        activeOpacity={row.data.status === 'ready' ? 0.85 : 1}
        onPress={() => openRow(row)}
      >
        {grouped ? null : thumb ? (
          <Image source={{ uri: thumb }} style={styles.thumb} contentFit="cover" />
        ) : (
          <View style={[styles.thumb, { backgroundColor: colors.border }]} />
        )}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
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
            {CAN_SAVE_ANIME_VIDEO && row.kind === 'anime' && row.data.status === 'ready' ? (
              <TouchableOpacity
                style={styles.deleteBtn}
                accessibilityRole="button"
                accessibilityLabel={`Save video: ${row.data.title}, episode ${row.data.episodeNumber}`}
                onPress={() => { playTap(); requestAnimeVideoSave(row.data.animeId, row.data.episodeId); }}
              >
                <Text style={[styles.deleteText, { color: colors.primary }]}>Save video</Text>
              </TouchableOpacity>
            ) : null}
            {CAN_EXPORT_OFFLINE && row.data.status === 'ready' && row.kind !== 'anime' ? (
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

  const renderSeriesHeader = (series: SeriesInfo) => {
    // The stored cover first: it is same-origin and works offline. The row's
    // remote cover goes through CoverImage, which on web routes atsu and
    // manhwa posters through the cover proxy just like the rest of the app.
    const cover = storedCovers[series.key] || series.cover;
    return (
      <View style={styles.seriesHeader}>
        {cover ? (
          <CoverImage source={{ uri: cover }} style={styles.seriesThumb} contentFit="cover" />
        ) : (
          <View style={[styles.seriesThumb, { backgroundColor: colors.border }]} />
        )}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={2}>
            {series.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {series.ready === series.total
              ? `${series.total} ${series.total === 1 ? 'chapter' : 'chapters'}`
              : `${series.ready} of ${series.total} chapters ready`}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => openSeries(series)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${series.title}`}
        >
          <Text style={[styles.deleteText, { color: colors.primary }]}>Open series</Text>
        </TouchableOpacity>
      </View>
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
          {' '}Save video creates an MP4 file. Files saved to your device survive clearing Sakura’s site data.
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
          // Series headers are cards, not labels; pinned they would stack
          // over the chapters scrolling beneath them.
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View>
              {section.showHeading ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
              {section.series ? renderSeriesHeader(section.series) : null}
            </View>
          )}
          renderItem={({ item }) => renderRow(item)}
        />
      )}
    </SafeAreaView>
  );
}
