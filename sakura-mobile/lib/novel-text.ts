/**
 * Turning scraped chapter text into something worth reading.
 *
 * Pure functions only — no React, no storage — so the reader, the offline
 * store and the tests all agree on exactly what a "paragraph" is. The reader's
 * saved position is a paragraph index (see lib/novel-reader-position.ts), so a
 * paragraph split that differed between two callers would put people in the
 * wrong place.
 */

/**
 * Notices the source appends to (or prepends to) chapter bodies.
 *
 * Each pattern must match a WHOLE paragraph, and only short ones are tested
 * (see BOILERPLATE_MAX_LENGTH), so a sentence of real prose that happens to
 * mention "report" can never be deleted. novelfull's notice is literally:
 *   If you find any errors ( Ads popup, ads redirect, broken links,
 *   non-standard content, etc.. ), Please let us know < report chapter > so we
 *   can fix it as soon as possible.
 */
const BOILERPLATE: RegExp[] = [
  /^if you find any errors\b[\s\S]*\breport chapter\b[\s\S]*$/i,
  /^please let us know\s*<\s*report chapter\s*>[\s\S]*$/i,
  /^(?:find|read) (?:authori[sz]ed|the latest|latest|more)\b[\s\S]{0,120}\b(?:webnovel|novelfull|novel\s?bin|novelbin|lightnovelpub)\b[\s\S]*$/i,
  /^(?:this|the) (?:chapter|content|novel) (?:is |was )?(?:upload(?:ed)?|taken|stolen|posted|published) (?:first )?(?:at|from|on|by)\b[\s\S]{0,80}$/i,
  /^visit\s+\S*(?:novelfull|novelbin|webnovel)\S*\b[\s\S]{0,80}$/i,
];
const BOILERPLATE_MAX_LENGTH = 260;

/** Translator / editor credit lines that sit above the prose. */
const CREDIT = /^(?:translator|translated by|translation|editor|edited by|proofreader|proofread(?:ing)? by|tl|ed|tlc|pr|raw provider|atlas)\s*[:：\-–]\s*\S/i;
const CREDIT_MAX_LENGTH = 140;

/** Something a source uses as an in-text chapter heading. */
const HEADING_WORD = /^(?:chapter|ch\.?|episode|ep\.?|prologue|epilogue|side story|extra|afterword|interlude|volume|vol\.?|book)\b/i;
const HEADING_MAX_LENGTH = 140;

export interface CleanChapter {
  /** The in-text heading, when the text opened with one (removed from paragraphs). */
  heading?: string;
  /** Translator/editor credits, shown as a caption instead of as prose. */
  credits: string[];
  paragraphs: string[];
}

/** Split on blank lines; keep single line breaks inside a paragraph. */
export function splitParagraphs(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim())
    .filter((p) => p.length > 0);
}

export function isBoilerplateParagraph(paragraph: string): boolean {
  const p = paragraph.trim();
  if (!p || p.length > BOILERPLATE_MAX_LENGTH) return false;
  return BOILERPLATE.some((re) => re.test(p));
}

/** Drop the source's notices but keep everything else byte-for-byte. */
export function stripSourceBoilerplate(text: string): string {
  const kept = splitParagraphs(text).filter((p) => !isBoilerplateParagraph(p));
  return kept.join('\n\n');
}

/** Letters and digits only, lower-cased: "Chapter 1: Starting Over" ≡ "Chapter 1 - Starting Over". */
export function normalizeHeading(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.html?$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function chapterNumberOf(value: string): string | null {
  const m = String(value ?? '').match(/\b(?:chapter|ch\.?|episode|ep\.?)\s*#?\s*(\d+(?:\.\d+)?)/i);
  return m ? m[1] : null;
}

/**
 * Whether `paragraph` repeats the chapter's title.
 *
 * novelfull titles a chapter "Chapter 1 - Starting Over" in the page and then
 * opens the body with "Chapter 1: Starting Over", so the reader used to show
 * the title twice. Punctuation differs, so compare letters and digits only, and
 * accept either one being a prefix of the other ("Chapter 5" vs
 * "Chapter 5: The Return") as long as the chapter numbers agree.
 */
export function isDuplicateHeading(paragraph: string, title?: string): boolean {
  const p = paragraph.trim();
  if (!p || p.length > HEADING_MAX_LENGTH || p.includes('\n')) return false;
  const a = normalizeHeading(p);
  if (!a) return false;
  if (title) {
    const b = normalizeHeading(title);
    if (b && a === b) return true;
    const numA = chapterNumberOf(p);
    const numB = chapterNumberOf(title);
    if (b && numA && numA === numB && (a.startsWith(b) || b.startsWith(a))) return true;
    // A bare "Chapter 12" that agrees with the title's number is also a repeat.
    if (numA && numA === numB && HEADING_WORD.test(p) && /^\W*(?:chapter|ch\.?|episode|ep\.?)\s*#?\s*\d+(?:\.\d+)?\W*$/i.test(p)) return true;
    return false;
  }
  // No title to compare against: only an unmistakable heading line counts.
  return HEADING_WORD.test(p) && !!chapterNumberOf(p) && !/[.!?]["”']?$/.test(p);
}

/**
 * Paragraphs, minus source notices, a duplicated heading and credit lines.
 *
 * Only the first few paragraphs are examined for the heading and credits:
 * a line saying "Editor: …" deep inside a story is part of the story.
 */
export function cleanChapterText(raw: string, title?: string): CleanChapter {
  const all = splitParagraphs(raw).filter((p) => !isBoilerplateParagraph(p));
  const credits: string[] = [];
  let heading: string | undefined;
  let start = 0;
  const lookahead = Math.min(all.length, 5);
  for (let i = 0; i < lookahead; i++) {
    const p = all[i];
    if (!heading && isDuplicateHeading(p, title)) {
      heading = p;
      start = i + 1;
      continue;
    }
    if (p.length <= CREDIT_MAX_LENGTH && CREDIT.test(p)) {
      // "Translator: A Editor: B" on one line becomes two credits.
      for (const part of p.split(/\s+(?=(?:editor|edited by|proofreader|translator)\s*[:：])/i)) {
        credits.push(part.replace(/\s*([:：])\s*/, ': ').trim());
      }
      start = i + 1;
      continue;
    }
    break;
  }
  const paragraphs = all.slice(start);
  // Never return an empty chapter because the whole thing looked like front matter.
  if (paragraphs.length === 0 && all.length > 0) return { credits: [], paragraphs: all };
  return { heading, credits, paragraphs };
}

/**
 * A readable chapter title from its URL when the caller did not pass one.
 *
 * The old fallback title-cased the last path segment as-is, so
 * "chapter-1-starting-over.html" became "Chapter 1 Starting Over.Html".
 * Sakura's own chapter paths end in a database id, which is not a title at all.
 */
export function chapterTitleFromPath(path: string): string {
  const segments = String(path ?? '').split('/').filter(Boolean);
  const last = (segments[segments.length - 1] || '').replace(/\.html?$/i, '');
  if (!last) return '';
  const prev = segments[segments.length - 2] || '';
  if (prev.toLowerCase() === 'chapter' || /^[0-9a-f-]{16,}$/i.test(last)) return '';
  const words = last.split(/[-_]+/).filter(Boolean);
  const titleCase = (w: string) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  const m = last.match(/^(?:chapter|ch|episode)[-_]?(\d+(?:[-_.]\d+)?)(?:[-_](.+))?$/i);
  if (m) {
    const num = m[1].replace(/[-_]/g, '.');
    const rest = m[2] ? m[2].split(/[-_]+/).filter(Boolean).map(titleCase).join(' ') : '';
    return rest ? `Chapter ${num} – ${rest}` : `Chapter ${num}`;
  }
  return words.map(titleCase).join(' ');
}

/** Rough word count; CJK has no spaces, so count its characters at half a word each. */
export function countWords(text: string): number {
  const s = String(text ?? '');
  const latin = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)?.length ?? 0;
  const cjk = s.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0;
  // A run of CJK characters was counted once as a "word" above; replace that
  // with half a word per character.
  const cjkRuns = s.match(/[぀-ヿ㐀-鿿가-힯]+/g)?.length ?? 0;
  return Math.max(0, latin - cjkRuns) + Math.round(cjk / 2);
}

/**
 * Right-to-left only when the prose itself is.
 *
 * The reader used to take this from the manga page-order setting, so everyone
 * who reads manga right-to-left got right-aligned English novels. Looking at
 * the first strong characters is what browsers do for dir="auto".
 */
export function detectTextDirection(text: string): 'ltr' | 'rtl' {
  const sample = String(text ?? '').slice(0, 400);
  const m = sample.match(/[\p{L}]/u);
  if (!m) return 'ltr';
  return /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(m[0]) ? 'rtl' : 'ltr';
}

/**
 * Split a paragraph into pieces short enough to speak.
 *
 * Chrome's speech synthesis silently stops a single utterance after roughly
 * 15 seconds, so long paragraphs are spoken as several utterances, broken at
 * sentence ends where possible, then at commas, then at spaces.
 */
export function chunkForSpeech(text: string, max = 220): string[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*|$)\s*/g) ?? [clean];
  const pieces: string[] = [];
  const pushLong = (s: string) => {
    let rest = s.trim();
    while (rest.length > max) {
      let take = max;
      let skip = max;
      const comma = rest.lastIndexOf(', ', max);
      const space = rest.lastIndexOf(' ', max);
      if (comma >= max * 0.4) {
        take = comma + 1; // keep the comma
        skip = comma + 1;
      } else if (space > 0) {
        take = space;
        skip = space + 1;
      }
      pieces.push(rest.slice(0, take).trim());
      rest = rest.slice(skip).trim();
    }
    if (rest) pieces.push(rest);
  };
  let current = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((current ? current.length + 1 : 0) + s.length <= max) {
      current = current ? `${current} ${s}` : s;
      continue;
    }
    if (current) pieces.push(current);
    current = '';
    if (s.length > max) pushLong(s);
    else current = s;
  }
  if (current) pieces.push(current);
  return pieces;
}
