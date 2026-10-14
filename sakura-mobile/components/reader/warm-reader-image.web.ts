import { getWebMangaPageProxyUrl } from '@/lib/content-proxy-client';

/** Same-tab memory of what was already warmed, so asking on every page turn is free. */
const warmed = new Set<string>();
/**
 * In-flight loads, held until they settle. A detached image that nothing
 * references can be collected mid-download; this keeps each one alive just
 * long enough for its bytes to reach the HTTP cache.
 */
const pending = new Set<HTMLImageElement>();

/**
 * Start downloading a reader page into the browser's HTTP cache, so the
 * reader's <img> finds it there. Its pages are served immutable
 * (/api/manga-page/ sends max-age=31536000), so a warmed page is a cache hit.
 *
 * The URL is mapped exactly as ReaderImage.web maps its first attempt, or the
 * warm-up would download a different URL from the one the reader then
 * requests. Low priority: this is a guess about the next tap, and must not
 * compete with the covers and requests the visible screen is waiting on.
 */
export function warmReaderImage(url: string | null | undefined): void {
  if (!url || typeof Image === 'undefined') return;
  const src = getWebMangaPageProxyUrl(url);
  if (warmed.has(src)) return;
  warmed.add(src);
  if (warmed.size > 200) warmed.delete(warmed.values().next().value as string);
  const image = new Image();
  image.decoding = 'async';
  (image as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
  const done = () => {
    pending.delete(image);
    image.onload = null;
    image.onerror = null;
  };
  image.onload = done;
  image.onerror = () => {
    // Let a later call try again; the reader still loads (and retries) it itself.
    warmed.delete(src);
    done();
  };
  pending.add(image);
  image.src = src;
}
