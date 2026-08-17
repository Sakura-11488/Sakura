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

/**
 * Pull a chapter number out of a display label. Offline fallback only — the
 * reader knows the real number and should pass it.
 *
 * This deliberately requires a "ch"/"chapter" marker and will NOT take the
 * first number it finds. The previous version did, which meant a series whose
 * title contains a number handed back the wrong one entirely: "86 Ch. 12"
 * returned 86, and the spoiler guard then cheerfully authorised everything up
 * to chapter 86 for someone reading chapter 12. Returning null is a fine
 * outcome — the guard falls back to "the point they have reached" and refuses
 * to speculate. Returning a confident wrong number is not.
 *
 * The old pattern also silently failed on the very common dotted form: it
 * excluded digits preceded by "." (to avoid matching the ".5" of "1.5"), which
 * meant "Ch.47" and "Vol.1 Ch.47" both matched nothing at all.
 */
export function chapterNumberFromLabel(label?: string | null): number | null {
  if (!label) return null;

  // "Chapter 47", "Ch. 47", "Ch.47", "Ch 47.5", "chapter47"
  const marked = label.match(/\bch(?:apter|apitre|\.)?\s*\.?\s*(\d+(?:\.\d+)?)/i);
  if (marked) {
    const parsed = Number(marked[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // A label that is *only* a number, e.g. "47" or "47.5". Anchored, so a title
  // like "86 Ch. 12" cannot reach here and neither can "5 Toubun no Hanayome".
  const bare = label.trim().match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const parsed = Number(bare[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
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

/**
 * A chapter number we are willing to hand the spoiler guard.
 *
 * Zero is rejected, and the reason is subtle. `lib/manga.ts` builds it as
 * `Number(c.number ?? c.num ?? 0)` — so a chapter whose source record carries
 * no number at all arrives as 0, indistinguishable from a genuine prologue.
 * Left alone it renders "you have read up to and including chapter 0, treat
 * everything after that as a spoiler", and Sakura goes silent on a series the
 * reader may be two hundred chapters into.
 *
 * Rejecting 0 loses nothing, because the caller falls through to
 * `chapterNumberFromLabel` — and a series that really does have a prologue
 * labels it "Chapter 0", which that parser reads back as 0. So a real chapter
 * zero survives; a defaulted one degrades to the vaguer, safer boundary.
 */
function chapterNumber(value: number | null | undefined): number | null {
  const n = realNumber(value);
  return n === 0 ? null : n;
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
      chapterNumber(input.chapterNumber) ?? chapterNumberFromLabel(input.chapterLabel),
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
