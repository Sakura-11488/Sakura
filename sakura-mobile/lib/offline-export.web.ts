import { offlineNovelUrl, offlinePageUrl, openOfflineLibrary } from '@/lib/offline-cache-keys';
import { saveCbzFromBlobs, saveTextFile } from '@/lib/web-download';
import type { ScrapedSource } from '@/lib/scraped-sources';

/**
 * "Save a permanent copy" of something already downloaded.
 *
 * The offline library is the convenient copy: it lives in Cache Storage, the
 * reader serves it without a network, and the browser may reclaim it under
 * storage pressure with no warning and no event to listen for. This produces
 * the durable copy — a file in the browser's Downloads folder, which sits
 * outside the quota system entirely and cannot be evicted. Two different
 * guarantees; the user picks.
 *
 * Zero network. Every byte comes from the bytes already stored, which is the
 * whole point: re-fetching a chapter the user has already downloaded would cost
 * them their data and cost the droplet its concurrency budget for a file they
 * could already read offline.
 *
 * Keys come from lib/offline-cache-keys.ts, the same module the stores write
 * through, so this cannot drift from what was saved.
 */

export type ExportTarget =
  | {
      kind: 'scraped';
      source: string;
      contentId: string;
      chapterId: string;
      pageCount: number;
      label: string;
    }
  | { kind: 'novel'; novelPath: string; chapterPath: string; label: string };

export const CAN_EXPORT_OFFLINE = true;

export async function exportDownloadedChapter(
  target: ExportTarget,
): Promise<{ filename: string; bytes: number }> {
  const cache = await openOfflineLibrary();
  if (!cache) throw new Error('Downloads are not available in this browser.');

  if (target.kind === 'novel') {
    const res = await cache.match(offlineNovelUrl(target.novelPath, target.chapterPath));
    if (!res) throw new Error('That chapter is no longer stored on this device.');
    const text = await res.text();
    if (!text.trim()) throw new Error('That chapter is empty.');
    saveTextFile(target.label, text);
    return { filename: `${target.label}.txt`, bytes: new TextEncoder().encode(text).length };
  }

  const pages: Array<{ blob: Blob }> = [];
  for (let i = 0; i < target.pageCount; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await cache.match(
      offlinePageUrl(target.source as ScrapedSource, target.contentId, target.chapterId, i),
    );
    if (!res) continue;
    // eslint-disable-next-line no-await-in-loop
    pages.push({ blob: await res.blob() });
  }

  if (!pages.length) {
    // Distinct from "some pages missing": this means the library entry is gone,
    // which is exactly the eviction the durable copy exists to protect against.
    throw new Error('That chapter is no longer stored on this device.');
  }
  if (pages.length < target.pageCount) {
    throw new Error(
      `Only ${pages.length} of ${target.pageCount} pages are still stored. Re-download the chapter, then save it.`,
    );
  }

  const { filename, bytes } = await saveCbzFromBlobs(target.label, pages);
  return { filename, bytes };
}
