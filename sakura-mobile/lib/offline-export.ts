/**
 * "Save a permanent copy" — native stub.
 *
 * This exists only so app/downloads.tsx can import it unconditionally. On
 * native the feature is meaningless: downloads already live in the app's own
 * documents directory, which nothing evicts. It is web where a downloaded
 * chapter sits in Cache Storage and the browser may reclaim it, so web is where
 * a durable copy is worth offering.
 *
 * The real implementation is lib/offline-export.web.ts.
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

/** Gate the UI on this rather than on Platform.OS, so the reason travels with it. */
export const CAN_EXPORT_OFFLINE = false;

export async function exportDownloadedChapter(_target: ExportTarget): Promise<{
  filename: string;
  bytes: number;
}> {
  throw new Error('Saving a copy is only needed on the web.');
}
