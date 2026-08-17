import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  authorizePushRequest,
  jsonResponse,
  pickRandom,
  sendExpoPushBatch,
} from '../_shared/expo-push.ts';

const ATSU_BASE = 'https://atsu.moe';
const ATSU_HEADERS = { Accept: 'application/json', Referer: ATSU_BASE };
const TYPES = 'Manga,Manwha,Manhua,OEL';
const TRACK_LIMIT = 30;

interface AtsuItem {
  id: string;
  title: string;
}

interface MangaChapterRow {
  id: string;
  number?: number;
  num?: number;
  title?: string;
  pageCount?: number;
  pages?: number;
  createdAt?: string | number;
  scanlationMangaId?: string;
  scanlationId?: string;
}

function chapterNumber(c: MangaChapterRow): number {
  return Number(c.number ?? c.num ?? 0);
}

function dedupeChapters(raw: MangaChapterRow[]): MangaChapterRow[] {
  const byNum = new Map<number, MangaChapterRow>();
  for (const c of raw) {
    const num = chapterNumber(c);
    const prev = byNum.get(num);
    if (!prev) {
      byNum.set(num, c);
      continue;
    }
    const prevPages = Number(prev.pageCount ?? prev.pages ?? 0);
    const nextPages = Number(c.pageCount ?? c.pages ?? 0);
    const prevAt = Number(prev.createdAt || 0);
    const nextAt = Number(c.createdAt || 0);
    if (nextPages > prevPages || (nextPages === prevPages && nextAt > prevAt)) {
      byNum.set(num, c);
    }
  }
  return [...byNum.values()].sort((a, b) => chapterNumber(a) - chapterNumber(b));
}

function pickScanlationChapters(raw: MangaChapterRow[]): MangaChapterRow[] {
  if (raw.length === 0) return raw;
  const groups = new Map<string, MangaChapterRow[]>();
  for (const c of raw) {
    const sid = String(c.scanlationMangaId || c.scanlationId || '__default');
    const list = groups.get(sid);
    if (list) list.push(c);
    else groups.set(sid, [c]);
  }
  if (groups.size <= 1) return dedupeChapters(raw);

  let best: MangaChapterRow[] = [];
  let bestScore = -1;
  for (const items of groups.values()) {
    const chapters = items.filter((c) => /^chapter\b/i.test(String(c.title || '').trim())).length;
    const score = items.length * 10 + chapters;
    if (score > bestScore) {
      bestScore = score;
      best = items;
    }
  }
  return dedupeChapters(best);
}

async function fetchTrendingAndPopular(): Promise<AtsuItem[]> {
  const urls = [
    `${ATSU_BASE}/api/infinite/trending?page=0&types=${encodeURIComponent(TYPES)}`,
    `${ATSU_BASE}/api/infinite/popular?page=0&types=${encodeURIComponent(TYPES)}`,
  ];
  const seen = new Map<string, AtsuItem>();
  for (const url of urls) {
    const res = await fetch(url, { headers: ATSU_HEADERS });
    if (!res.ok) continue;
    const json = await res.json().catch(() => ({}));
    const items = (json.items || []) as AtsuItem[];
    for (const item of items) {
      if (item?.id && item?.title && !seen.has(item.id)) {
        seen.set(item.id, item);
      }
    }
  }
  return [...seen.values()].slice(0, TRACK_LIMIT);
}

async function fetchChapters(mangaId: string): Promise<MangaChapterRow[]> {
  const res = await fetch(
    `${ATSU_BASE}/api/manga/allChapters?mangaId=${encodeURIComponent(mangaId)}`,
    { headers: ATSU_HEADERS },
  );
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  const raw = (json.chapters || []) as MangaChapterRow[];
  return pickScanlationChapters(raw);
}

function mangaUpdateCopy(title: string, chapterNum: number): { title: string; body: string } {
  const templates = [
    {
      title: `📖 ${title} — Ch.${chapterNum} is live!`,
      body: "Don't get left behind — your next chapter is waiting.",
    },
    {
      title: `New chapter alert 🌸`,
      body: `${title} just dropped Ch.${chapterNum}. Tap to read now!`,
    },
    {
      title: `You're missing out 👀`,
      body: `${title} updated with Ch.${chapterNum}. Catch up before spoilers hit!`,
    },
    {
      title: `Fresh pages just landed`,
      body: `${title} Ch.${chapterNum} is up — perfect time for a reading break.`,
    },
  ];
  return pickRandom(templates);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  // Client first: the secret now lives in Vault, so authorizing needs one.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  if (!(await authorizePushRequest(req, supabase))) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const mangaList = await fetchTrendingAndPopular();
  const updates: Array<{
    mangaId: string;
    title: string;
    chapterNum: number;
    chapterId: string;
    chapterCount: number;
  }> = [];

  for (const manga of mangaList) {
    const chapters = await fetchChapters(manga.id);
    if (!chapters.length) continue;

    const latest = chapters[chapters.length - 1];
    const chapterNum = chapterNumber(latest);
    const chapterId = String(latest.id || '');
    const chapterCount = chapters.length;

    const { data: prev } = await supabase
      .from('push_manga_state')
      .select('*')
      .eq('manga_id', manga.id)
      .maybeSingle();

    if (!prev) {
      await supabase.from('push_manga_state').upsert({
        manga_id: manga.id,
        title: manga.title,
        latest_chapter_number: chapterNum,
        latest_chapter_id: chapterId,
        chapter_count: chapterCount,
        seeded: true,
        updated_at: new Date().toISOString(),
      });
      continue;
    }

    const isNewChapter =
      chapterNum > Number(prev.latest_chapter_number) || chapterCount > Number(prev.chapter_count);

    await supabase.from('push_manga_state').upsert({
      manga_id: manga.id,
      title: manga.title,
      latest_chapter_number: chapterNum,
      latest_chapter_id: chapterId,
      chapter_count: chapterCount,
      seeded: true,
      updated_at: new Date().toISOString(),
    });

    if (prev.seeded && isNewChapter) {
      updates.push({
        mangaId: manga.id,
        title: manga.title,
        chapterNum,
        chapterId,
        chapterCount,
      });
    }
  }

  if (!updates.length) {
    return jsonResponse(200, { sent: 0, message: 'No new manga chapters' });
  }

  const { data: tokens, error: tokenErr } = await supabase
    .from('push_tokens')
    .select('expo_push_token')
    .eq('enabled', true)
    .eq('notify_chapters', true);

  if (tokenErr) return jsonResponse(500, { error: tokenErr.message });

  const uniqueTokens = [...new Set((tokens ?? []).map((r) => r.expo_push_token as string))];
  if (!uniqueTokens.length) {
    return jsonResponse(200, { sent: 0, updates: updates.length, message: 'No chapter subscribers' });
  }

  // Notify for the highest chapter jump first; cap one push blast per cron run.
  updates.sort((a, b) => b.chapterNum - a.chapterNum);
  const highlight = updates[0];
  const copy = mangaUpdateCopy(highlight.title, highlight.chapterNum);

  const messages = uniqueTokens.map((to) => ({
    to,
    title: copy.title,
    body: copy.body,
    data: {
      type: 'manga',
      id: highlight.mangaId,
      chapterId: highlight.chapterId,
      chapter: highlight.chapterNum,
      pushKind: 'manga_update',
    },
  }));

  try {
    const result = await sendExpoPushBatch(messages);
    return jsonResponse(200, {
      sent: messages.length,
      highlight: highlight.mangaId,
      chapter: highlight.chapterNum,
      pendingUpdates: updates.length,
      result,
    });
  } catch (e) {
    return jsonResponse(502, { error: e instanceof Error ? e.message : 'Push send failed' });
  }
});
