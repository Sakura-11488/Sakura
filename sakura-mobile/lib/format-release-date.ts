/**
 * Release date shown on chapter and episode rows.
 *
 * Recent dates read relatively and older ones absolutely, because the two
 * answer different questions: for something published this week the useful
 * fact is "is this new?", and past that it's "when was this?". "4 years ago"
 * tells a reader nothing they can act on.
 *
 * Returns '' for missing or unparseable input rather than throwing or emitting
 * a placeholder — several sources legitimately have no date (synthesised
 * chapters, chapter lists rebuilt from the offline manifest), and callers
 * render conditionally on the empty string.
 *
 * Wording deliberately mirrors formatHistoryTime in lib/reading-history.ts so
 * the two read alike; that one takes epoch ms and stays as it is.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Past this, an exact date is more use than a countdown. */
const RELATIVE_WINDOW = 7 * DAY;

export function formatReleaseDate(value?: string | number | null): string {
  if (value == null || value === '') return '';

  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';

  const diff = Date.now() - ms;

  // Scheduled or clock-skewed dates read absolutely; "in 3 days" would be a
  // different feature and "3 days ago" would be plainly wrong.
  if (diff < 0) return absolute(ms);

  if (diff < HOUR) {
    const mins = Math.floor(diff / MINUTE);
    return mins <= 1 ? 'Just now' : `${mins}m ago`;
  }
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'Yesterday';
  if (diff < RELATIVE_WINDOW) return `${Math.floor(diff / DAY)}d ago`;

  return absolute(ms);
}

function absolute(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}
