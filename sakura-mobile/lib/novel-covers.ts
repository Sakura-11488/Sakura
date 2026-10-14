import type { AllNovelItem } from './allnovel';

/**
 * Cover "enrichment" — deliberately switched off.
 *
 * This module used to look every visible title up on the public Google Books
 * API and swap the source cover for the first hit. In practice that:
 *  - returned HTTP 429 within a single session (two observed on the live site:
 *    Martial God Asura, Reincarnation Of The Strongest Sword God), and every
 *    failed request is a red console error;
 *  - matched on title alone with maxResults=1, so an unrelated book's cover
 *    could replace the right one;
 *  - swapped the image AFTER the grid had painted, so covers visibly changed
 *    under the reader's finger, and each swap re-rendered the whole list.
 * The source covers already display through /api/cover-image, so the honest
 * fix is to keep them. The exports remain, network-free, so any caller still
 * compiles and behaves sensibly.
 */

/** Always null: no third-party lookup is made. */
export async function getHDCover(_title: string): Promise<string | null> {
  return null;
}

/** Returns the same covers, with originalCover filled in for fallbacks. */
export async function enhanceCovers(items: AllNovelItem[]): Promise<AllNovelItem[]> {
  return items.map((item) => (item.originalCover ? item : { ...item, originalCover: item.cover }));
}

/** Background results can change covers without replacing newer list pages. */
export function mergeNovelCovers(current: AllNovelItem[], enhanced: AllNovelItem[]): AllNovelItem[] {
  const byPath = new Map(enhanced.map((item) => [item.path, item]));
  return current.map((item) => {
    const cover = byPath.get(item.path);
    return cover ? { ...item, cover: cover.cover, originalCover: cover.originalCover } : item;
  });
}
