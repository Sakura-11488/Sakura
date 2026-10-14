import { Image } from 'expo-image';

/**
 * Start downloading a reader page before the reader asks for it, into the
 * cache the reader's own <Image> reads from. Best effort: a failure here only
 * means the reader loads the page itself, as it always did.
 *
 * Native warms expo-image's cache, which ReaderImage reads through. The web
 * twin (warm-reader-image.web.ts) has to request exactly the URL ReaderImage
 * renders, so it lives beside it.
 */
export function warmReaderImage(url: string | null | undefined): void {
  if (!url) return;
  void Image.prefetch(url).catch(() => undefined);
}
