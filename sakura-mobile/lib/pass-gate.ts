// Determines which chapters sit behind the monthly pass.
//
// Parity with the legacy web reader: only the most recent chapters of an
// actively-releasing series are gated, so the back catalogue stays free.

export const GATED_LATEST_COUNT = 3;

/**
 * Blanket auto-gating of the latest chapters is OFF.
 *
 * This rule locked the newest 3 chapters of every ongoing series regardless of
 * who published it — including catalogue titles Sakura doesn't own — and no
 * creator ever opted in. Per product decision (2026-07-25): a chapter is only
 * paid when the CREATOR says so.
 *
 * Be aware of what that currently means in practice: creator-controlled
 * locking is NOT yet built. `release_metadata.pricing` exists but is written
 * only by the legacy web novel bridge (src/lib/creator-work-bridge.ts) and is
 * read by nothing — read-work-media drops it before the client ever sees it.
 * So with this flag off, nothing in the app is gated at all, and the monthly
 * pass unlocks nothing. Real per-release locking lands with
 * `work_releases.access_tier`; until then this file is the only gate and it is
 * deliberately open.
 *
 * Flipping this back to `true` restores the old behaviour in one line.
 */
export const AUTO_GATE_LATEST_CHAPTERS = false;

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
  if (!AUTO_GATE_LATEST_CHAPTERS) return new Set();
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
