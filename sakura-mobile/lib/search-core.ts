/**
 * The pure half of the cross-source search screen ((tabs)/search.tsx and its
 * web view, MangaCatalogWeb). Nothing in here touches the network, React or
 * the platform, so the rules below are covered by test/search-core.test.mjs.
 *
 * Why the screen is built this way:
 *
 * - PROGRESSIVE. Search used to `await Promise.allSettled` over every source,
 *   so nothing showed until the slowest one answered (measured: manga, novels
 *   and people were ready ~0.4 s before manhwa, and one slow scraper held the
 *   whole page for 1.5 s). Each source now owns a section that renders the
 *   moment its own answer lands, with a skeleton in its slot until then.
 * - STALE-WHILE-REVALIDATE. Answers are kept per query for the session, so a
 *   query you already ran (or backspace back to) renders synchronously, with
 *   no debounce, and is refreshed quietly only once it is older than a minute.
 * - NO FLASH. While a new query loads, a section keeps showing the previous
 *   query's cards (dimmed) instead of swapping back to skeletons on every
 *   refinement.
 * - STALE ANSWERS NEVER LAND. Every run carries an AbortSignal; once the query
 *   moves on, late answers are dropped (sources that support it also cancel
 *   their request) but are still cached under their own query.
 */
import type { UserSearchResult } from './creator';

export type SearchSourceKey = 'manga' | 'manhwa' | 'anime' | 'novel' | 'comics' | 'users' | 'hentai';
export type SearchFilter = 'All' | 'Manga' | 'Manhwa' | 'Anime' | 'Novel' | 'Comics' | 'Users' | '18+';

export interface SearchResult {
  key: string;
  title: string;
  cover: string;
  /** Card style: manhwa and comics are read like manga, so they use the manga card. */
  type: 'manga' | 'anime' | 'novel' | 'user' | 'hentai';
  /** Which source (and therefore which section) the result came from. */
  source: SearchSourceKey;
  meta: string;
  navTarget?: string;
  user?: UserSearchResult;
  /**
   * Loose title identity, set only where the same series plausibly appears in
   * two catalogues (atsu webtoon-format titles and the manhwa scraper). Unset
   * means "never merge this one".
   */
  matchKey?: string;
}

/** One source's answer: its results, and whether the source may hold more. */
export interface SourceAnswer {
  items: SearchResult[];
  /** The source returned as many as we asked for, so a paged "See all" is worth offering. */
  full: boolean;
}

/** Wait after the last keystroke before asking the network (was 400 ms). */
export const SEARCH_DEBOUNCE_MS = 250;
/** A cached answer younger than this is shown without asking again. */
export const SEARCH_REVALIDATE_MS = 60_000;
/**
 * A section still waiting after this long is shown as "didn't answer" with a
 * retry, instead of a skeleton that never ends (the content proxy's own
 * timeout is 25 s). A late answer still replaces the message.
 */
export const SEARCH_SLOW_MS = 10_000;
export const SEARCH_MIN_CHARS = 2;
const MAX_QUERY_CHARS = 100;

export interface SearchSectionDef {
  key: SearchSourceKey;
  label: string;
  filter: SearchFilter;
  /** Quarantined: only under its own chip, never in All. */
  adult?: boolean;
  /** Scraped source whose browse screen can page this query past one answer. */
  browseSource?: 'manhwa' | 'comics';
}

/** Display order of the sections in All. Fixed, so sections never swap places as answers arrive. */
export const SEARCH_SECTIONS: readonly SearchSectionDef[] = [
  { key: 'manga', label: 'Manga', filter: 'Manga' },
  { key: 'manhwa', label: 'Manhwa', filter: 'Manhwa', browseSource: 'manhwa' },
  { key: 'anime', label: 'Anime', filter: 'Anime' },
  { key: 'novel', label: 'Novels', filter: 'Novel' },
  { key: 'comics', label: 'Comics', filter: 'Comics', browseSource: 'comics' },
  { key: 'users', label: 'People', filter: 'Users' },
  { key: 'hentai', label: '18+', filter: '18+', adult: true },
];

const ALL_KEYS = SEARCH_SECTIONS.map((def) => def.key);

export function searchFilters(allowAdult: boolean): SearchFilter[] {
  const chips: SearchFilter[] = ['All', 'Manga', 'Manhwa', 'Anime', 'Novel', 'Comics', 'Users'];
  return allowAdult ? [...chips, '18+'] : chips;
}

export function enabledSources(allowAdult: boolean): SearchSourceKey[] {
  return SEARCH_SECTIONS.filter((def) => !def.adult || allowAdult).map((def) => def.key);
}

/** What we send to the sources: trimmed, single-spaced, bounded. */
export function cleanQuery(raw: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

/** Cache identity of a query: "Solo  Leveling " and "solo leveling" are the same search. */
export function queryKey(raw: string): string {
  return cleanQuery(raw).toLowerCase();
}

/**
 * Same rule as lib/manhwa.ts manhwaTitleKey (case, whitespace and ASCII or
 * typographic punctuation ignored; letters of any script kept), duplicated so
 * this module stays free of the network stack. '' means "no usable key".
 */
export function titleMatchKey(title: string | null | undefined): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s!-\/:-@[-`{-~‐-―‘’“”]+/g, ' ')
    .trim();
}

/**
 * atsu labels Korean and Chinese webtoons 'Manwha' (sic) / 'Manhua'. A
 * Japanese manga that merely shares a short name with a manhwa is a
 * different work and keeps both (see isDistinctiveTitle for long titles).
 */
export function isWebtoonFormat(type: string | null | undefined): boolean {
  if (!type) return true;
  return /^(manhwa|manwha|manhua|webtoon)$/i.test(type.trim());
}

/**
 * atsu's format labels are not reliable enough to be the only signal: it
 * lists Korean webtoons such as "Return of the Reaper: Assassin" and "Ghost
 * Reaper Girl" as 'Manga'. A long, specific title that matches exactly is the
 * same series whatever the label says; a short generic one ("Hero",
 * "Reaper") is only merged when atsu also calls it a webtoon.
 */
export function isDistinctiveTitle(key: string): boolean {
  return key.split(' ').filter(Boolean).length >= 3 || key.length >= 14;
}

/** Whether an atsu result may be merged with a manhwa-scraper result of the same title key. */
export function atsuMatchKey(title: string | null | undefined, type: string | null | undefined): string | undefined {
  const key = titleMatchKey(title);
  if (!key) return undefined;
  return isWebtoonFormat(type) || isDistinctiveTitle(key) ? key : undefined;
}

/** atsu's own spelling is 'Manwha'; never show the typo. */
export function formatLabel(type: string | null | undefined): string {
  const t = String(type || '').trim();
  if (!t) return 'Manga';
  if (/^manwha$/i.test(t)) return 'Manhwa';
  return t;
}

/** Drop repeated keys, which React would otherwise warn about and render twice. */
export function uniqueResults(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

/**
 * Manhwa results that are the same series as an atsu result are hidden in the
 * All overview, where both sections are on screen: the atsu card comes first
 * and carries richer metadata. Under the Manhwa chip nothing is hidden, so
 * someone looking for the scraper's copy (often with newer chapters) still
 * finds it.
 */
export function withoutCrossSourceDuplicates(manga: SearchResult[], manhwa: SearchResult[]): SearchResult[] {
  const taken = new Set(manga.map((item) => item.matchKey).filter((key): key is string => !!key));
  if (!taken.size) return manhwa;
  return manhwa.filter((item) => !item.matchKey || !taken.has(item.matchKey));
}

// ─── Section state ──────────────────────────────────────────────────────────

export type SectionStatus = 'idle' | 'pending' | 'done' | 'failed';

export interface SectionState {
  status: SectionStatus;
  items: SearchResult[];
  /** queryKey() of the query `items` answer; differs from the current one while refining. */
  query: string;
  full: boolean;
  /** Failed because it did not answer within SEARCH_SLOW_MS (it may still land). */
  slow: boolean;
}

export type SectionMap = Record<SearchSourceKey, SectionState>;

const IDLE: SectionState = Object.freeze({ status: 'idle', items: [], query: '', full: false, slow: false }) as SectionState;

export function emptySections(): SectionMap {
  const map = {} as SectionMap;
  for (const key of ALL_KEYS) map[key] = IDLE;
  return map;
}

export interface CachedSource {
  items: SearchResult[];
  full: boolean;
  at: number;
}
export type CachedQuery = Partial<Record<SearchSourceKey, CachedSource>>;

/**
 * Called synchronously on every keystroke that changes the query. Sections
 * with a cached answer show it at once; the rest go pending but keep their
 * previous cards on screen (marked stale by their `query`) until the new
 * answer lands.
 */
export function prefillSections(
  prev: SectionMap,
  qKey: string,
  enabled: readonly SearchSourceKey[],
  cached: CachedQuery | null | undefined,
): SectionMap {
  const next = {} as SectionMap;
  for (const key of ALL_KEYS) {
    const was = prev[key] || IDLE;
    if (!enabled.includes(key)) {
      next[key] = IDLE;
      continue;
    }
    const hit = cached?.[key];
    if (hit) {
      next[key] = { status: 'done', items: hit.items, query: qKey, full: hit.full, slow: false };
    } else if (was.query === qKey && (was.status === 'done' || was.status === 'pending')) {
      next[key] = was;
    } else {
      next[key] = { status: 'pending', items: was.status === 'failed' ? [] : was.items, query: was.status === 'failed' ? '' : was.query, full: was.full, slow: false };
    }
  }
  return next;
}

export type TaskOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function applySourceOutcome(
  prev: SectionMap,
  key: SearchSourceKey,
  qKey: string,
  outcome: TaskOutcome<SourceAnswer>,
): SectionMap {
  const was = prev[key] || IDLE;
  if (was.status === 'idle') return prev;
  if (outcome.ok) {
    return { ...prev, [key]: { status: 'done', items: outcome.value.items, query: qKey, full: outcome.value.full, slow: false } };
  }
  // A failed background refresh keeps the answer already on screen.
  if (was.status === 'done' && was.query === qKey) return prev;
  return { ...prev, [key]: { status: 'failed', items: [], query: qKey, full: false, slow: false } };
}

export function markSectionSlow(prev: SectionMap, key: SearchSourceKey, qKey: string): SectionMap {
  const was = prev[key];
  if (!was || was.status !== 'pending') return prev;
  return { ...prev, [key]: { status: 'failed', items: [], query: qKey, full: false, slow: true } };
}

/** Sources with no cached answer for this query, or one older than maxAge. */
export function sourcesToRun(
  enabled: readonly SearchSourceKey[],
  cached: CachedQuery | null | undefined,
  now: number,
  maxAge = SEARCH_REVALIDATE_MS,
): SearchSourceKey[] {
  return enabled.filter((key) => {
    const hit = cached?.[key];
    return !hit || now - hit.at > maxAge;
  });
}

// ─── What the screen draws ──────────────────────────────────────────────────

export interface SectionView {
  key: SearchSourceKey;
  label: string;
  filter: SearchFilter;
  status: SectionStatus;
  /** Showing an earlier query's cards while this one loads. */
  stale: boolean;
  items: SearchResult[];
  full: boolean;
  slow: boolean;
  browseSource?: 'manhwa' | 'comics';
}

export function buildSectionViews(
  map: SectionMap,
  filter: SearchFilter,
  qKey: string,
  opts: { allowAdult: boolean; excludeWallet?: string | null },
): SectionView[] {
  const defs = SEARCH_SECTIONS.filter((def) =>
    (filter === 'All' ? !def.adult : def.filter === filter) && (!def.adult || opts.allowAdult),
  );
  const manga = map.manga;
  const manhwa = map.manhwa;
  const dedupe = filter === 'All' && manga.items.length > 0 && manga.query === manhwa.query;
  const views: SectionView[] = [];
  for (const def of defs) {
    const state = map[def.key] || IDLE;
    if (state.status === 'idle') continue;
    let items = state.items;
    if (def.key === 'users' && opts.excludeWallet) {
      items = items.filter((item) => item.user?.wallet_address !== opts.excludeWallet);
    }
    if (def.key === 'manhwa' && dedupe) items = withoutCrossSourceDuplicates(manga.items, items);
    const stale = state.query !== qKey;
    // In the overview an empty shelf is noise; under its own chip it says "nothing here".
    if (filter === 'All' && state.status === 'done' && !stale && items.length === 0) continue;
    views.push({
      key: def.key,
      label: def.label,
      filter: def.filter,
      status: state.status,
      stale,
      items,
      full: state.full && !stale,
      slow: state.slow,
      browseSource: def.browseSource,
    });
  }
  return views;
}

export interface SearchSummary {
  /** Some visible section is still waiting for its answer. */
  loading: boolean;
  /** At least one section shows results for the current query. */
  anyFresh: boolean;
  /** Results for the current query that are on screen. */
  count: number;
  /** Labels of sections whose source is down or too slow. */
  failed: string[];
  /** Every visible section answered (or failed) and none has a result. */
  empty: boolean;
}

export function summarizeSections(views: readonly SectionView[]): SearchSummary {
  let count = 0;
  let anyFresh = false;
  let loading = false;
  const failed: string[] = [];
  for (const view of views) {
    if (view.status === 'pending') loading = true;
    if (view.status === 'failed') failed.push(view.label);
    if (!view.stale && view.status === 'done') {
      anyFresh = true;
      count += view.items.length;
    }
  }
  return { loading, anyFresh, count, failed, empty: !loading && count === 0 };
}

// ─── Session cache ──────────────────────────────────────────────────────────

/**
 * Per-query answers for this app session (a small LRU). The sources keep their
 * own persisted caches (lib/cache.ts), so a reload still answers from disk
 * within a few ms; this layer is what makes a repeat query synchronous.
 */
export class SearchSessionCache {
  private entries = new Map<string, CachedQuery>();

  constructor(private readonly max = 24) {}

  get(qKey: string): CachedQuery | null {
    const hit = this.entries.get(qKey);
    if (!hit) return null;
    // Refresh recency.
    this.entries.delete(qKey);
    this.entries.set(qKey, hit);
    return hit;
  }

  put(qKey: string, source: SearchSourceKey, answer: SourceAnswer, at: number): void {
    if (!qKey) return;
    const entry: CachedQuery = { ...(this.entries.get(qKey) || {}), [source]: { items: answer.items, full: answer.full, at } };
    this.entries.delete(qKey);
    this.entries.set(qKey, entry);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Progressive runner ─────────────────────────────────────────────────────

export interface ProgressiveTask<K extends string, T> {
  key: K;
  run: (signal: AbortSignal) => Promise<T>;
}

/**
 * Starts every task at once and reports each one as it settles, instead of
 * waiting for all of them. Nothing is reported once `signal` aborts, so a
 * superseded query can never overwrite the current one. `onSlow` fires for a
 * task still running after `slowMs`.
 */
export function runProgressively<K extends string, T>(
  tasks: readonly ProgressiveTask<K, T>[],
  onSettled: (key: K, outcome: TaskOutcome<T>) => void,
  opts: { signal: AbortSignal; slowMs?: number; onSlow?: (key: K) => void },
): Promise<void> {
  const { signal, slowMs, onSlow } = opts;
  return Promise.all(
    tasks.map(async (task) => {
      let slowTimer: ReturnType<typeof setTimeout> | null = null;
      if (slowMs && onSlow) {
        slowTimer = setTimeout(() => {
          slowTimer = null;
          if (!signal.aborted) onSlow(task.key);
        }, slowMs);
      }
      let outcome: TaskOutcome<T>;
      try {
        outcome = { ok: true, value: await task.run(signal) };
      } catch (error) {
        outcome = { ok: false, error };
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }
      if (!signal.aborted) onSettled(task.key, outcome);
    }),
  ).then(() => undefined);
}
