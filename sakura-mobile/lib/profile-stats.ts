import { supabase } from './supabase';

/* Public profile + achievements, mirroring the Next.js model and reusing the
   same Supabase tables (user_profiles, favorites, reading_history,
   chapter_comments, comment_reactions). */

export interface PublicProfile {
  wallet_address: string;
  display_name: string | null;
  username: string | null;
  bio: string | null;
  avatar_seed: string;
  avatar_url?: string | null;
  avatar_mint_address?: string | null;
  creator_verification_state?: string | null;
  follower_count?: number;
  created_at: string | null;
}

export interface ProfileStats {
  chaptersRead: number;
  commentsPosted: number;
  reactionsReceived: number;
  favoritesCount: number;
  memberSince: string | null;
}

export interface ProfileFavorite {
  content_id: string;
  content_type: string;
  title: string;
  cover_url: string;
}

/**
 * The columns `favorites` really has. The table is the Next.js app's
 * (supabase/migrations/20250408120000_sakura_schema.sql): wallet_address,
 * manga_id, title, cover_url, created_at, keyed (wallet_address, manga_id),
 * and src/lib/supabase.ts addFavorite is the writer that filled it.
 *
 * This used to select `content_id, content_type`, the shape of the Expo app's
 * own `Favorite` interface in lib/supabase.ts. Neither column exists, so
 * PostgREST answered every public profile with 400 "column
 * favorites.content_id does not exist" (seen live on /app/user/<wallet>), and
 * supabase-js hands that back as `{ data: null }` rather than throwing — the
 * page rendered "0 Favorites" and no shelf for every wallet, with nothing in
 * the UI to say why.
 */
export const PROFILE_FAVORITES_SELECT = 'manga_id, title, cover_url';

/**
 * Covers the 18+ source produces. lib/hentai.ts proxyHentaiImage routes every
 * HentaiFox cover through the droplet's `/hentai/v1/img?u=…`, and on web wraps
 * that again in the media proxy (`?path=%2Fhentai%2Fv1…`); an unproxied one
 * points at HentaiFox's CDN.
 */
const ADULT_COVER = /\/hentai\/v1\/|hentaifox\./i;

function isAdultCover(url: string): boolean {
  // Decode the nested query parameters a few layers deep first; the web form
  // only shows `/hentai/v1/` once `path=` is decoded.
  let text = url;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(text);
    } catch {
      break;
    }
    if (next === text) break;
    text = next;
  }
  return ADULT_COVER.test(text);
}

/**
 * Rows from `favorites` → the shelf on a public profile.
 *
 * Untrusted input, like the cloud-sync pulls: `favorites` is still one of the
 * `FOR ALL … USING (true)` tables (see 20260818000000_lock_writable_tables.sql),
 * so any holder of the public anon key can put any row in any wallet's list,
 * and whatever lands here is shown to everyone who opens the profile. A row
 * without a usable id or title is dropped rather than rendered as a blank
 * card, and a cover that is not an absolute http(s) URL becomes '' (the page
 * then draws its placeholder).
 *
 * 18+: a public profile is seen by readers who have not turned 18+ content on,
 * so an adult title must never surface here. No legitimate writer can produce
 * one today — the Next.js sources have no 18+ catalogue, and the Expo app's
 * addFavorite always failed on the same missing content_id column — but the
 * table is open to anyone, and has no source column to check. The cover URL is
 * the one signal the row carries, so a row whose cover comes from the 18+
 * source is dropped whole: its title is as adult as its cover.
 *
 * Every row is a manga: manga_id is the only id column, and the Next.js app
 * favorited only from its manga/comic title page.
 */
export function toProfileFavorites(rows: unknown): ProfileFavorite[] {
  if (!Array.isArray(rows)) return [];
  const out: ProfileFavorite[] = [];
  // The key is (wallet_address, manga_id) untrimmed, so 'x' and ' x ' are two
  // rows that trim to one id. The shelf keys its cards on that id, and React
  // drops or repeats children that share a key, so keep only the newest.
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.manga_id === 'string' ? r.manga_id.trim() : '';
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!id || id.length >= 512 || !title) continue;
    const cover = typeof r.cover_url === 'string' ? r.cover_url.trim() : '';
    if (cover && isAdultCover(cover)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      content_id: id,
      content_type: 'manga',
      title,
      cover_url: /^https?:\/\//i.test(cover) ? cover : '',
    });
  }
  return out;
}

export interface LevelInfo {
  min: number;
  name: string;
  color: string;
  progress: number;
  nextMin: number | null;
}

export const LEVELS = [
  { min: 0, name: '新人 Newbie', color: '#94a3b8' },
  { min: 5, name: '読者 Reader', color: '#93c5fd' },
  { min: 15, name: 'オタク Otaku', color: '#c084fc' },
  { min: 30, name: 'マニア Maniac', color: '#fb923c' },
  { min: 50, name: '師範 Sensei', color: '#f472b6' },
  { min: 100, name: '漫画家 Mangaka', color: '#fbbf24' },
];

export function getLevel(chaptersRead: number): LevelInfo {
  let level = LEVELS[0];
  for (const l of LEVELS) if (chaptersRead >= l.min) level = l;
  const next = LEVELS[LEVELS.indexOf(level) + 1];
  const progress = next
    ? ((chaptersRead - level.min) / (next.min - level.min)) * 100
    : 100;
  return { ...level, progress: Math.min(Math.max(progress, 0), 100), nextMin: next?.min ?? null };
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  emoji: string;
  earned: boolean;
}

export function computeAchievements(stats: ProfileStats, hasPass: boolean): Achievement[] {
  return [
    { id: 'first-read', name: '初読み First Read', desc: 'Read your first chapter', emoji: '📖', earned: stats.chaptersRead >= 1 },
    { id: 'bookworm', name: '本の虫 Bookworm', desc: 'Read 10+ chapters', emoji: '📚', earned: stats.chaptersRead >= 10 },
    { id: 'social', name: '社交的 Social', desc: 'Post your first comment', emoji: '💬', earned: stats.commentsPosted >= 1 },
    { id: 'popular', name: '人気者 Popular', desc: 'Receive 5+ reactions', emoji: '✨', earned: stats.reactionsReceived >= 5 },
    { id: 'collector', name: '収集家 Collector', desc: 'Add 5+ favorites', emoji: '💎', earned: stats.favoritesCount >= 5 },
    { id: 'pass-holder', name: '桜メンバー Sakura Member', desc: 'Own a Monthly Pass', emoji: '🌸', earned: hasPass },
    { id: 'otaku', name: 'オタク Otaku', desc: 'Read 15+ chapters', emoji: '⭐', earned: stats.chaptersRead >= 15 },
    { id: 'chatterbox', name: 'おしゃべり Chatterbox', desc: 'Post 10+ comments', emoji: '🎙️', earned: stats.commentsPosted >= 10 },
  ];
}

const EMPTY_STATS: ProfileStats = {
  chaptersRead: 0,
  commentsPosted: 0,
  reactionsReceived: 0,
  favoritesCount: 0,
  memberSince: null,
};

export async function getPublicProfile(walletAddress: string): Promise<{
  profile: PublicProfile | null;
  favorites: ProfileFavorite[];
  stats: ProfileStats;
}> {
  if (!walletAddress) return { profile: null, favorites: [], stats: EMPTY_STATS };

  const [{ data: profileRow }, { data: usernameRow }] = await Promise.all([
    supabase
      .from('user_profiles')
      .select(
        'wallet_address, display_name, bio, avatar_seed, avatar_url, avatar_mint_address, created_at, creator_verification_state, follower_count',
      )
      .eq('wallet_address', walletAddress)
      .maybeSingle(),
    supabase
      .from('sakura_usernames')
      .select('username, display_name')
      .eq('wallet_address', walletAddress)
      .maybeSingle(),
  ]);

  const profile: PublicProfile | null = profileRow
    ? {
        wallet_address: profileRow.wallet_address,
        display_name: profileRow.display_name ?? usernameRow?.display_name ?? null,
        username: usernameRow?.username ?? null,
        bio: profileRow.bio ?? null,
        avatar_seed: profileRow.avatar_seed ?? walletAddress.slice(0, 8),
        avatar_url: profileRow.avatar_url ?? null,
        avatar_mint_address: profileRow.avatar_mint_address ?? null,
        creator_verification_state: profileRow.creator_verification_state ?? null,
        follower_count: profileRow.follower_count ?? 0,
        created_at: profileRow.created_at ?? null,
      }
    : usernameRow
      ? {
          wallet_address: walletAddress,
          display_name: usernameRow.display_name ?? null,
          username: usernameRow.username ?? null,
          bio: null,
          avatar_seed: walletAddress.slice(0, 8),
          avatar_url: null,
          avatar_mint_address: null,
          creator_verification_state: null,
          follower_count: 0,
          created_at: null,
        }
      : null;

  const stats: ProfileStats = { ...EMPTY_STATS, memberSince: profile?.created_at ?? null };
  let favorites: ProfileFavorite[] = [];

  try {
    const { data: favData } = await supabase
      .from('favorites')
      .select(PROFILE_FAVORITES_SELECT)
      .eq('wallet_address', walletAddress)
      .order('created_at', { ascending: false })
      .limit(20);
    favorites = toProfileFavorites(favData);
    // Count what the shelf shows, so a dropped row cannot earn the Collector
    // achievement the visitor has no way to see.
    stats.favoritesCount = favorites.length;

    const { count: chapCount } = await supabase
      .from('reading_history')
      .select('*', { count: 'exact', head: true })
      .eq('wallet_address', walletAddress);
    stats.chaptersRead = chapCount ?? 0;

    const { count: commentCount } = await supabase
      .from('chapter_comments')
      .select('*', { count: 'exact', head: true })
      .eq('wallet_address', walletAddress);
    stats.commentsPosted = commentCount ?? 0;

    const { data: userComments } = await supabase
      .from('chapter_comments')
      .select('id')
      .eq('wallet_address', walletAddress);
    if (userComments && userComments.length) {
      const ids = userComments.map((c: { id: number }) => c.id);
      const { count: rxCount } = await supabase
        .from('comment_reactions')
        .select('*', { count: 'exact', head: true })
        .in('comment_id', ids);
      stats.reactionsReceived = rxCount ?? 0;
    }
  } catch {
    // Best-effort stats; return whatever we managed to gather.
  }

  return { profile, favorites, stats };
}

export function truncateAddress(addr: string): string {
  return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '';
}
