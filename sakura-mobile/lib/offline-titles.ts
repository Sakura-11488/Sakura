import * as FileSystem from 'expo-file-system/legacy';
import type { MangaChapter } from '@/lib/manga';
import type { ScrapedSource } from '@/lib/scraped-sources';

/**
 * Title snapshots: enough of a series (detail + full chapter list) to render
 * its page with no network, saved alongside its downloaded chapters.
 *
 * Why a separate record rather than the API cache: lib/cache.ts is a short-TTL
 * cache that drops expired entries on load, and on web it lives in
 * localStorage next to reading progress. A downloaded series has to open a week
 * later in airplane mode, so its metadata needs the same lifetime as its pages.
 *
 * This is the native half: one JSON file per title under documentDirectory.
 * Native covers come from expo-image's own disk cache, so `coverUri` is never
 * set here. lib/offline-titles.web.ts keeps the same surface on Cache Storage
 * and also stores the cover bytes. The types are duplicated there rather than
 * imported, because a .web.ts file must never import its own base specifier
 * (on web it resolves to itself) — keep the two in step.
 *
 * Everything here is best-effort: a snapshot that fails to save costs the
 * offline page, never the download it accompanies, so nothing rejects.
 */

export type OfflineTitleSource = 'atsu' | ScrapedSource;

export interface OfflineTitleDetail {
  id: string;
  title: string;
  cover: string;
  description?: string;
  genres?: string[];
  status?: string;
  type?: string;
  rating?: number;
  author?: string;
}

export interface OfflineTitleSnapshot {
  source: OfflineTitleSource;
  contentId: string;
  detail: OfflineTitleDetail;
  chapters: MangaChapter[];
  savedAt: number;
  /** Same-origin URL of the stored cover. Web only; undefined on native. */
  coverUri?: string;
}

const SOURCES: ReadonlySet<string> = new Set(['atsu', 'comics', 'hentai', 'manhwa']);

const ROOT = `${FileSystem.documentDirectory}sakura_offline_titles/`;

/** Flat directory so listing is one readDirectory; the separator never survives encodeURIComponent. */
function fileFor(source: OfflineTitleSource, contentId: string): string {
  return `${ROOT}${encodeURIComponent(source)}~${encodeURIComponent(contentId)}.json`;
}

function parseSnapshot(raw: unknown): OfflineTitleSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<OfflineTitleSnapshot>;
  if (typeof s.source !== 'string' || !SOURCES.has(s.source)) return null;
  if (typeof s.contentId !== 'string' || !s.contentId) return null;
  if (!s.detail || typeof s.detail !== 'object' || typeof s.detail.title !== 'string') return null;
  return {
    source: s.source,
    contentId: s.contentId,
    detail: s.detail,
    chapters: Array.isArray(s.chapters) ? s.chapters : [],
    savedAt: typeof s.savedAt === 'number' ? s.savedAt : 0,
  };
}

const queues = new Map<string, Promise<void>>();
function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task).catch(() => undefined);
  queues.set(key, run);
  void run.then(() => { if (queues.get(key) === run) queues.delete(key); });
  return run;
}

export async function saveOfflineTitle(input: {
  source: OfflineTitleSource;
  contentId: string;
  detail: OfflineTitleDetail;
  chapters: MangaChapter[];
}): Promise<void> {
  if (!input.contentId || !SOURCES.has(input.source)) return;
  await enqueue(fileFor(input.source, input.contentId), async () => {
    const snapshot: OfflineTitleSnapshot = {
      source: input.source,
      contentId: input.contentId,
      detail: input.detail,
      chapters: input.chapters,
      savedAt: Date.now(),
    };
    try {
      await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
      await FileSystem.writeAsStringAsync(fileFor(input.source, input.contentId), JSON.stringify(snapshot));
    } catch {
      // Best-effort; see the module comment.
    }
  });
}

export async function getOfflineTitle(
  source: OfflineTitleSource,
  contentId: string,
): Promise<OfflineTitleSnapshot | null> {
  try {
    const path = fileFor(source, contentId);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    return parseSnapshot(JSON.parse(await FileSystem.readAsStringAsync(path)));
  } catch {
    return null;
  }
}

export async function deleteOfflineTitle(source: OfflineTitleSource, contentId: string): Promise<void> {
  await enqueue(fileFor(source, contentId), async () => {
    try {
      await FileSystem.deleteAsync(fileFor(source, contentId), { idempotent: true });
    } catch {
      // ignore
    }
  });
}

/** Every saved snapshot, most recently saved first. */
export async function listOfflineTitles(): Promise<OfflineTitleSnapshot[]> {
  await Promise.all([...queues.values()]);
  let files: string[] = [];
  try {
    const info = await FileSystem.getInfoAsync(ROOT);
    if (!info.exists) return [];
    files = await FileSystem.readDirectoryAsync(ROOT);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          return parseSnapshot(JSON.parse(await FileSystem.readAsStringAsync(ROOT + f)));
        } catch {
          return null;
        }
      }),
  );
  return rows
    .filter((row): row is OfflineTitleSnapshot => row !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}
