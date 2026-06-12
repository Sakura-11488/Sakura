// Determines which chapters sit behind the monthly pass.
//
// Parity with the legacy web reader: only the most recent chapters of an
// actively-releasing series are gated, so the back catalogue stays free.

export const GATED_LATEST_COUNT = 3;

type GatableChapter = { id: string; number: number };

function isOngoing(status: string | undefined | null): boolean {
  const s = (status || '').toLowerCase();
  return (
    s.includes('ongoing') ||
    s.includes('releasing') ||
    s.includes('publishing') ||
    s.includes('airing')
  );
}

/**
 * Returns the set of chapter ids that require a valid pass. Empty unless the
 * series is ongoing; the latest `count` chapters (by number) are gated.
 */
export function getGatedChapterIds(
  status: string | undefined | null,
  chapters: GatableChapter[],
  count: number = GATED_LATEST_COUNT,
): Set<string> {
  if (!isOngoing(status) || chapters.length === 0) return new Set();
  const latest = [...chapters]
    .sort((a, b) => b.number - a.number)
    .slice(0, count)
    .map((c) => c.id);
  return new Set(latest);
}

export function isChapterGated(
  status: string | undefined | null,
  chapters: GatableChapter[],
  chapterId: string,
  count: number = GATED_LATEST_COUNT,
): boolean {
  return getGatedChapterIds(status, chapters, count).has(chapterId);
}
