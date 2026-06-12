import { supabase } from './supabase';

/* ═══════════════════════════════════════════
   Reuses the existing Supabase schema from the Next.js app:
   - chapter_comments (id, wallet_address, manga_id, chapter_id, content,
                       created_at, edited, is_highlighted, highlight_tx)
   - comment_reactions (id, comment_id, wallet_address, emoji)
   - user_profiles     (wallet_address, display_name, bio, avatar_seed, …)

   Series-level comments use the SERIES_CHAPTER_ID sentinel so a single
   table serves both per-chapter and per-series discussion threads.
   ═══════════════════════════════════════════ */

export const SERIES_CHAPTER_ID = '__series__';
export const REACTION_EMOJIS = ['🌸', '👍', '🔥', '😂', '💀', '❤️'];

export interface CommentProfile {
  wallet_address: string;
  display_name: string | null;
  bio: string | null;
  avatar_seed: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface ChapterComment {
  id: number;
  wallet_address: string;
  manga_id: string;
  chapter_id: string;
  content: string;
  created_at: string;
  edited: boolean;
  is_highlighted?: boolean;
  highlight_tx?: string;
  profile?: CommentProfile | null;
  reactions?: ReactionSummary[];
}

/* ── Lightweight in-memory caches ── */
const COMMENTS_TTL = 30_000;
const PROFILES_TTL = 300_000;
const commentsCache = new Map<string, { exp: number; data: ChapterComment[] }>();
const profileCache = new Map<string, { exp: number; data: CommentProfile }>();

function readComments(key: string): ChapterComment[] | null {
  const hit = commentsCache.get(key);
  if (hit && Date.now() < hit.exp) return hit.data;
  if (hit) commentsCache.delete(key);
  return null;
}

function writeComments(key: string, data: ChapterComment[]) {
  commentsCache.set(key, { exp: Date.now() + COMMENTS_TTL, data });
}

function invalidate(key: string) {
  commentsCache.delete(key);
}

/* ═══════════════════════════════════════════
   Profiles (batch)
   ═══════════════════════════════════════════ */

async function getProfilesBatch(wallets: string[]): Promise<Record<string, CommentProfile>> {
  const result: Record<string, CommentProfile> = {};
  const toFetch: string[] = [];

  for (const w of wallets) {
    const hit = profileCache.get(w);
    if (hit && Date.now() < hit.exp) result[w] = hit.data;
    else toFetch.push(w);
  }

  if (toFetch.length) {
    const { data } = await supabase
      .from('user_profiles')
      .select('wallet_address, display_name, bio, avatar_seed')
      .in('wallet_address', toFetch);
    for (const p of data ?? []) {
      const profile: CommentProfile = {
        wallet_address: p.wallet_address,
        display_name: p.display_name ?? null,
        bio: p.bio ?? null,
        avatar_seed: p.avatar_seed ?? p.wallet_address.slice(0, 8),
      };
      result[p.wallet_address] = profile;
      profileCache.set(p.wallet_address, { exp: Date.now() + PROFILES_TTL, data: profile });
    }
  }

  return result;
}

/* ═══════════════════════════════════════════
   Reactions
   ═══════════════════════════════════════════ */

async function getReactionsBatch(
  commentIds: number[],
  currentWallet?: string,
): Promise<Record<number, ReactionSummary[]>> {
  if (!commentIds.length) return {};

  const { data } = await supabase
    .from('comment_reactions')
    .select('comment_id, wallet_address, emoji')
    .in('comment_id', commentIds);

  const result: Record<number, ReactionSummary[]> = {};
  for (const cid of commentIds) {
    const rows = (data ?? []).filter((r: any) => r.comment_id === cid);
    const emojiMap: Record<string, { count: number; reacted: boolean }> = {};
    for (const r of rows) {
      if (!emojiMap[r.emoji]) emojiMap[r.emoji] = { count: 0, reacted: false };
      emojiMap[r.emoji].count++;
      if (currentWallet && r.wallet_address === currentWallet) emojiMap[r.emoji].reacted = true;
    }
    result[cid] = Object.entries(emojiMap).map(([emoji, info]) => ({
      emoji,
      count: info.count,
      reacted: info.reacted,
    }));
  }
  return result;
}

export async function toggleReaction(
  commentId: number,
  walletAddress: string,
  emoji: string,
): Promise<boolean> {
  if (!walletAddress) return false;

  const { data: existing } = await supabase
    .from('comment_reactions')
    .select('id')
    .eq('comment_id', commentId)
    .eq('wallet_address', walletAddress)
    .eq('emoji', emoji)
    .maybeSingle();

  if (existing) {
    await supabase.from('comment_reactions').delete().eq('id', existing.id);
    return false;
  }
  await supabase
    .from('comment_reactions')
    .insert({ comment_id: commentId, wallet_address: walletAddress, emoji });
  return true;
}

/* ═══════════════════════════════════════════
   Comments
   ═══════════════════════════════════════════ */

export async function getComments(
  contentId: string,
  chapterId: string = SERIES_CHAPTER_ID,
  currentWallet?: string,
): Promise<ChapterComment[]> {
  const cacheKey = `${contentId}:${chapterId}`;
  const cached = readComments(cacheKey);
  if (cached) return cached;

  const { data: comments, error } = await supabase
    .from('chapter_comments')
    .select('*')
    .eq('manga_id', contentId)
    .eq('chapter_id', chapterId)
    .order('created_at', { ascending: true });

  if (error || !comments || comments.length === 0) return [];

  const wallets = [...new Set(comments.map((c: ChapterComment) => c.wallet_address))];
  const [profiles, reactions] = await Promise.all([
    getProfilesBatch(wallets),
    getReactionsBatch(comments.map((c: ChapterComment) => c.id), currentWallet),
  ]);

  const enriched: ChapterComment[] = comments.map((c: ChapterComment) => ({
    ...c,
    profile: profiles[c.wallet_address] || null,
    reactions: reactions[c.id] || [],
  }));

  writeComments(cacheKey, enriched);
  return enriched;
}

export async function postComment(
  walletAddress: string,
  contentId: string,
  chapterId: string,
  content: string,
): Promise<ChapterComment | null> {
  if (!walletAddress || !content.trim()) return null;

  const { data, error } = await supabase
    .from('chapter_comments')
    .insert({
      wallet_address: walletAddress,
      manga_id: contentId,
      chapter_id: chapterId,
      content: content.trim().slice(0, 500),
    })
    .select()
    .single();

  if (error) return null;
  invalidate(`${contentId}:${chapterId}`);
  return data;
}

export async function deleteComment(commentId: number, walletAddress: string): Promise<boolean> {
  const { error } = await supabase
    .from('chapter_comments')
    .delete()
    .eq('id', commentId)
    .eq('wallet_address', walletAddress);
  return !error;
}

export function commentDisplayName(comment: ChapterComment): string {
  const name = comment.profile?.display_name?.trim();
  if (name) return name;
  const w = comment.wallet_address;
  return w ? `${w.slice(0, 4)}…${w.slice(-4)}` : 'Anon';
}
