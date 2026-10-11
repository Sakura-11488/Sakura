/**
 * The download engine shared by the two web image-chapter stores:
 * lib/manga-offline.web.ts (atsu) and lib/scraped-offline.web.ts (comics,
 * manhwa, 18+).
 *
 * Web-only, and imported by its full `.web` name — there is no native
 * counterpart, so there is no base specifier for Metro to swap. It has NO
 * imports on purpose: the stores hand it their cache and their URL rules, which
 * is what lets test/offline-image-store.test.mjs drive the real retry, resume
 * and fallback logic under node with a fake Cache and a fake fetch.
 *
 * What it fixes, compared with the loop scraped-offline.web.ts used to inline:
 *
 *  - ONE slow page failed the whole chapter. Internet Archive's IIIF server
 *    hangs for good on some pages, and a single 20s timeout with no retry threw
 *    away everything else. Pages now retry with backoff, and a store can offer
 *    a second URL for the same page (a smaller IIIF size, or the droplet route
 *    for atsu).
 *  - Retry and resume restarted at page 0. The pages already sit in Cache
 *    Storage under deterministic keys, so they are now skipped instead of
 *    refetched — which also makes resume survive a reload, because the cache
 *    entries, not the in-memory job, are the record of what is done.
 *  - Any 200 was stored as a page. A captive portal's login page, or a proxy
 *    that reports an upstream failure in a 200 body, is not an image, and it
 *    landed in the library as a "downloaded" page that renders blank. Bodies
 *    are now checked (see readImageBody) and the real type is stored, which
 *    matters for atsu: its pages are AVIF.
 *  - The manifest was rewritten after every 3 pages. On a Download-all over
 *    hundreds of chapters that is a few thousand full-JSON writes; see
 *    createOfflineManifest for the throttle.
 */

export const PAGE_CONCURRENCY = 3;
export const DEFAULT_PAGE_TIMEOUT_MS = 20_000;
export const DEFAULT_PAGE_ATTEMPTS = 3;

/** Delay before attempt N (index 0 is the first try, so it never waits). */
const BACKOFF_MS = [0, 1_500, 4_000, 8_000];
/** A server's Retry-After is honoured, but never parks a page for minutes. */
const MAX_RETRY_AFTER_MS = 15_000;

/**
 * Rough size of one stored page, used only for the space check before a job
 * starts. atsu AVIF pages measure ~150-250KB, manhwa JPEGs up to ~1MB and IIIF
 * pages at 1200px ~300KB-1MB; erring high only means the warning comes a
 * little early.
 */
export const ESTIMATED_PAGE_BYTES = 400 * 1024;
/** Space left free for everything else the origin stores (shell, API cache). */
const STORAGE_HEADROOM_BYTES = 50 * 1024 * 1024;

/**
 * Stored next to each page so a resumed job can total the bytes it already
 * has without reading every page body back out of the cache.
 */
const BYTES_HEADER = 'x-sakura-bytes';

export type OfflineDownloadErrorCode = 'quota' | 'offline' | 'unavailable' | 'failed';

/**
 * An error whose message is safe to show as-is, plus a code the batch loops use
 * to decide whether carrying on can possibly help.
 */
export class OfflineDownloadError extends Error {
  readonly code: OfflineDownloadErrorCode;

  constructor(code: OfflineDownloadErrorCode, message: string) {
    super(message);
    this.name = 'OfflineDownloadError';
    this.code = code;
  }
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isQuotaError(e: unknown): boolean {
  if (e instanceof OfflineDownloadError) return e.code === 'quota';
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'QuotaExceededError';
}

/**
 * Errors after which a Download-all should stop rather than grind through every
 * remaining chapter, each failing the same way after its own retries: the disk
 * is full, the network is gone, or this browser cannot store anything.
 */
export function isFatalDownloadError(e: unknown): boolean {
  if (isQuotaError(e)) return true;
  if (e instanceof OfflineDownloadError && (e.code === 'offline' || e.code === 'unavailable')) return true;
  return isBrowserOffline();
}

export function toOfflineDownloadError(e: unknown): OfflineDownloadError {
  if (e instanceof OfflineDownloadError) return e;
  if (isQuotaError(e)) {
    return new OfflineDownloadError(
      'quota',
      'Your device is out of space for downloads. Free some space, then try again.',
    );
  }
  if (isBrowserOffline()) {
    return new OfflineDownloadError('offline', "You're offline. Reconnect, then try again.");
  }
  const message = e instanceof Error && e.message ? e.message : 'Download failed';
  return new OfflineDownloadError('failed', message);
}

/**
 * Whether same-origin /app/__offline/ URLs will actually be served.
 *
 * Only the service worker can answer them. In a tab it does not control (a
 * hard reload, or the first load before it claims the page) the request goes
 * to the host, whose SPA rewrite answers with index.html and a 200 — so the
 * reader would render blank pages rather than fall back to the network. Such a
 * tab is by construction one that loaded from the network, so returning "not
 * servable" there sends the reader online, which works.
 */
export function offlineUrlsServable(): boolean {
  if (typeof navigator === 'undefined') return false;
  try {
    return !!navigator.serviceWorker?.controller;
  } catch {
    return false;
  }
}

let lastShellWarmAt = 0;
const SHELL_WARM_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Ask the service worker to (re)fill its app-shell cache as a download starts.
 *
 * A download is worthless offline if the app itself cannot boot offline, and
 * the worker's install-time precache can be cut short — the first-visit case,
 * where someone downloads and then reopens with no network to a bare "Offline"
 * page. web/public/sw.js handles `{ type: 'sakura:warm-shell' }` (that string
 * is the contract; the worker cannot import this module) and skips whatever it
 * already has, so this is cheap; it is still throttled because a Download-all
 * starts a chapter every few seconds. Best-effort and silent.
 */
export function warmOfflineShell(): void {
  const now = Date.now();
  if (now - lastShellWarmAt < SHELL_WARM_INTERVAL_MS) return;
  lastShellWarmAt = now;
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const message = { type: 'sakura:warm-shell' };
    if (sw.controller) {
      sw.controller.postMessage(message);
      return;
    }
    void sw.ready.then((reg) => reg.active?.postMessage(message)).catch(() => undefined);
  } catch {
    // No worker, or it is mid-update; the next download asks again.
  }
}

/**
 * How much room the browser will give us, and whether it can be taken back.
 * Zeros mean "unknown", never "full".
 */
export async function getOfflineStorageEstimate(): Promise<{
  usedBytes: number;
  quotaBytes: number;
  persisted: boolean;
}> {
  let usedBytes = 0;
  let quotaBytes = 0;
  let persisted = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usedBytes = est.usage || 0;
      quotaBytes = est.quota || 0;
    }
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
    }
  } catch {
    // Reported as zeros; callers treat that as "unknown", not "full".
  }
  return { usedBytes, quotaBytes, persisted };
}

/**
 * Ask the browser to make this origin's storage durable.
 *
 * On Android Chrome an installed PWA is normally granted this without a prompt.
 * It is best-effort and a `false` result is not an error — it means downloads
 * are still kept, but the browser may reclaim them under storage pressure, and
 * the Downloads screen says so rather than pretending otherwise.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

function formatMB(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * Refuse to start a job that cannot fit, instead of failing it partway with a
 * QuotaExceededError after the user has waited. An unknown quota passes.
 */
export async function ensureStorageRoom(neededBytes: number): Promise<void> {
  let quota = 0;
  let usage = 0;
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    const est = await navigator.storage.estimate();
    quota = est.quota || 0;
    usage = est.usage || 0;
  } catch {
    return;
  }
  if (!quota) return;
  const free = quota - usage - STORAGE_HEADROOM_BYTES;
  if (neededBytes > free) {
    throw new OfflineDownloadError(
      'quota',
      `Not enough space to download this: it needs about ${formatMB(neededBytes)} and ` +
        `${formatMB(free)} is free.`,
    );
  }
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < Math.min(end, bytes.length); i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** MIME type from an image's magic bytes, or null when it is not one we store. */
export function sniffImageType(head: Uint8Array): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (/^GIF8[79]a$/.test(ascii(head, 0, 6))) return 'image/gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp';
  // ISO-BMFF: the major brand alone is not enough, AVIF often ships as `mif1`
  // with `avif` among the compatible brands.
  if (ascii(head, 4, 8) === 'ftyp' && /avif|avis/.test(ascii(head, 8, 40))) return 'image/avif';
  return null;
}

/**
 * The body of a successful response, if it is really an image.
 *
 * A declared image/* type is trusted. A type that names a document (HTML, JSON,
 * text) is refused outright — those are error pages wearing a 200. Anything
 * else (missing, application/octet-stream) is accepted only if the bytes sniff
 * as an image, and is then stored under the sniffed type so the service worker
 * hands the browser something it will decode.
 */
export async function readImageBody(res: Response): Promise<{ blob: Blob; type: string } | null> {
  const declared = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (declared.startsWith('text/') || declared.includes('json') || declared.includes('html')) {
    return null;
  }
  const blob = await res.blob();
  if (!blob.size) return null;
  if (declared.startsWith('image/')) return { blob, type: declared };
  const head = new Uint8Array(await blob.slice(0, 40).arrayBuffer());
  const sniffed = sniffImageType(head);
  return sniffed ? { blob, type: sniffed } : null;
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 0;
}

type FetchOutcome =
  | { ok: true; blob: Blob; type: string }
  | {
      ok: false;
      /**
       * A definitive answer from that route (404, 410, a 200 that is not an
       * image). Retrying the same URL will not change it; another URL might.
       */
      hard: boolean;
      retryAfterMs: number;
      reason: string;
    };

/** One GET with a deadline that covers the body as well as the headers. */
export async function fetchImageOnce(url: string, timeoutMs: number): Promise<FetchOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const hard = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      try {
        void res.body?.cancel().catch(() => undefined);
      } catch {
        // Nothing to release.
      }
      return { ok: false, hard, retryAfterMs, reason: `HTTP ${res.status}` };
    }
    const image = await readImageBody(res);
    if (!image) return { ok: false, hard: true, retryAfterMs: 0, reason: 'not an image' };
    return { ok: true, ...image };
  } catch {
    return {
      ok: false,
      hard: false,
      retryAfterMs: 0,
      reason: ctrl.signal.aborted ? 'timed out' : 'network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bytes of a page that is already stored and usable, or null when it has to be
 * (re)downloaded. An entry with a non-image type is treated as missing so a
 * bad write from an older build is replaced rather than skipped forever.
 */
export async function storedPageBytes(cache: Cache, key: string): Promise<number | null> {
  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch {
    return null;
  }
  if (!hit) return null;
  const type = (hit.headers.get('content-type') || '').toLowerCase();
  if (!hit.ok || !type.startsWith('image/')) return null;
  const declared = Number(hit.headers.get(BYTES_HEADER) || hit.headers.get('content-length') || NaN);
  if (Number.isFinite(declared) && declared > 0) return declared;
  try {
    const size = (await hit.blob()).size;
    return size > 0 ? size : null;
  } catch {
    return null;
  }
}

/** Check every page with bounded cache reads; a missing middle page is incomplete too. */
export async function inspectStoredPages(cache: Cache, urls: string[]): Promise<{ done: number; bytes: number }> {
  let next = 0;
  let done = 0;
  let bytes = 0;
  await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next++;
      const size = await storedPageBytes(cache, urls[index]);
      if (size !== null) { done++; bytes += size; }
    }
  }));
  return { done, bytes };
}

/** What a page entry looks like in the library. */
export function pageResponse(blob: Blob, type: string): Response {
  return new Response(blob, {
    headers: { 'content-type': type, [BYTES_HEADER]: String(blob.size) },
  });
}

export type StopReason = 'paused' | 'canceled';

export interface PageDownloadOptions {
  cache: Cache;
  /** Page URLs as the source listed them, in reading order. */
  urls: string[];
  /** Library key for page `index`. Must be stable across runs: resume relies on it. */
  keyFor: (index: number) => string;
  /**
   * URLs to try for one page, best first. Usually one; atsu offers the droplet
   * route behind its own proxy, IIIF offers a smaller rendition.
   */
  candidatesFor: (url: string) => string[];
  timeoutMs?: number;
  attempts?: number;
  concurrency?: number;
  /** Polled between pages and between retries. */
  shouldStop: () => StopReason | null;
  /** Called after every page that is stored, including ones found already stored. */
  onProgress: (done: number, bytes: number) => void;
}

export interface PageDownloadResult {
  outcome: 'done' | StopReason;
  /** Pages stored, counting ones that were already there. */
  done: number;
  bytes: number;
}

/**
 * Fill the library with a chapter's pages, skipping any already stored.
 *
 * Resolves `paused`/`canceled` when told to stop (pages in flight finish
 * first, so everything counted is really stored), `done` when every page is
 * stored, and rejects with an OfflineDownloadError when a page cannot be had
 * after its retries. A rejection leaves the stored pages in place on purpose:
 * they are addressable, and the next attempt skips them instead of making a
 * transient blip cost the user the whole chapter again.
 */
export async function downloadPagesToCache(opts: PageDownloadOptions): Promise<PageDownloadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_PAGE_ATTEMPTS);
  const concurrency = Math.max(1, opts.concurrency ?? PAGE_CONCURRENCY);
  const { cache, urls, keyFor } = opts;

  let next = 0;
  let done = 0;
  let bytes = 0;
  // Written by the workers below; the cast keeps TypeScript from narrowing
  // these to their initial null in this scope and losing the later checks.
  let stopped = null as StopReason | null;
  let failure = null as unknown;
  /**
   * Candidate positions shown to be a broken ROUTE for this job: one answered
   * definitively wrong while a later one served the same page. Without this a
   * missing proxy deployment would cost a wasted request on every page.
   */
  const deadPositions = new Set<number>();

  const fetchPage = async (
    index: number,
  ): Promise<{ blob: Blob; type: string } | StopReason | { error: string }> => {
    const candidates = opts.candidatesFor(urls[index]).filter(Boolean);
    if (!candidates.length) return { error: 'no URL' };
    let lastReason = '';
    let waitMs = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await sleep(Math.max(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], waitMs));
        const stop = opts.shouldStop();
        if (stop) return stop;
      }
      waitMs = 0;
      const live = candidates.map((_, i) => i).filter((i) => !deadPositions.has(i));
      // Prefer the successful route, but still try every route if it fails.
      // A 404 can be specific to one page rather than the whole proxy.
      const order = [...live, ...candidates.map((_, i) => i).filter((i) => deadPositions.has(i))];
      const hardFailed: number[] = [];
      for (const pos of order) {
        const result = await fetchImageOnce(candidates[pos], timeoutMs);
        if (result.ok) {
          for (const p of hardFailed) deadPositions.add(p);
          return result;
        }
        lastReason = result.reason;
        if (result.hard) hardFailed.push(pos);
        waitMs = Math.max(waitMs, result.retryAfterMs);
        if (opts.shouldStop() === 'canceled') return 'canceled';
      }
    }
    return { error: lastReason || 'unavailable' };
  };

  const worker = async () => {
    while (!failure && !stopped) {
      const stop = opts.shouldStop();
      if (stop) {
        stopped = stop;
        return;
      }
      const index = next++;
      if (index >= urls.length) return;
      const key = keyFor(index);

      const already = await storedPageBytes(cache, key);
      if (already !== null) {
        done++;
        bytes += already;
        opts.onProgress(done, bytes);
        continue;
      }

      const page = await fetchPage(index);
      if (page === 'paused' || page === 'canceled') {
        stopped = stopped ?? page;
        return;
      }
      if ('error' in page) {
        failure =
          failure ??
          (isBrowserOffline()
            ? new OfflineDownloadError('offline', "You're offline. Reconnect, then try again.")
            : new OfflineDownloadError(
                'failed',
                `Page ${index + 1} could not be downloaded (${page.error}). Retry to continue — ` +
                  'pages already saved are kept.',
              ));
        return;
      }
      // A chapter deleted mid-download must not get its pages written back.
      if (opts.shouldStop() === 'canceled') {
        stopped = 'canceled';
        return;
      }
      try {
        await cache.put(key, pageResponse(page.blob, page.type));
      } catch (e) {
        failure = failure ?? e;
        return;
      }
      done++;
      bytes += page.blob.size;
      opts.onProgress(done, bytes);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

  // Deletion wins over a simultaneous network failure so the caller performs
  // its final sweep of writes which finished while deletion was waiting.
  if (opts.shouldStop() === 'canceled') return { outcome: 'canceled', done, bytes };
  if (failure) throw toOfflineDownloadError(failure);
  if (stopped) return { outcome: stopped, done, bytes };
  if (done < urls.length) {
    throw new OfflineDownloadError('failed', 'Some pages could not be saved. Retry to continue.');
  }
  return { outcome: 'done', done, bytes };
}

/**
 * The JSON manifest a store keeps beside its pages, as one Response in the
 * library cache — mirroring the native manifest.json rather than introducing
 * IndexedDB for one object.
 *
 * Two properties the stores used to get wrong by hand:
 *
 *  - Loading is a shared promise. A boolean set before the first await let a
 *    second caller see an empty manifest mid-load, and a download started in
 *    that window persisted it — overwriting every other row on disk.
 *  - Writes are serialised and, during a job, throttled. Each write serialises
 *    the CURRENT rows when it runs, so the last write always wins with the
 *    latest state, and progress ticks cost one write per interval instead of
 *    one per page. Losing a tick to a closed tab is harmless: the page entries
 *    are the truth and a resumed job recounts them.
 */
export function createOfflineManifest<Row>(opts: {
  url: string;
  openCache: () => Promise<Cache | null>;
  /** Called once with the rows read from disk. Return true if it changed any. */
  onLoad?: (rows: Record<string, Row>) => boolean;
  persistDelayMs?: number;
}): {
  state: { chapters: Record<string, Row> };
  ensureLoaded: () => Promise<void>;
  persistNow: () => Promise<void>;
  persistSoon: () => void;
} {
  const state: { chapters: Record<string, Row> } = { chapters: {} };
  let loading: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persistNow = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const write = writing.then(async () => {
      const cache = await opts.openCache();
      if (!cache) throw new OfflineDownloadError('unavailable', 'Offline downloads are not available in this browser.');
      await cache.put(
        opts.url,
        new Response(JSON.stringify({ chapters: state.chapters }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }).catch((error) => { throw toOfflineDownloadError(error); });
    // A failed write must reject its caller without poisoning the write queue.
    writing = write.catch(() => undefined);
    return write;
  };

  const persistSoon = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void persistNow().catch(() => undefined);
    }, opts.persistDelayMs ?? 2_000);
  };

  const ensureLoaded = (): Promise<void> => {
    if (!loading) {
      loading = (async () => {
        const cache = await opts.openCache();
        if (!cache) throw new OfflineDownloadError('unavailable', 'Offline downloads are not available in this browser.');
        try {
          const res = await cache.match(opts.url);
          if (res) {
            const parsed = (await res.json()) as { chapters?: unknown } | null;
            if (parsed && typeof parsed === 'object' && parsed.chapters && typeof parsed.chapters === 'object' && !Array.isArray(parsed.chapters)) {
              for (const [key, row] of Object.entries(parsed.chapters)) {
                if (row && typeof row === 'object' && !Array.isArray(row)) state.chapters[key] = row as Row;
              }
            }
          }
        } catch {
          // A corrupt manifest must not take the app down; the pages are still
          // addressable and a re-download rewrites it.
        }
        if (opts.onLoad?.(state.chapters)) await persistNow().catch(() => undefined);
      })().catch((error) => {
        // Temporary storage failures must not mark an empty manifest loaded:
        // the next successful write would overwrite downloads already on disk.
        loading = null;
        throw error;
      });
    }
    return loading;
  };

  return { state, ensureLoaded, persistNow, persistSoon };
}

/**
 * Coalesces progress notifications. Listeners re-read a store and re-render a
 * chapter list that can be 2000 rows long; once per page across three parallel
 * workers is more often than any screen can show.
 */
export function createNotifier(delayMs = 200): {
  listeners: Set<() => void>;
  notify: () => void;
  notifySoon: () => void;
} {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const notify = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // One broken subscriber must not starve the others.
      }
    });
  };
  const notifySoon = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      notify();
    }, delayMs);
  };
  return { listeners, notify, notifySoon };
}

/** Delete every library entry whose path starts with `pathPrefix`. */
export async function deleteCacheEntriesUnder(cache: Cache, pathPrefix: string): Promise<void> {
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        try {
          return new URL(req.url).pathname.startsWith(pathPrefix);
        } catch {
          return false;
        }
      })
      .map((req) => cache.delete(req)),
  );
}
