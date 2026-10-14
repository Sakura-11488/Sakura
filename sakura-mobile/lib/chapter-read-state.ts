import { readStore, writeStore } from '@/lib/kv-store';

/**
 * Per-chapter read marks for the page-based sources: atsu manga, manhwa and
 * comics.
 *
 * reader-progress.ts keeps one record per series — the chapter and page you are
 * on — which is right for Continue Reading but cannot answer "which chapters
 * have I read?". That is what read/unread marks, an unread filter, "mark
 * previous as read" and the library's new-chapter counts need, so it lives
 * here: a set of finished chapter ids per series.
 *
 * Nothing is recorded for the 18+ source. Reading an adult title must leave no
 * trace in shared surfaces (the same rule reader-progress and history follow).
 *
 * Bounded so it can never crowd anything else out of kv-store (localStorage on
 * web): at most MAX_SERIES series, oldest-touched evicted first, and at most
 * MAX_PER_SERIES ids per series (the longest real series is a few thousand
 * chapters).
 */

const STORE = 'sakura_chapter_read_state.json';
const MAX_SERIES = 1500;
const MAX_PER_SERIES = 6000;
const NO_TRACE_SOURCES = new Set(['hentai']);

type SeriesRecord = { read: string[]; updatedAt: number };
type Store = Record<string, SeriesRecord>;

let store: Store | null = null;
let loading: Promise<Store> | null = null;
let writing: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

/** One key per series. Absent/'manga' source is atsu manga. */
export function seriesReadKey(source: string | null | undefined, seriesId: string): string {
  const s = source && source !== 'manga' ? source : 'manga';
  return `${s}:${seriesId}`;
}

function isRecord(value: unknown): value is SeriesRecord {
  return !!value && typeof value === 'object' &&
    Array.isArray((value as SeriesRecord).read) &&
    typeof (value as SeriesRecord).updatedAt === 'number';
}

async function load(): Promise<Store> {
  if (store) return store;
  if (loading) return loading;
  loading = (async () => {
    const out: Store = {};
    try {
      const raw = await readStore(STORE);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (!isRecord(value)) continue;
          out[key] = {
            read: value.read.filter((id) => typeof id === 'string' && id.length > 0).slice(-MAX_PER_SERIES),
            updatedAt: value.updatedAt,
          };
        }
      }
    } catch {
      // A corrupt store must not break reading; start empty.
    }
    store = out;
    loading = null;
    return out;
  })();
  return loading;
}

function evict(s: Store): void {
  const keys = Object.keys(s);
  if (keys.length <= MAX_SERIES) return;
  keys
    .sort((a, b) => s[a].updatedAt - s[b].updatedAt)
    .slice(0, keys.length - MAX_SERIES)
    .forEach((key) => { delete s[key]; });
}

/** Writes are chained so a fast run of marks lands in order and none is lost. */
function persist(s: Store): Promise<void> {
  const snapshot = JSON.stringify(s);
  writing = writing.then(() => writeStore(STORE, snapshot).then(() => undefined, () => undefined));
  return writing;
}

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** Ids of the chapters marked read for a series (empty set when none). */
export async function getReadChapterIds(source: string | null | undefined, seriesId: string): Promise<Set<string>> {
  if (!seriesId || (source && NO_TRACE_SOURCES.has(source))) return new Set();
  const s = await load();
  return new Set(s[seriesReadKey(source, seriesId)]?.read ?? []);
}

/**
 * Mark (or unmark) chapters for one series. `read` defaults to true. Returns
 * without writing when nothing changes, so callers may call it freely (e.g.
 * on every reader exit).
 */
export async function setChaptersRead(
  source: string | null | undefined,
  seriesId: string,
  chapterIds: string[],
  read = true,
): Promise<void> {
  if (!seriesId || !chapterIds.length || (source && NO_TRACE_SOURCES.has(source))) return;
  const s = await load();
  const key = seriesReadKey(source, seriesId);
  const current = new Set(s[key]?.read ?? []);
  let changed = false;
  for (const id of chapterIds) {
    if (typeof id !== 'string' || !id) continue;
    if (read && !current.has(id)) { current.add(id); changed = true; }
    if (!read && current.delete(id)) changed = true;
  }
  if (!changed) return;
  if (current.size === 0) delete s[key];
  else s[key] = { read: [...current].slice(-MAX_PER_SERIES), updatedAt: Date.now() };
  evict(s);
  notify();
  await persist(s);
}

/** Convenience for the reader: one finished chapter. */
export function markChapterRead(source: string | null | undefined, seriesId: string, chapterId: string): Promise<void> {
  return setChaptersRead(source, seriesId, [chapterId], true);
}

/** Read-state changes, for screens that show marks or unread counts. */
export function subscribeChapterReadState(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** For "Clear reading data" style settings. */
export async function clearAllChapterReadState(): Promise<void> {
  store = {};
  notify();
  await persist(store);
}
