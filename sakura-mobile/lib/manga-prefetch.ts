import { fetchMangaDetail, fetchMangaChapters, type MangaDetail, type MangaChapter } from '@/lib/manga';
import { getScrapedAdapter } from '@/lib/scraped-sources';

/**
 * What a manga title page can show before its own requests come back, and the
 * requests themselves, shared between the page and anything that warms them.
 *
 * Measured on the live site (mobile, 4x CPU, Fast 4G), tapping a card showed
 * "Loading series…" for about a second: the page waited for BOTH the detail
 * and the chapter-list proxy calls, each ~660 ms with its CORS preflight, even
 * though the card that was tapped already had the title and cover on screen.
 * Three things here close that gap:
 *
 *  - Previews. Lists remember each title's name and cover as they render, so
 *    the page can draw its hero in the first frame.
 *  - Shared loads. The page and a prefetch ask through the same in-flight
 *    promise, so a tap during a prefetch joins it instead of sending the same
 *    POST twice. (lib/cache.ts keeps the finished answer; it has no in-flight
 *    dedupe of its own.)
 *  - Prefetch. Hover, focus or press on a card (a click is usually 100–300 ms
 *    away) loads the detail and the chapter list; an atsu card that sits
 *    visible in a rail loads just the detail, at idle, under a budget.
 *
 * Never for 18+ sources: nothing about an adult title is fetched until the
 * reader actually opens it.
 */

export interface MangaPreview {
  title: string;
  cover: string;
}

export interface MangaCardRef {
  id: string;
  source?: string | null;
  /** Lists mix types; only manga titles open this page. */
  type?: string;
  title?: string;
  cover?: string;
}

export type PrefetchReason = 'intent' | 'visible';

/** Enough for every list a session realistically scrolls through. */
const MAX_PREVIEWS = 400;
/**
 * Visible-card prefetches allowed per minute. Every one is a POST to the
 * content proxy (an edge-function invocation), and a desktop home shows a
 * dozen cards above the fold; the cards people actually open are better served
 * by the hover/press prefetch, which this budget does not limit.
 */
const VISIBLE_BUDGET = 8;
const VISIBLE_WINDOW_MS = 60_000;
/** Two background requests at a time leaves the connection to what is on screen. */
const MAX_CONCURRENT = 2;
/** How long a card must stay visible before it counts as looked at. */
export const VISIBLE_DWELL_MS = 300;
/**
 * Don't re-ask for the same title within this window. The answer is cached
 * longer than this (lib/manga: detail 30 min, chapters 15), so a repeat would
 * only re-read the cache; the window keeps repeated hovers from queueing work.
 */
const REPEAT_WINDOW_MS = 5 * 60_000;

/**
 * A load still out after this long is not joined; the next caller starts its
 * own. supabase.functions.invoke has no timeout, and a request that hangs
 * (a stalled connection, a network change) never settles: shared forever, it
 * kept that title's page loading on every later visit until a Retry the
 * loading page does not offer. Well past the slowest healthy answer (droplet
 * cold scrapes reach ~3.5 s).
 */
const INFLIGHT_MAX_AGE_MS = 15_000;

const previews = new Map<string, MangaPreview>();
const inflight = new Map<string, { promise: Promise<unknown>; at: number }>();
const lastPrefetch = new Map<string, number>();
const visibleStarts: number[] = [];
const queue: Array<() => Promise<unknown>> = [];
let running = 0;

function sourceKey(source?: string | null): string {
  return getScrapedAdapter(source)?.key ?? 'atsu';
}

function titleKey(id: string, source?: string | null): string {
  return `${sourceKey(source)}:${id}`;
}

function isAdultSource(source?: string | null): boolean {
  return getScrapedAdapter(source)?.adult === true;
}

/** Remember what a list knows about a title, for that title's page. */
export function rememberMangaPreview(item: MangaCardRef): void {
  if (!item?.id || (item.type && item.type !== 'manga')) return;
  if (isAdultSource(item.source)) return;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title) return;
  const key = titleKey(item.id, item.source);
  // Re-inserting moves the key to the end, so the oldest falls off first.
  previews.delete(key);
  previews.set(key, { title, cover: typeof item.cover === 'string' ? item.cover : '' });
  if (previews.size > MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest !== undefined) previews.delete(oldest);
  }
}

export function rememberMangaPreviews(items: readonly MangaCardRef[]): void {
  for (const item of items) rememberMangaPreview(item);
}

export function getMangaPreview(id: string, source?: string | null): MangaPreview | null {
  if (!id) return null;
  return previews.get(titleKey(id, source)) ?? null;
}

/**
 * One request per key at a time. `fresh` starts a new one regardless — a
 * Retry must really ask again, not rejoin a request that may be hanging —
 * and so does a request older than INFLIGHT_MAX_AGE_MS.
 */
function shared<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  if (!fresh) {
    const pending = inflight.get(key);
    if (pending && Date.now() - pending.at < INFLIGHT_MAX_AGE_MS) return pending.promise as Promise<T>;
  }
  const promise = new Promise<T>((resolve) => resolve(load()));
  inflight.set(key, { promise, at: Date.now() });
  const clear = () => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

/** A shared load for `key` that is still worth joining, if any. */
function joinable(key: string): Promise<unknown> | undefined {
  const pending = inflight.get(key);
  return pending && Date.now() - pending.at < INFLIGHT_MAX_AGE_MS ? pending.promise : undefined;
}

/** The title's detail, from whichever backend owns it. Same contract as the fetchers. */
export function loadMangaDetail(
  id: string,
  source?: string | null,
  opts?: { fresh?: boolean },
): Promise<MangaDetail | null> {
  const adapter = getScrapedAdapter(source);
  return shared(`detail:${titleKey(id, source)}`, !!opts?.fresh, () =>
    adapter ? adapter.detail(id) : fetchMangaDetail(id),
  );
}

/** The title's chapter list, from whichever backend owns it. Same contract as the fetchers. */
export function loadMangaChapters(
  id: string,
  source?: string | null,
  opts?: { fresh?: boolean },
): Promise<MangaChapter[]> {
  const adapter = getScrapedAdapter(source);
  return shared(`chapters:${titleKey(id, source)}`, !!opts?.fresh, () =>
    adapter ? adapter.chapters(id) : fetchMangaChapters(id),
  );
}

type IdleHandle = { cancel: () => void };

/**
 * Run when the main thread is idle, or after `timeout` at the latest. The
 * fallback covers browsers without requestIdleCallback (Safari).
 */
export function runWhenIdle(fn: () => void, timeout = 2000): IdleHandle {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
  if (typeof ric === 'function') {
    const handle = ric(fn, { timeout });
    return { cancel: () => cic?.(handle) };
  }
  const handle = setTimeout(fn, Math.min(timeout, 200));
  return { cancel: () => clearTimeout(handle) };
}

function connection(): { saveData?: boolean; effectiveType?: string } | undefined {
  return (globalThis as { navigator?: { connection?: { saveData?: boolean; effectiveType?: string } } })
    .navigator?.connection;
}

function offline(): boolean {
  return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false;
}

/**
 * Data saver and 2G get no speculative work. A press still prefetches: the
 * navigation it starts makes the same request a moment later anyway.
 */
function allowed(reason: PrefetchReason, pressed: boolean): boolean {
  if (offline()) return false;
  const conn = connection();
  const constrained = !!conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '');
  if (!constrained) return true;
  return reason === 'intent' && pressed;
}

function takeVisibleBudget(now: number): boolean {
  while (visibleStarts.length && now - visibleStarts[0] > VISIBLE_WINDOW_MS) visibleStarts.shift();
  if (visibleStarts.length >= VISIBLE_BUDGET) return false;
  visibleStarts.push(now);
  return true;
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift()!;
    running++;
    void job()
      .catch(() => {})
      .finally(() => {
        running--;
        // Each further job waits for idle again rather than running back to
        // back, so a burst of visible cards never crowds out a tap.
        if (queue.length) runWhenIdle(pump);
      });
  }
}

/**
 * Warm a title page. `intent` (hover, focus, press) loads detail and chapter
 * list at once; `visible` loads an atsu title's detail at idle, two at a
 * time, under VISIBLE_BUDGET. Both are deduplicated against each other, against the page
 * itself (shared loads) and against a recent prefetch of the same title.
 */
export function prefetchMangaTitle(
  item: MangaCardRef,
  reason: PrefetchReason,
  opts?: { pressed?: boolean },
): void {
  if (!item?.id || (item.type && item.type !== 'manga')) return;
  if (isAdultSource(item.source)) return;
  rememberMangaPreview(item);
  if (!allowed(reason, !!opts?.pressed)) return;

  const key = titleKey(item.id, item.source);
  const detailKey = `detail:${key}`;
  const chaptersKey = `chapters:${key}`;
  const { id, source } = item;

  if (reason === 'intent') {
    // Straight away, not queued: the click this hover or press announces is
    // only a few hundred milliseconds off.
    startOnce(detailKey, () => loadMangaDetail(id, source));
    startOnce(chaptersKey, () => loadMangaChapters(id, source));
    return;
  }

  // Only atsu titles for a card that is merely visible. Manhwa is scraped by
  // the one droplet worker every visitor shares, where a cold scrape takes
  // 1.5–3.5 s (comics: the droplet on native, archive.org at 1.0–1.4 s behind
  // a function on web). A guess from every home view is load on the backend
  // the tab's own lists and the eventual tap are waiting on: measured, a
  // Manhwa home sent five /details scrapes for cards nobody opened. Intent
  // (above) still warms them.
  if (getScrapedAdapter(source)) return;
  // Only the detail for a card that is merely visible: chapter lists run to
  // ~100 KB for long series and lib/cache.ts persists every entry it holds.
  if (recentlyStarted(detailKey) || joinable(detailKey) || queued.has(detailKey)) return;
  if (!takeVisibleBudget(Date.now())) return;
  queued.add(detailKey);
  queue.push(async () => {
    queued.delete(detailKey);
    // A hover may have started it while this waited.
    startOnce(detailKey, () => loadMangaDetail(id, source));
    // Holds one of the MAX_CONCURRENT slots until it settles, but no longer
    // than a shared load is joined: a request that hangs must not stall the
    // queue for the rest of the session.
    const pending = joinable(detailKey);
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, INFLIGHT_MAX_AGE_MS); }),
    ]).finally(() => clearTimeout(timer));
  });
  runWhenIdle(pump);
}

/** Keys a visible card has queued but that have not started yet. */
const queued = new Set<string>();

/**
 * How long a mouse has to rest on a card before it counts as intent (the
 * figure instant.page uses: by then about half of hovers end in a click).
 * Intent is not budgeted, and without this a pointer crossing a browse grid
 * on its way somewhere else announced every card it passed: two proxy POSTs
 * per card, which for manhwa and comics are cold scrapes on the one droplet
 * worker the click then queues behind. A press or keyboard focus still
 * prefetches at once; on touch, the press follows the enter immediately.
 */
export const HOVER_INTENT_MS = 65;
const hoverTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Pointer entered a card: prefetch it if the pointer stays HOVER_INTENT_MS. */
export function hoverMangaTitle(item: MangaCardRef): void {
  if (!item?.id || (item.type && item.type !== 'manga') || isAdultSource(item.source)) return;
  const key = titleKey(item.id, item.source);
  if (hoverTimers.has(key)) return;
  hoverTimers.set(key, setTimeout(() => {
    hoverTimers.delete(key);
    prefetchMangaTitle(item, 'intent');
  }, HOVER_INTENT_MS));
}

/** Pointer left the card before the hover counted. */
export function leaveMangaTitle(item: MangaCardRef): void {
  if (!item?.id) return;
  const key = titleKey(item.id, item.source);
  const timer = hoverTimers.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  hoverTimers.delete(key);
}

function recentlyStarted(key: string): boolean {
  return Date.now() - (lastPrefetch.get(key) ?? -Infinity) < REPEAT_WINDOW_MS;
}

/**
 * Start a load unless one began within REPEAT_WINDOW_MS. Marked when it
 * actually starts, not when it is queued, so a hover never skips a title that
 * is only waiting in the visible queue.
 */
function startOnce(key: string, load: () => Promise<unknown>): void {
  if (recentlyStarted(key)) return;
  lastPrefetch.set(key, Date.now());
  void load().catch(() => {});
}

/**
 * Prefetch a card's title once it has stayed in view for VISIBLE_DWELL_MS.
 * One observer serves every card. Returns the cleanup; a no-op where
 * IntersectionObserver does not exist (native, old browsers).
 */
let cardObserver: IntersectionObserver | null = null;
const watched = new WeakMap<Element, { item: MangaCardRef; timer: ReturnType<typeof setTimeout> | null }>();

function getCardObserver(): IntersectionObserver | null {
  if (cardObserver) return cardObserver;
  if (typeof IntersectionObserver === 'undefined') return null;
  cardObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const state = watched.get(entry.target);
      if (!state) continue;
      if (entry.isIntersecting) {
        if (state.timer) continue;
        const target = entry.target;
        state.timer = setTimeout(() => {
          state.timer = null;
          cardObserver?.unobserve(target);
          watched.delete(target);
          prefetchMangaTitle(state.item, 'visible');
        }, VISIBLE_DWELL_MS);
      } else if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    // Half the card in view: a rail card peeking in at the edge is not "looked at".
  }, { threshold: 0.5 });
  return cardObserver;
}

export function watchCardVisibility(element: Element | null, item: MangaCardRef): () => void {
  if (!element || !item?.id || (item.type && item.type !== 'manga') || isAdultSource(item.source)) {
    return () => {};
  }
  const observer = getCardObserver();
  if (!observer) return () => {};
  watched.set(element, { item, timer: null });
  observer.observe(element);
  return () => {
    const state = watched.get(element);
    if (state?.timer) clearTimeout(state.timer);
    watched.delete(element);
    observer.unobserve(element);
  };
}
