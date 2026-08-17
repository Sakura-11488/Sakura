/**
 * What Sakura is looking at when you talk to her.
 *
 * This is deliberately NOT a tool. An 8b-class model asked to call a
 * `get_current_context` tool will frequently just… not, and then answer
 * confidently about the wrong series — which is worse than having no context at
 * all, because it looks right. So the context is rendered unconditionally into
 * the system prompt on every turn. It costs ~120 tokens and one fewer round
 * trip than a tool call would.
 *
 * The shape is shared with the edge function, which does the rendering
 * (supabase/functions/sakura-ai-chat/prompt.ts). Keep the two in step.
 */

export type SakuraSurface = 'chat' | 'reader' | 'player';
export type SakuraMedium = 'manga' | 'manhwa' | 'comic' | 'novel' | 'anime';

export interface SakuraContext {
  surface: SakuraSurface;
  medium?: SakuraMedium;

  /** Internal id — used by tools, never shown to the user. */
  seriesId?: string;
  seriesTitle?: string;

  chapterId?: string;
  /**
   * What the reader displays, e.g. "Chapter 47" or "Ch. 47 - The Return".
   * Free-form and source-dependent; never parse this for the number if
   * `chapterNumber` is available.
   */
  chapterLabel?: string;
  /**
   * The real chapter number. This is the load-bearing field for spoiler safety:
   * the guard block quotes it verbatim, so a wrong value here means Sakura
   * cheerfully spoils the next arc.
   */
  chapterNumber?: number | null;
  totalChapters?: number | null;

  /** 1-based page within the chapter, for readers that track it. */
  page?: number | null;
  totalPages?: number | null;

  /** Episode context, for the player surface (Stage 4). */
  episodeNumber?: number | null;
  positionSec?: number | null;
  category?: 'sub' | 'dub';

  /**
   * User-controlled. Default false: refuse-over-speculate is the safer failure,
   * and someone who wants spoilers can say so with one tap.
   */
  allowSpoilers?: boolean;
}

/** Digits out of a label like "Chapter 47" / "Ch. 47.5 - Title". Offline fallback
 *  only — the reader knows the real number and should pass it. */
export function chapterNumberFromLabel(label?: string | null): number | null {
  if (!label) return null;
  const match = label.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The reader's source keys are not media names. `ScrapedSource` is
 * 'comics' | 'hentai' | 'manhwa' (lib/scraped-sources.ts) — note 'comics'
 * plural, and 'hentai' which is not a medium at all. Mapping has to be
 * explicit; passing the source key straight through would tell the model the
 * medium is "comics", which it would then repeat back to the user.
 */
export function mediumFromSource(source: string | null | undefined): SakuraMedium {
  switch (source) {
    case 'comics':
      return 'comic';
    case 'manhwa':
      return 'manhwa';
    default:
      return 'manga';
  }
}

/**
 * Titles the reader shows when it has none of its own. `mangaTitle` falls back
 * to the literal string 'Manga' when a deep link or a push notification opens
 * the reader without a title param — and "the series is called Manga" is a
 * worse thing to tell the model than "I don't know the series".
 */
const PLACEHOLDER_TITLES = new Set(['manga', 'comic', 'comics', 'manhwa', 'novel', 'untitled', '']);

function realTitle(title: string | undefined): string | undefined {
  const trimmed = (title ?? '').trim();
  if (!trimmed || PLACEHOLDER_TITLES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/** Chapter numbers reach us as NaN for some sources — `Number(c.number ?? c.num ?? 0)`
 *  with no finiteness guard. NaN would serialise to null anyway, but silently:
 *  better to collapse it deliberately so the guard falls back to the label. */
function realNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildReaderContext(input: {
  medium: SakuraMedium;
  seriesId?: string;
  seriesTitle?: string;
  chapterId?: string;
  chapterLabel?: string;
  chapterNumber?: number | null;
  totalChapters?: number | null;
  page?: number | null;
  totalPages?: number | null;
  allowSpoilers?: boolean;
}): SakuraContext {
  return {
    ...input,
    surface: 'reader',
    seriesTitle: realTitle(input.seriesTitle),
    chapterNumber:
      realNumber(input.chapterNumber) ?? chapterNumberFromLabel(input.chapterLabel),
    totalChapters: realNumber(input.totalChapters),
    page: realNumber(input.page),
    totalPages: realNumber(input.totalPages),
    allowSpoilers: input.allowSpoilers ?? false,
  };
}

/** One-line description for a UI chip, e.g. "Solo Leveling · Ch. 47". */
export function describeContext(ctx: SakuraContext | undefined): string {
  if (!ctx?.seriesTitle) return '';
  const chapter =
    ctx.chapterNumber != null
      ? `Ch. ${ctx.chapterNumber}`
      : ctx.chapterLabel || '';
  return chapter ? `${ctx.seriesTitle} · ${chapter}` : ctx.seriesTitle;
}
