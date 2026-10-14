import { readStore, writeStore } from '@/lib/kv-store';
import {
  getReadChapterIds,
  seriesReadKey,
  setChaptersRead,
} from '@/lib/chapter-read-state';
import { getAllMangaProgressEntries, type MangaProgress } from '@/lib/reader-progress';
import { fetchAtsuChapterCounts, type MangaChapter } from '@/lib/manga';
import { loadMangaChapters } from '@/lib/manga-prefetch';
import { getScrapedAdapter } from '@/lib/scraped-sources';
import {
  chapterTime,
  seedReadIdsFromProgress,
  sortChaptersAsc,
  type ProgressLike,
} from '@/lib/chapter-progress';
import type { LibraryItem } from '@/lib/storage';

/**
 * New-chapter tracking for the library: per saved series, how many chapters
 * are unread, whether chapters arrived since you last looked, and when the
 * newest one landed. This is the loop Mihon, MangaDex and WEBTOON are built
 * around ("3 new", an Updates list), and Sakura had none of it: a followed
 * series only showed news if you happened to open it.
 *
 * Checks run lazily, from the library screen, never at app start:
 *  - throttled per series (ATSU_RECHECK_MS / SCRAPED_RECHECK_MS), with a
 *    floor even for a manual refresh (FORCE_RECHECK_MS);
 *  - atsu titles first ask ONE Typesense request for every title's chapter
 *    count (lib/manga fetchAtsuChapterCounts) and download a chapter list only
 *    where that count moved — a library of 40 atsu titles costs one request
 *    on a quiet day instead of forty lists (Lookism's alone is 710 KB);
 *  - at most CONCURRENCY lists in flight and MAX_LISTS_PER_RUN per run, most
 *    recently read first, so a 200-title library spreads its first check
 *    over several visits instead of flooding the proxy;
 *  - 18+ titles are never checked or recorded (they are never in the library
 *    either — this is the second fence), nor anime and novels.
 *
 * Results live in kv-store under a name containing "cache": they can all be
 * rebuilt, so kv-store may drop them first when web storage runs out.
 */

const STORE = 'sakura_library_updates_cache.json';

/** atsu titles: the count pre-check makes a recheck nearly free. */
export const ATSU_RECHECK_MS = 30 * 60 * 1000;
/** Scraped sources have no cheap pre-check; each recheck is a full list. */
export const SCRAPED_RECHECK_MS = 3 * 60 * 60 * 1000;
/** Even a pull-to-refresh does not re-ask a series checked this recently. */
export const FORCE_RECHECK_MS = 5 * 60 * 1000;
/**
 * A list that failed (or came back empty, which is how the fetchers report
 * failure) is not asked again for this long. Without it a failed series
 * stayed "due", so every library focus while a source was down re-sent up to
 * MAX_LISTS_PER_RUN list requests to it (atsu's also fall through to
 * MangaDex), focus after focus.
 */
export const FAILED_RETRY_MS = 15 * 60 * 1000;
/** Chapter lists in flight at once. */
export const CONCURRENCY = 2;
/** Full chapter-list downloads per run; the rest wait for the next visit. */
export const MAX_LISTS_PER_RUN = 24;
/**
 * Unread chapter ids remembered per series, oldest first, so the count
 * follows your reading between checks without the list. A longer backlog is
 * kept as a number (unreadOverflow); it only matters for a series you have
 * barely started, where "2,000 unread" and "2,001 unread" mean the same.
 */
export const MAX_TRACKED_UNREAD = 200;
const MAX_TRACKED_NEW = 50;
const MAX_SEEDED = 3000;

export interface SeriesUpdate {
  /** Last time the chapter list (or, for atsu, its count) was checked. */
  checkedAt: number;
  /** Chapters in the list at that check. */
  total: number;
  /** atsu's own chapter count at the last full check (a change signal only). */
  signal?: number;
  latestId: string;
  latestNumber: number;
  latestTitle: string;
  /** ms; 0 when the source gives no dates (comizy). */
  latestAt: number;
  /** Unread chapter ids at the last check, oldest first, capped. */
  unreadIds: string[];
  /** Unread chapters beyond unreadIds. */
  unreadOverflow: number;
  /** The newest chapter number you have seen (first check, or opening the series). */
  seenLatestNumber: number;
  /** Chapters newer than seenLatestNumber found by a check, capped. */
  newIds: string[];
  /** When a check first found newIds. */
  newFoundAt: number;
}

type Store = { v: 1; series: Record<string, SeriesUpdate>; seeded: string[] };

let store: Store | null = null;
let loading: Promise<Store> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** When each series' list last failed, by key. Memory only: a reload may try again. */
const failedAt = new Map<string, number>();

// ─── Pure parts (exported for the tests) ─────────────────────────────────────

/** Which store and source a library item reads from: null for anything never checked. */
export function updateSourceFor(item: Pick<LibraryItem, 'type' | 'source'>): string | null {
  if (item.type !== 'manga') return null;
  const adapter = getScrapedAdapter(item.source);
  if (adapter?.adult) return null;
  return adapter ? adapter.key : 'manga';
}

/** The key a library item's update record and read marks share. */
export function libraryUpdateKey(item: Pick<LibraryItem, 'id' | 'type' | 'source'>): string | null {
  const source = updateSourceFor(item);
  return source ? seriesReadKey(source, item.id) : null;
}

/**
 * Read ids plus what the progress row says was finished, for counting. Ids
 * only: the update record has no chapter numbers to match a renamed atsu
 * chapter by, and does not need them for a count.
 */
export function readIdsWithProgress(readIds: ReadonlySet<string>, progress: ProgressLike | null | undefined): Set<string> {
  const out = new Set(readIds);
  if (!progress) return out;
  if (progress.progress >= 0.98 || progress.caughtUp || progress.finished) out.add(progress.chapterId);
  if (progress.upNext && progress.finishedChapterId) out.add(progress.finishedChapterId);
  return out;
}

/** The record for a fresh chapter list. `prev` carries the "seen" baseline forward. */
export function computeSeriesUpdate(
  prev: SeriesUpdate | undefined,
  chapters: readonly MangaChapter[],
  readIds: ReadonlySet<string>,
  now: number,
  opts: { seen?: boolean; signal?: number } = {},
): SeriesUpdate {
  const asc = sortChaptersAsc(chapters);
  const latest = asc[asc.length - 1];
  const unread = asc.filter((c) => !readIds.has(c.id));
  const latestNumber = latest ? latest.number : 0;
  // First check: what is there now is the baseline, not news.
  const seenLatestNumber = opts.seen || !prev ? latestNumber : prev.seenLatestNumber;
  const newer = asc.filter((c) => c.number > seenLatestNumber);
  const newIds = newer.slice(-MAX_TRACKED_NEW).map((c) => c.id);
  return {
    checkedAt: now,
    total: asc.length,
    ...(typeof opts.signal === 'number' ? { signal: opts.signal } : prev?.signal != null ? { signal: prev.signal } : {}),
    latestId: latest?.id ?? '',
    latestNumber,
    latestTitle: latest?.title || (latest ? `Chapter ${latest.number}` : ''),
    latestAt: latest ? chapterTime(latest.createdAt) : 0,
    unreadIds: unread.slice(0, MAX_TRACKED_UNREAD).map((c) => c.id),
    unreadOverflow: Math.max(0, unread.length - MAX_TRACKED_UNREAD),
    seenLatestNumber,
    newIds,
    newFoundAt: newIds.length ? (prev?.newIds.length ? prev.newFoundAt || now : now) : 0,
  };
}

/** Unread and new counts against the current marks, without the chapter list. */
export function countsFor(entry: SeriesUpdate, readIds: ReadonlySet<string>): { unread: number; newCount: number } {
  let unread = entry.unreadOverflow;
  for (const id of entry.unreadIds) if (!readIds.has(id)) unread++;
  let newCount = 0;
  for (const id of entry.newIds) if (!readIds.has(id)) newCount++;
  return { unread, newCount };
}

/**
 * Is this series due a check? `failedAt` is when its last list request
 * failed (see FAILED_RETRY_MS); a forced refresh still waits out the
 * FORCE_RECHECK_MS floor after a failure.
 */
export function isDue(entry: SeriesUpdate | undefined, source: string, now: number, force: boolean, failedAt = 0): boolean {
  if (failedAt && now - failedAt < (force ? FORCE_RECHECK_MS : FAILED_RETRY_MS)) return false;
  if (!entry) return true;
  const age = now - entry.checkedAt;
  if (force) return age >= FORCE_RECHECK_MS;
  return age >= (source === 'manga' ? ATSU_RECHECK_MS : SCRAPED_RECHECK_MS);
}

// ─── Store ───────────────────────────────────────────────────────────────────

function isEntry(value: unknown): value is SeriesUpdate {
  const v = value as SeriesUpdate;
  return !!v && typeof v === 'object' && typeof v.checkedAt === 'number' && Array.isArray(v.unreadIds) &&
    Array.isArray(v.newIds) && typeof v.latestNumber === 'number';
}

async function load(): Promise<Store> {
  if (store) return store;
  if (loading) return loading;
  loading = (async () => {
    const out: Store = { v: 1, series: {}, seeded: [] };
    try {
      const raw = await readStore(STORE);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.v === 1) {
        for (const [key, value] of Object.entries(parsed.series || {})) if (isEntry(value)) out.series[key] = value;
        if (Array.isArray(parsed.seeded)) out.seeded = parsed.seeded.filter((k: unknown) => typeof k === 'string').slice(-MAX_SEEDED);
      }
    } catch {
      // Rebuildable: start empty.
    }
    store = out;
    loading = null;
    return out;
  })();
  return loading;
}

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** Coalesced: a run of checks finishing one after another writes once. */
function persistSoon(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (store) void writeStore(STORE, JSON.stringify(store));
  }, 400);
}

export function subscribeLibraryUpdates(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function progressFor(rows: MangaProgress[], source: string, id: string): MangaProgress | null {
  const want = source === 'manga' ? null : source;
  return rows.find((row) => row.mangaId === id && (getScrapedAdapter(row.source)?.key ?? null) === want) ?? null;
}

/**
 * Backfill read marks from the progress row, once per series: reading
 * history from before per-chapter marks existed (lib/chapter-read-state)
 * would otherwise count every chapter before your place as unread. Once only,
 * so a chapter you later mark unread stays unread.
 */
export async function seedReadMarksFromProgress(
  source: string | null | undefined,
  id: string,
  chaptersAsc: readonly MangaChapter[],
  progress: ProgressLike | null | undefined,
): Promise<boolean> {
  if (!id || !chaptersAsc.length || !progress) return false;
  if (getScrapedAdapter(source)?.adult) return false;
  const key = seriesReadKey(source, id);
  const s = await load();
  if (s.seeded.includes(key)) return false;
  const ids = seedReadIdsFromProgress(chaptersAsc, progress);
  // Mark the series as seeded only when the progress chapter was found: a
  // list that has not caught up with it yet gets another chance next time.
  if (!ids.length && !chaptersAsc.some((c) => c.id === progress.chapterId)) return false;
  s.seeded.push(key);
  if (s.seeded.length > MAX_SEEDED) s.seeded.splice(0, s.seeded.length - MAX_SEEDED);
  persistSoon();
  if (ids.length) await setChaptersRead(source, id, ids, true);
  return ids.length > 0;
}

/**
 * The series page has a fresh chapter list in hand: record it for a saved
 * series (no network), and with `seen` clear its NEW badge — opening the
 * series is how you see what is new.
 */
export async function noteSeriesChapters(
  source: string | null | undefined,
  id: string,
  chapters: readonly MangaChapter[],
  opts: { seen?: boolean } = {},
): Promise<void> {
  if (!id || !chapters.length || getScrapedAdapter(source)?.adult) return;
  const key = seriesReadKey(source, id);
  const [s, read, rows] = await Promise.all([load(), getReadChapterIds(source, id), getAllMangaProgressEntries()]);
  const sourceKey = getScrapedAdapter(source)?.key ?? 'manga';
  const ids = readIdsWithProgress(read, progressFor(rows, sourceKey, id));
  s.series[key] = computeSeriesUpdate(s.series[key], chapters, ids, Date.now(), { seen: opts.seen, signal: s.series[key]?.signal });
  persistSoon();
  notify();
}

export interface LibraryUpdateSummary {
  unread: number;
  newCount: number;
  total: number;
  latestNumber: number;
  latestTitle: string;
  latestAt: number;
  newFoundAt: number;
  checkedAt: number;
}

/** Current counts for every checked library item, keyed by libraryUpdateKey. */
export async function getLibraryUpdateSummaries(items: readonly LibraryItem[]): Promise<Record<string, LibraryUpdateSummary>> {
  const s = await load();
  const rows = await getAllMangaProgressEntries().catch(() => [] as MangaProgress[]);
  const out: Record<string, LibraryUpdateSummary> = {};
  for (const item of items) {
    const key = libraryUpdateKey(item);
    const source = updateSourceFor(item);
    const entry = key ? s.series[key] : undefined;
    if (!key || !source || !entry) continue;
    const read = readIdsWithProgress(await getReadChapterIds(source, item.id), progressFor(rows, source, item.id));
    const { unread, newCount } = countsFor(entry, read);
    out[key] = {
      unread,
      newCount,
      total: entry.total,
      latestNumber: entry.latestNumber,
      latestTitle: entry.latestTitle,
      latestAt: entry.latestAt,
      newFoundAt: entry.newFoundAt,
      checkedAt: entry.checkedAt,
    };
  }
  return out;
}

/** Run `jobs` with at most `limit` at once. */
async function pool(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { await job(); } catch { /* one series failing must not stop the rest */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

/**
 * Check the saved series that are due. Safe to call on every library focus:
 * concurrent calls share one run, and what is not due costs nothing. Resolves
 * when the run ends; listeners hear each series as it lands.
 */
export function refreshLibraryUpdates(items: readonly LibraryItem[], opts: { force?: boolean } = {}): Promise<void> {
  if (running) return running;
  running = runChecks(items, !!opts.force).finally(() => { running = null; });
  return running;
}

async function runChecks(items: readonly LibraryItem[], force: boolean): Promise<void> {
  if (typeof navigator !== 'undefined' && (navigator as { onLine?: boolean }).onLine === false) return;
  const s = await load();
  const now = Date.now();
  // Forget series no longer in the library, so the store stays the size of it.
  const kept = new Set(items.map((item) => libraryUpdateKey(item)).filter((key): key is string => !!key));
  let pruned = false;
  for (const key of Object.keys(s.series)) {
    if (!kept.has(key)) { delete s.series[key]; pruned = true; }
  }
  if (pruned) persistSoon();
  const rows = await getAllMangaProgressEntries().catch(() => [] as MangaProgress[]);
  const lastRead = new Map(rows.map((row) => [`${getScrapedAdapter(row.source)?.key ?? 'manga'}:${row.mangaId}`, row.updatedAt]));
  const due = items
    .map((item) => ({ item, source: updateSourceFor(item), key: libraryUpdateKey(item) }))
    .filter((d): d is { item: LibraryItem; source: string; key: string } => !!d.source && !!d.key)
    .filter((d) => isDue(s.series[d.key], d.source, now, force, failedAt.get(d.key)))
    // Most recently read first, then most recently saved.
    .sort((a, b) => (lastRead.get(b.key) || 0) - (lastRead.get(a.key) || 0) || (b.item.savedAt || 0) - (a.item.savedAt || 0));
  if (!due.length) return;

  // atsu: one count request decides which lists are worth downloading.
  const atsu = due.filter((d) => d.source === 'manga');
  let counts: Record<string, number> = {};
  if (atsu.length) {
    counts = await fetchAtsuChapterCounts(atsu.map((d) => d.item.id)).catch(() => ({}));
  }
  const lists = due.filter((d) => {
    if (d.source !== 'manga') return true;
    const entry = s.series[d.key];
    const count = counts[d.item.id];
    if (entry && typeof count === 'number' && entry.signal === count) {
      entry.checkedAt = now;
      return false;
    }
    return true;
  });
  if (lists.length !== due.length) persistSoon();

  const jobs = lists.slice(0, MAX_LISTS_PER_RUN).map(({ item, source, key }) => async () => {
    const chapters = await loadMangaChapters(item.id, source === 'manga' ? null : source).catch(() => [] as MangaChapter[]);
    // A failed or empty list keeps the last good record, and waits
    // FAILED_RETRY_MS before it is asked again.
    if (!chapters.length) {
      failedAt.set(key, Date.now());
      return;
    }
    failedAt.delete(key);
    const asc = sortChaptersAsc(chapters);
    const progress = progressFor(rows, source, item.id);
    await seedReadMarksFromProgress(source, item.id, asc, progress);
    const read = readIdsWithProgress(await getReadChapterIds(source, item.id), progress);
    const signal = typeof counts[item.id] === 'number' ? counts[item.id] : undefined;
    s.series[key] = computeSeriesUpdate(s.series[key], asc, read, Date.now(), { signal });
    persistSoon();
    notify();
  });
  await pool(jobs, CONCURRENCY);
  notify();
}

/** For "Clear reading data" style settings. */
export async function clearLibraryUpdates(): Promise<void> {
  store = { v: 1, series: {}, seeded: [] };
  failedAt.clear();
  await writeStore(STORE, JSON.stringify(store));
  notify();
}

// ─── Library views (shared by the native and web library) ────────────────────

export type LibrarySort = 'saved' | 'read' | 'updated' | 'unread' | 'title';
export const LIBRARY_SORTS: readonly { id: LibrarySort; label: string }[] = [
  { id: 'saved', label: 'Recently saved' },
  { id: 'read', label: 'Recently read' },
  { id: 'updated', label: 'Latest update' },
  { id: 'unread', label: 'Most unread' },
  { id: 'title', label: 'Title A–Z' },
];

/** Reading statuses apply to what you read; anime has its own viewing status. */
export function hasReadingStatus(item: Pick<LibraryItem, 'type'>): boolean {
  return item.type === 'manga' || item.type === 'novel';
}

/**
 * The key reading progress is indexed under for a library item ('' for
 * anime): `<source>:<id>` for manga (as libraryUpdateKey, but for 18+ too,
 * which never has progress anyway), `novel:<series path>` for novels.
 */
export function libraryProgressKey(item: Pick<LibraryItem, 'id' | 'type' | 'source'>): string {
  if (item.type === 'novel') return `novel:${item.id.replace(/\/$/, '')}`;
  if (item.type !== 'manga') return '';
  return `${getScrapedAdapter(item.source)?.key ?? 'manga'}:${item.id}`;
}

/**
 * A library view in the chosen order. Ties fall back to most recently saved,
 * so the order never shuffles between renders.
 */
export function sortLibraryItems<T extends LibraryItem>(
  items: readonly T[],
  sort: LibrarySort,
  lastRead: Record<string, number>,
  updates: Record<string, LibraryUpdateSummary>,
): T[] {
  const saved = (a: T, b: T) => (b.savedAt || 0) - (a.savedAt || 0);
  const upd = (item: T) => {
    const key = libraryUpdateKey(item);
    return key ? updates[key] : undefined;
  };
  const updatedAt = (u: LibraryUpdateSummary | undefined) => Math.max(u?.latestAt || 0, u?.newFoundAt || 0);
  const by: Record<LibrarySort, (a: T, b: T) => number> = {
    saved,
    title: (a, b) => a.title.localeCompare(b.title),
    read: (a, b) => (lastRead[libraryProgressKey(b)] || 0) - (lastRead[libraryProgressKey(a)] || 0) || saved(a, b),
    updated: (a, b) => updatedAt(upd(b)) - updatedAt(upd(a)) || saved(a, b),
    unread: (a, b) => (upd(b)?.unread || 0) - (upd(a)?.unread || 0) || saved(a, b),
  };
  return [...items].sort(by[sort] ?? saved);
}

/** Followed series with news, for the Updates view: new since you looked, or a chapter in the last 30 days. */
export function hasRecentUpdate(u: LibraryUpdateSummary | undefined, now = Date.now()): boolean {
  if (!u) return false;
  const recent = now - 30 * 24 * 60 * 60 * 1000;
  return u.newCount > 0 || u.latestAt > recent || u.newFoundAt > recent;
}
