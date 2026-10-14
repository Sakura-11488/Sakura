import { getWebMangaPageProxyUrl } from '@/lib/content-proxy-client';

/**
 * Look-ahead page downloads for the web reader, cancelable.
 *
 * Webtoon mode used to rely on <img loading="lazy">, which only starts a page
 * when it is nearly on screen: a fast reader saw "Loading page N…" on about
 * one scroll sample in ten, with cold pages taking ~0.9 s through the proxy.
 * The reader now names the next few pages on every page change and this
 * keeps exactly those downloading into the HTTP cache (reader pages are
 * served cacheable, /api/manga-page/ immutably), so the <img> that mounts
 * later is a cache hit.
 *
 * Pages that fall out of the window — a jump, a chapter change, leaving the
 * reader — are cancelled by clearing their src, which aborts the request,
 * so a slider drag across 100 pages does not leave 100 downloads queued
 * ahead of the page actually wanted. At most MAX_IN_FLIGHT run at once so
 * look-ahead never crowds out the page on screen.
 *
 * URLs are mapped exactly as ReaderImage.web maps a first attempt, or the
 * download would warm a different URL from the one the reader requests.
 */

const MAX_IN_FLIGHT = 3;
const MAX_DONE = 400;

const inFlight = new Map<string, HTMLImageElement>();
const done = new Set<string>();
let wanted: string[] = [];

function finish(src: string, ok: boolean) {
  const image = inFlight.get(src);
  if (image) {
    image.onload = null;
    image.onerror = null;
  }
  inFlight.delete(src);
  if (ok) {
    done.add(src);
    if (done.size > MAX_DONE) done.delete(done.values().next().value as string);
  }
  pump();
}

function pump() {
  if (typeof Image === 'undefined') return;
  for (const src of wanted) {
    if (inFlight.size >= MAX_IN_FLIGHT) return;
    if (inFlight.has(src) || done.has(src)) continue;
    const image = new Image();
    image.decoding = 'async';
    // The first look-ahead page is the one most likely needed next.
    (image as HTMLImageElement & { fetchPriority?: string }).fetchPriority = src === wanted[0] ? 'auto' : 'low';
    image.onload = () => finish(src, true);
    // A failure is not remembered: the reader loads (and retries) it itself.
    image.onerror = () => finish(src, false);
    inFlight.set(src, image);
    image.src = src;
  }
}

/** Keep these pages (and only these) downloading, in order. */
export function setReaderLookAhead(urls: ReadonlyArray<string>): void {
  wanted = urls.filter(Boolean).map((url) => getWebMangaPageProxyUrl(url));
  const keep = new Set(wanted);
  for (const [src, image] of [...inFlight]) {
    if (keep.has(src)) continue;
    image.onload = null;
    image.onerror = null;
    // Clearing src aborts the request in every current browser.
    image.src = '';
    inFlight.delete(src);
  }
  pump();
}

/** Stop everything (leaving the reader, or data saver turning on). */
export function clearReaderLookAhead(): void {
  setReaderLookAhead([]);
}
