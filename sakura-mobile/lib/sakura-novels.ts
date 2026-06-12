import type { AllNovelDetail, AllNovelChapter } from '@/lib/allnovel';
import { supabase } from '@/lib/supabase';
import { HUMOUR_ME_NOVEL_ID } from '@/lib/sakura-originals';

const SAKURA_NOVEL_PATHS = new Set(['humour-me']);

type SakuraNovelMeta = {
  path: string;
  name: string;
  cover: string;
  author: string;
  status: string;
  rating: number;
  genres: string;
  summary: string;
  supabaseId: string;
};

const SAKURA_NOVELS: Record<string, SakuraNovelMeta> = {
  'humour-me': {
    path: 'humour-me',
    name: 'HUMOR ME',
    cover: 'https://i.postimg.cc/t4dpCnph/IMG-20260502-WA0012.jpg',
    author: 'Sakura Original',
    status: 'ongoing',
    rating: 9.2,
    genres: 'Horror, Thriller, Supernatural, Mystery, Drama',
    summary:
      'They all just wanted an escape.\n\nThey all just wanted to live, be happy, and laugh, and forget the torment that suffocated them.\n\nBut little did they know something was about to take every bit of peace they had left.\n\nAnd it did not want much. It wanted a good time just like them too. It wanted to be humored in ways that would cost them everything.\n\n— HUMOR ME\nA compilation of short horror stories.',
    supabaseId: HUMOUR_ME_NOVEL_ID,
  },
};

export function isSakuraNovelPath(path: string): boolean {
  return SAKURA_NOVEL_PATHS.has(path);
}

export function isSakuraChapterPath(chapterPath: string): boolean {
  const parsed = parseSakuraChapterPath(chapterPath);
  return !!parsed && isSakuraNovelPath(parsed.novelPath);
}

export function parseSakuraChapterPath(
  chapterPath: string,
): { novelPath: string; chapterId: string } | null {
  const match = chapterPath.match(/^([^/]+)\/chapter\/([^/]+)$/);
  if (!match) return null;
  return { novelPath: match[1], chapterId: match[2] };
}

export function sakuraChapterPath(novelPath: string, chapterId: string): string {
  return `${novelPath}/chapter/${chapterId}`;
}

export async function fetchSakuraNovelDetail(novelPath: string): Promise<AllNovelDetail> {
  const meta = SAKURA_NOVELS[novelPath];
  if (!meta) {
    throw new Error('Unknown Sakura novel');
  }

  const { data, error } = await supabase
    .from('novel_chapters')
    .select('id, chapter_number, title')
    .eq('novel_id', meta.supabaseId)
    .eq('published', true)
    .order('chapter_number', { ascending: true });

  if (error) throw error;

  const chapters: AllNovelChapter[] = (data ?? []).map((row) => ({
    path: sakuraChapterPath(novelPath, String(row.id)),
    name: row.title || `Chapter ${row.chapter_number}`,
    chapterNumber: row.chapter_number,
    releaseTime: null,
  }));

  return {
    path: meta.path,
    name: meta.name,
    cover: meta.cover,
    author: meta.author,
    genres: meta.genres,
    status: meta.status,
    rating: meta.rating,
    summary: meta.summary,
    chapters,
  };
}

export async function fetchSakuraChapterContent(chapterPath: string): Promise<string | null> {
  const parsed = parseSakuraChapterPath(chapterPath);
  if (!parsed || !isSakuraNovelPath(parsed.novelPath)) return null;

  const meta = SAKURA_NOVELS[parsed.novelPath];
  if (!meta) return null;

  const { data, error } = await supabase
    .from('novel_chapters')
    .select('content, title, chapter_number')
    .eq('id', parsed.chapterId)
    .eq('novel_id', meta.supabaseId)
    .eq('published', true)
    .maybeSingle();

  if (error) throw error;
  if (!data?.content) return null;
  return String(data.content);
}
