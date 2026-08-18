import { supabase } from './supabase';
import { getOrRefreshWalletAuthSession } from './wallet-auth-session';
import { unlockForAppSession } from './wallet/app-session';

/**
 * Creating and editing novels.
 *
 * There was no write path at all before this: nothing in the codebase wrote
 * `novels` or `novel_chapters`, the three existing rows were inserted by hand,
 * and the only novel the app can actually open (`humour-me`) is a hardcoded
 * object literal in `lib/sakura-novels.ts`. Both tables were simultaneously
 * `FOR ALL TO public`, so the paywall columns were editable by anyone with the
 * anon key.
 *
 * Everything now goes through the `manage-novel` edge function, which takes the
 * creator wallet from an Ed25519 signature and refuses to touch a novel the
 * signer does not own.
 *
 * Reads stay direct — novels and chapters are public by design.
 */

export interface NovelDraft {
  title?: string;
  description?: string;
  /**
   * Must actually serve an image; the server fetches it and checks the content
   * type before storing. Prefer uploading through `upload-work-media` with role
   * `cover` and using the returned public URL — a pasted link is how the
   * existing "Heroes Of The Sky" row ended up with a Google share page as its
   * cover, which can never render.
   */
  cover_url?: string;
  genres?: string[];
  status?: 'ongoing' | 'completed' | 'hiatus';
  language?: string;
  free_until_chapter?: number;
  paid_from_chapter?: number;
  price_per_chapter?: number;
  allow_pass?: boolean;
  published?: boolean;
}

export interface ChapterDraft {
  chapter_number: number;
  title?: string;
  content?: string;
  is_free_override?: boolean;
  published?: boolean;
  release_time?: string | null;
}

async function callManageNovel(body: Record<string, unknown>): Promise<any> {
  const headers = await getOrRefreshWalletAuthSession(unlockForAppSession, 'manage-novel');
  const { data, error } = await supabase.functions.invoke('manage-novel', { body, headers });

  if (error) {
    // supabase-js hides the body on a non-2xx, and the server's message is the
    // useful part — "That link is text/html, not an image" beats "Edge Function
    // returned a non-2xx status code".
    const res = (error as { context?: Response })?.context;
    if (res && typeof res.json === 'function') {
      try {
        const payload = await res.json();
        if (payload?.error) throw new Error(String(payload.error));
      } catch (inner) {
        if (inner instanceof Error && inner.message) throw inner;
      }
    }
    throw new Error(error.message || 'Could not reach the novel service.');
  }
  if (data?.error) throw new Error(String(data.error));
  return data;
}

export async function createNovel(draft: NovelDraft) {
  const data = await callManageNovel({ action: 'create', ...draft });
  return data.novel;
}

export async function updateNovel(novelId: string, draft: NovelDraft) {
  const data = await callManageNovel({ action: 'update', novel_id: novelId, ...draft });
  return data.novel;
}

/** Creates the chapter, or replaces the one already at that number. */
export async function upsertNovelChapter(novelId: string, chapter: ChapterDraft) {
  const data = await callManageNovel({ action: 'upsert_chapter', novel_id: novelId, ...chapter });
  return { chapter: data.chapter, created: data.created as boolean };
}

export async function deleteNovelChapter(novelId: string, chapterNumber: number) {
  const data = await callManageNovel({
    action: 'delete_chapter',
    novel_id: novelId,
    chapter_number: chapterNumber,
  });
  return data.deleted as number;
}

/** Your own novels, drafts included. Public reads never show unpublished rows. */
export async function listMyNovels() {
  const data = await callManageNovel({ action: 'list_mine' });
  return (data.novels ?? []) as Array<Record<string, unknown>>;
}
