import { Image } from 'expo-image';

/**
 * Look-ahead page downloads for the reader (native).
 *
 * The reader calls setReaderLookAhead with the next few page URLs on every
 * page change. Native warms expo-image's memory and disk cache, which
 * ReaderImage reads through, so a page scrolled into view paints from cache
 * instead of showing "Loading page N…". expo-image cannot cancel a prefetch,
 * so the window is kept small by the caller (lookAheadCount) and each URL is
 * asked for once. The web twin (reader-prefetch.web.ts) can cancel, and does.
 */

const requested = new Set<string>();
const MAX_REMEMBERED = 400;
/**
 * At most this many pages ahead on native, whatever the caller asks for. On
 * Android expo-image's prefetch decodes the full-size bitmap through Glide
 * (it uses `load`, not `download`, to fill the memory cache), and one tall
 * manhwa strip (690x13915) is ~38 MB as ARGB; five of them ahead could cost a
 * low-end phone 50-200 MB of transient memory. Two pages still hides the
 * next page's download behind the one being read.
 */
const NATIVE_LOOK_AHEAD = 2;

export function setReaderLookAhead(urls: ReadonlyArray<string>): void {
  const fresh = urls.slice(0, NATIVE_LOOK_AHEAD).filter((url) => url && !requested.has(url));
  if (fresh.length === 0) return;
  for (const url of fresh) {
    requested.add(url);
    if (requested.size > MAX_REMEMBERED) requested.delete(requested.values().next().value as string);
  }
  void Image.prefetch(fresh, 'memory-disk').catch(() => {
    // Let a later page change ask again; the reader still loads it itself.
    fresh.forEach((url) => requested.delete(url));
  });
}

/** Nothing in flight can be stopped on native; forget nothing either. */
export function clearReaderLookAhead(): void {}
