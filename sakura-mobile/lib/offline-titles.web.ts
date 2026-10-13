import type { MangaChapter } from '@/lib/manga';
import type { ScrapedSource } from '@/lib/scraped-sources';
import { coverThumbnailUrl } from '@/lib/cover-thumbnail';
import {
  OFFLINE_PREFIX,
  offlineCoverUrl,
  offlineTitleUrl,
  openOfflineLibrary,
} from '@/lib/offline-cache-keys';
import { offlineUrlsServable, readImageBody } from '@/lib/offline-image-store.web';

/**
 * Title snapshots on web: the detail and full chapter list of a series with
 * downloads, plus its cover bytes, so the series page renders with no network.
 *
 * `.web.ts` counterpart of lib/offline-titles.ts, with the same exports. It
 * must never import '@/lib/offline-titles' — on web that resolves to this
 * file — so the types below are duplicated from it; keep them in step.
 *
 * Why not the API cache: lib/cache.ts lives in localStorage with 15-30 minute
 * TTLs and drops expired entries on load, which is exactly why a downloaded
 * series opened offline used to land on "Could not load this title". These
 * records live in the same Cache Storage library as the pages
 * (LIBRARY_CACHE, never versioned or swept) and are deleted with the series'
 * last download, by the stores.
 *
 * Everything here is best-effort and never rejects: a snapshot that fails to
 * save costs the offline page, never the download it accompanies.
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

/**
 * Which titles have a snapshot, so listing does not mean walking every page
 * entry in the library with cache.keys(). Small on purpose — the snapshots
 * themselves can carry a 2000-chapter list and are read one by one.
 */
const INDEX_URL = `${OFFLINE_PREFIX}title-index.json`;
const TITLE_PATH_PREFIX = `${OFFLINE_PREFIX}title/`;
const COVER_TIMEOUT_MS = 15_000;

type IndexEntry = { source: OfflineTitleSource; contentId: string; savedAt: number };
type TitleIndex = { titles: Record<string, IndexEntry> };

function indexKey(source: string, contentId: string): string {
  return `${source}:${contentId}`;
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
    ...(typeof s.coverUri === 'string' && s.coverUri ? { coverUri: s.coverUri } : {}),
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

async function readSnapshot(cache: Cache, url: string): Promise<OfflineTitleSnapshot | null> {
  try {
    const res = await cache.match(url);
    return res ? parseSnapshot(await res.json()) : null;
  } catch {
    return null;
  }
}

// ── Index ──────────────────────────────────────────────────────────────────

const index: TitleIndex = { titles: {} };
let indexLoading: Promise<void> | null = null;
let indexWriting: Promise<void> = Promise.resolve();

function ensureIndex(cache: Cache): Promise<void> {
  if (!indexLoading) {
    indexLoading = (async () => {
      try {
        const res = await cache.match(INDEX_URL);
        if (res) {
          const parsed = (await res.json()) as Partial<TitleIndex> | null;
          if (parsed?.titles && typeof parsed.titles === 'object') {
            for (const [key, entry] of Object.entries(parsed.titles)) {
              if (entry && typeof entry === 'object' && SOURCES.has(entry.source) && typeof entry.contentId === 'string') {
                index.titles[key] = entry;
              }
            }
            return;
          }
        }
      } catch {
        // Fall through to the rebuild; a corrupt index must not hide titles.
      }
      // No index (or an unreadable one): rebuild it from the snapshots
      // themselves, once, and write it so this scan is not repeated.
      try {
        const keys = await cache.keys();
        for (const req of keys) {
          const path = new URL(req.url).pathname;
          if (!path.startsWith(TITLE_PATH_PREFIX) || !path.endsWith('.json')) continue;
          const snap = await readSnapshot(cache, path);
          if (snap) {
            index.titles[indexKey(snap.source, snap.contentId)] = {
              source: snap.source,
              contentId: snap.contentId,
              savedAt: snap.savedAt,
            };
          }
        }
      } catch {
        // Listing simply comes back shorter.
      }
      await writeIndex(cache);
    })();
  }
  return indexLoading;
}

function writeIndex(cache: Cache): Promise<void> {
  // Serialised, and serialising the CURRENT index when it runs, so the last
  // write always carries the latest state.
  indexWriting = indexWriting.then(() =>
    cache.put(INDEX_URL, jsonResponse(index)).catch(() => undefined),
  );
  return indexWriting;
}

// ── Per-title queue ────────────────────────────────────────────────────────

/**
 * Saves and deletes for one title run in order. Without this, a delete that
 * lands while a save is still fetching the cover is undone when the save
 * finishes, and the snapshot of a series with no downloads lives forever.
 */
const queues = new Map<string, Promise<void>>();

function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task).catch(() => undefined);
  queues.set(key, run);
  void run.then(() => {
    if (queues.get(key) === run) queues.delete(key);
  });
  return run;
}

// ── Cover ──────────────────────────────────────────────────────────────────

/**
 * URLs to fetch the cover from, best first: the exact URL CoverImage.web shows
 * the hero with (the /api/cover-image/ thumbnail at 512px for atsu and
 * mangaread covers), then the cover itself for sources that already serve it
 * same-origin (/api/media-proxy/ for 18+, manhwa and droplet comics).
 *
 * Only same-origin URLs are tried. Every cross-origin cover host in use sends
 * no CORS header — a raw atsu poster, Internet Archive's /services/img/ used
 * by comics — so fetching one could only fail, noisily, on every refresh. Such
 * a title is saved without a cover and shows its usual placeholder offline.
 */
function coverCandidates(cover: string): string[] {
  if (!cover || cover.startsWith(OFFLINE_PREFIX)) return [];
  const sameOrigin = (url: string) => url.startsWith('/') && !url.startsWith('//');
  const out: string[] = [];
  const thumb = coverThumbnailUrl(cover, 512);
  if (sameOrigin(thumb)) out.push(thumb);
  if (thumb !== cover && sameOrigin(cover)) out.push(cover);
  return out;
}

async function storeCover(cache: Cache, key: string, cover: string): Promise<boolean> {
  for (const url of coverCandidates(cover)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), COVER_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) continue;
      const image = await readImageBody(res);
      if (!image) continue;
      await cache.put(key, new Response(image.blob, { headers: { 'content-type': image.type } }));
      return true;
    } catch {
      // Next candidate; a quota failure here fails the rest the same way.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * Save (or refresh) a series' snapshot. Call it with the first download and on
 * later online visits; the cover is only refetched when it changed or is
 * missing, so a refresh costs one small JSON write.
 */
export async function saveOfflineTitle(input: {
  source: OfflineTitleSource;
  contentId: string;
  detail: OfflineTitleDetail;
  chapters: MangaChapter[];
}): Promise<void> {
  if (!input.contentId || !SOURCES.has(input.source)) return;
  const key = indexKey(input.source, input.contentId);
  await enqueue(key, async () => {
    const cache = await openOfflineLibrary();
    if (!cache) return;
    await ensureIndex(cache);

    const titleUrl = offlineTitleUrl(input.source, input.contentId);
    const coverKey = offlineCoverUrl(input.source, input.contentId);
    const previous = await readSnapshot(cache, titleUrl);
    const haveCover = !!(await cache.match(coverKey).catch(() => undefined));

    // Persist the metadata before fetching the optional cover. A slow cover
    // must not leave a completed chapter without its offline title page.
    const snapshot: OfflineTitleSnapshot = {
      source: input.source,
      contentId: input.contentId,
      detail: input.detail,
      chapters: input.chapters,
      savedAt: Date.now(),
      ...(haveCover ? { coverUri: coverKey } : {}),
    };
    try {
      await cache.put(titleUrl, jsonResponse(snapshot));
    } catch {
      return;
    }
    index.titles[key] = { source: input.source, contentId: input.contentId, savedAt: snapshot.savedAt };
    await writeIndex(cache);
    if ((!haveCover || previous?.detail.cover !== input.detail.cover) && await storeCover(cache, coverKey, input.detail.cover)) {
      await cache.put(titleUrl, jsonResponse({ ...snapshot, coverUri: coverKey }));
    }
  });
}

export async function getOfflineTitle(
  source: OfflineTitleSource,
  contentId: string,
): Promise<OfflineTitleSnapshot | null> {
  const cache = await openOfflineLibrary();
  if (!cache) return null;
  const snap = await readSnapshot(cache, offlineTitleUrl(source, contentId));
  if (!snap) return null;
  return withServableCover(cache, snap);
}

/**
 * Drop `coverUri` when it would not load: the cover was evicted, or this tab
 * is not controlled by the service worker (where /app/__offline/ URLs get the
 * host's index.html instead). The page then falls back to the remote cover.
 */
async function withServableCover(cache: Cache, snap: OfflineTitleSnapshot): Promise<OfflineTitleSnapshot> {
  if (!snap.coverUri) return snap;
  const ok = offlineUrlsServable() && !!(await cache.match(snap.coverUri).catch(() => undefined));
  if (ok) return snap;
  const { coverUri: _drop, ...rest } = snap;
  return rest;
}

export async function deleteOfflineTitle(source: OfflineTitleSource, contentId: string): Promise<void> {
  const key = indexKey(source, contentId);
  await enqueue(key, async () => {
    const cache = await openOfflineLibrary();
    if (!cache) return;
    await ensureIndex(cache);
    await Promise.all([
      cache.delete(offlineTitleUrl(source, contentId)).catch(() => false),
      cache.delete(offlineCoverUrl(source, contentId)).catch(() => false),
    ]);
    if (index.titles[key]) {
      delete index.titles[key];
      await writeIndex(cache);
    }
  });
}

/** Every saved snapshot, most recently saved first. */
export async function listOfflineTitles(): Promise<OfflineTitleSnapshot[]> {
  await Promise.all([...queues.values()]);
  const cache = await openOfflineLibrary();
  if (!cache) return [];
  await ensureIndex(cache);
  const rows = await Promise.all(
    Object.values(index.titles).map(async (entry) => {
      const snap = await readSnapshot(cache, offlineTitleUrl(entry.source, entry.contentId));
      return snap ? withServableCover(cache, snap) : null;
    }),
  );
  return rows
    .filter((row): row is OfflineTitleSnapshot => row !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}
